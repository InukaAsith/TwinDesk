// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process: lifecycle, windows, tray, IPC and the state pushed to the main window.
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification, shell } = require('electron');
const { Updates } = require('../shared/updates.js');
const { aboutInfo } = require('../shared/about.js');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const P = require('../shared/protocol.js');
const store = require('./store');
const { Discovery, interfaces, isIPv4, ipToInt } = require('./discovery');
const Link = require('./link');
const Peer = require('./peer');
const { Server } = require('./server');
const { Pairing: HostPairing } = require('./hostpair');
const identity = require('./identity');
const Screen = require('./screen');
const Clip = require('./clip');
const setupIpc = require('./ipc');
const Helper = require('./helper');
const Kvm = require('./kvm');
const firewall = require('./firewall');
const Terminal = require('./terminal');
const FileDrop = require('./filedrop');
const Smb = require('./smb');
const Apps = require('./apps');
const Sound = require('./sound');
const FileRecv = require('./filerecv');
const DragRecv = require('./dragrecv');
const Sshd = require('./sshd');
const PcScreen = require('./pcscreen');
const PcApps = require('./pcapps');
const PeerApps = require('./peerapps');
const Sender = require('./sender');
const Vdd = require('./vdd');
const Hud = require('./hud');
const Notifs = require('./notifs');
const FileClip = require('./fclip');
const Wake = require('./wake');
const SendTo = require('./sendto');
const { PairSync } = require('./pairsync');
const { PhoneLink } = require('./phone-link');
const { Wired } = require('./wired');
const { PhoneDrive } = require('./phonedrive');
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { PhoneViews } = require('./phoneview');
const { PhoneShots } = require('./phone-shots');
const { BleHost, BleGuest, BlePhones } = require('../shared/blepipe.js');
const { wifiQuiet } = require('../shared/blepolicy.js');
const { NetLink } = require('../shared/netlink.js');
const { Wifi } = require('./wifi');
const { normalize, apply: applySettings } = require('./settings');

// Packaged: electron-builder's appId is the shortcut's AppUserModelID. In development Windows
// only shows toasts for an id it knows, and electron.exe's path works.
const AUMID = app.isPackaged ? 'org.macshare.windows' : process.execPath;

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Every sent video frame says "show me now" (RTP playout delay 0/0), the lowest latency
// whatever the viewer app does; a viewer in "Smooth" playback adds its own small buffer on top
// (jitterBufferTarget). FlexFEC repairs lost packets without a resend round trip; it costs bandwidth
// only while packets are lost. The Mac sets the same trials.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/');
// Renamed MacShare → TwinDesk: settings, pairing and keys stay in the folder they've always been
// in (Electron would follow the new product name). A dev copy's --user-data-dir still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'MacShare'));
// Multi-device switched on (multi.js, docs/multi-device.md): mesh/main.js runs instead of everything below.
if (require('./multi').on()) return void require('./mesh/main.js');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null); // its accelerators would steal keys meant for the Mac
  app.setAppUserModelId(AUMID); // toasts need it; the installer's shortcut carries the same id
  // A pinned Mac app starts "TwinDesk.exe --mac-app=<id>": open it, else show the window.
  app.on('second-instance', (_e, argv) => {
    if (sendTo && sendTo.handle(argv)) return; // Explorer › Send to
    if (!openMacAppArg(argv) && !openPhoneAppArg(argv)) showMain();
  });
  app.whenReady().then(start);
}

let mainWin = null;
let tray = null;
let trayKey = '';
let trayLight = false; // the taskbar is light: black tray glyph
let hud = null;
let about = null; // shared/about.js, read once for the About page
let quitting = false;
let discovery = null;
let link = null;
let settings = null;
let device = null;
let screen = null;
let clip = null;
let helper = null;
let terminal = null;
let fileDrop = null;
let smb = null;
let apps = null;
let sound = null;
let pcScreen = null;
let pcApps = null;
let peerApps = null; // The other PC's apps here
let vdd = null;
let wake = null;
let updates = null;
let updateNote = null; // the update notification, kept so it isn't collected before a click
let sendTo = null;
let pairSync = null;
let fileRecv = null;
let notifs = null;
let fileClip = null;
let sshd = null;
let kvm = null;
let wired = null; // wired.js, with the phone
let hostServer = null; // server.js, once the certificate exists
let phone = null; // A phone as the peer: phone.js (its .bridge: phone-bridge.js)
let phoneViews = null; // its screen and apps in windows here (phoneview.js)
let phoneDrive = null; // its storage as a drive here (phonedrive.js)
let phoneShots = null; // screenshots both ways with it, onto the other clipboard (phone-shots.js)
let bleHost = null; // Bluetooth, for devices not on this network: we host (blepipe.js)
let bleGuest = null; // … we connect to a host
let blePhones = null; // phones that advertise: we connect to them (a PC's Bluetooth often can't advertise)
let bleOff = false; // General's Turn off Bluetooth on Wi-Fi connections, in effect (bleQuiet)
const bleQuiet = wifiQuiet();
let net = null; // Wi-Fi for a session through Bluetooth (netlink.js)
let wifi = null; // this PC's Wi-Fi for it: hosting, joining (wifi.js)
let lastMode = 'home';
let fw = { checking: true, ok: null, message: 'Checking…' }; // firewall self-check
// Started at sign-in (tray only), or by a pinned Mac app's shortcut (that app only).
const startHidden = process.argv.includes('--hidden') || process.argv.some((a) => a.startsWith('--mac-app=') || a.startsWith('--phone-app='));
let pendingMacApp = null; // {id, until}: opened once the Mac connects (2 min)
let lastPairPhase = null;

function loadDevice() {
  let d = store.read('device.json', null);
  if (!d || typeof d.id !== 'string') {
    d = { id: crypto.randomUUID() };
    store.write('device.json', d);
  }
  return { id: d.id, name: os.hostname() };
}

function start() {
  device = loadDevice();
  settings = normalize(store.read('settings.json', {}));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
  discovery.on('invite', (d) => {
    // Connect on this computer in our host's list: back to it, taking the session over.
    if (guest.pairing && d && d.id === guest.pairing.macId) return void (discovery.clearInvite(d.id), guest.connect(true));
    pushState();
    showMain();
  }); // a Mac wants to connect: Pair is focused
  discovery.start();

  // link = the peer layer (peer.js): guest of a Mac or another computer, or host of a PC/Linux.
  // Every feature below talks to it as it talked to link.js.
  const guest = new Link({
    device,
    blocked: () => link.hosting || !!(hostServer && hostServer.phoneHolds()), // a phone keeps it while it may come back
    store: {
      load: () => {
        const p = store.read('pairing.json', null);
        return p && p.macId && p.token && p.fp && p.address ? p : null;
      },
      save: (p) => store.write('pairing.json', p),
      clear: () => store.remove('pairing.json'),
    },
    resolveAddress: (macId) => discovery.get(macId),
  });
  link = new Peer(guest);
  startHost(guest);
  link.onState(() => {
    discovery.wantProbes = link.snapshot().link.state !== 'connected'; // probe every 10 s only while not connected
    pushState();
  });
  clip = new Clip(link, () => settings.clipboard, pushState);
  screen = new Screen({
    link,
    clip,
    inputAllowed: () => !kvm || kvm.mode === 'home', // no Monitor 2 input while driving or driven
    settings,
    saveSettings,
    onChange: pushState,
    isQuitting: () => quitting,
  });
  terminal = new Terminal({ link, settings, onChange: pushState });
  sshd = new Sshd({ link, settings, save: saveSettings, onChange: pushState });
  fileDrop = new FileDrop({ link, settings, onProgress: (v) => { screen.sendDropProgress(fillAll(v)); pushState(); } });
  screen.fileDrop = fileDrop;
  apps = new Apps({ link, allowed: () => settings.macApps.on, getMonitor: () => screen.win, popup: (kind, text) => hud && hud.show(kind, text), peerName, onChange: pushState, onWatch: () => screen.policy() });
  screen.apps = apps;
  sound = new Sound({ link, settings, onChange: pushState });
  smb = new Smb({ link, settings, save: saveSettings, onChange: pushState });
  helper = new Helper();
  fileRecv = new FileRecv({ link, helper, settings, onChange: pushState });
  const dragRecv = new DragRecv({ link, helper, settings, isDriven: () => kvm && kvm.mode === 'driven', onChange: pushState });
  kvm = new Kvm({ link, helper, clip, fileDrop, fileRecv, dragRecv, settings, save: saveSettings, onChange: onKvmChange });
  hud = new Hud(() => settings);
  const hudShow = hud.show.bind(hud);
  hud.show = (kind, text, sub) => hudShow(kind, fillNames(text), fillNames(sub || '')); // device names in popups
  // Cursor sharing switched on/off (hotkey double-tap, tray, or the other computer): the big card.
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  kvm.onLinked = (on, here, ble) => {
    const p = peerView();
    const name = link.snapshot().link.state === 'connected' && p ? p.name : '';
    const key = P.hotkeyName(settings.keys.hotkey, 'win');
    const sub = !here && name ? 'Turned ' + (on ? 'on' : 'off') + ' on ' + name
      : on ? (name ? 'With ' + name + '. ' : '') + 'Double-tap ' + key + ' to turn it off'
        : (ble ? 'It comes back on Wi-Fi. ' : '') + 'Double-tap ' + key + ' to turn it on';
    hud.show(on ? 'linkOn' : 'linkOff', 'Cursor sharing ' + (on ? 'on' : 'off') + (!on && ble ? ' over Bluetooth' : ''), sub);
  };
  kvm.onWhere = (mode) => { // the switching popup
    const name = peerName();
    if (mode === 'driving') hud.show('away', (kvm.keyboardOnly ? 'Typing on ' : 'Using ') + name);
    else if (mode === 'driven') hud.show('driven', name + ' is using {me}');
    else hud.show('home', 'Back on {me}');
  };
  vdd = new Vdd({ helper, onChange: pushState });
  // Notifications both ways, Send files, copy/paste files with shortcuts
  notifs = new Notifs({ link, helper, settings, save: saveSettings, selfIds: [AUMID, 'org.macshare.windows'], peerName, onChange: pushState });
  fileClip = new FileClip({ link, helper, fileDrop, fileRecv, dragRecv, settings, peerName, popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  // A paste Windows copies itself (dragrecv.js) — its files skip filerecv.js.
  fileRecv.claims = (m) => dragRecv._pasteOf(m);
  dragRecv.onPasted = (b) => fileClip.pasted(b);
  kvm.fileClip = fileClip; // Our copy/paste shortcut while driving → fclip.key
  sendTo = new SendTo({ link, fileDrop, peerName: () => (peerView() || {}).name || '', popup: (kind, text, sub) => hud.show(kind, text, sub) });
  // Copy/paste and Send files show progress in the popup, like a drag. Receiving: every
  // batch that takes longer than a moment; sending: batches over 5 MB.
  const pct = (n, total) => Math.min(99, Math.floor((n / total) * 100));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  let lastPopup = 0;
  const progressPopup = (kind, text, done) => {
    const now = Date.now();
    if (!done && now - lastPopup < 250) return;
    lastPopup = now;
    hud.show(kind, text);
  };
  // …and in a notification with a live progress bar (the helper's Toast.cs), one each way.
  const live = { recv: 0, send: 0 }; // when each toast was last updated (0: none showing)
  const liveToast = (tag, title, got, total) => {
    if (Date.now() - live[tag] < 500) return;
    live[tag] = Date.now();
    helper.send('toastProgress', { aumid: AUMID, tag, title, status: peerName(), value: total ? got / total : -1, label: total ? pct(got, total) + ' %' : '' });
  };
  const liveDone = (tag, title, text) => {
    if (!live[tag]) return;
    live[tag] = 0;
    helper.send('toastDone', { aumid: AUMID, tag, title, text });
  };
  fileRecv.onBatchProgress = (b) => {
    if (Date.now() - b.at < 400) return; // small batches: only the "Pasted" / "Received" popup
    const part = b.total ? pct(b.got, b.total) : pct(b.done, b.count);
    const what = (b.kind === 'paste' ? 'Pasting ' : 'Receiving ') + plural(b.count, 'file') + ' from ' + peerName();
    progressPopup('driven', what + ' · ' + part + ' %');
    liveToast('recv', what, b.total ? b.got : b.done, b.total || b.count);
  };
  fileDrop.onBatchProgress = (b) => {
    if (!(b.bytes > 5 * 1024 * 1024)) return;
    if (b.done) {
      liveDone('send', b.ok ? 'Sent ' + b.name : 'Not everything arrived', b.ok ? 'On ' + peerName() : 'On ' + peerName() + ': some files didn’t make it');
      return progressPopup('away', b.ok ? 'Sent ' + b.name + ' to ' + peerName() : 'Not everything arrived on ' + peerName(), true);
    }
    progressPopup('away', 'Sending ' + b.name + ' to ' + peerName() + ' · ' + pct(b.sent, b.bytes) + ' %');
    liveToast('send', 'Sending ' + b.name, b.sent, b.bytes);
  };
  link.on('closed', () => {
    liveDone('recv', 'Files stopped', peerName() + ' disconnected');
    liveDone('send', 'Files stopped', peerName() + ' disconnected');
  });
  fileRecv.onBatch = (b) => {
    liveDone('recv', b.files ? 'Received ' + plural(b.files, 'file') : 'Nothing arrived', b.files ? 'From ' + peerName() : '');
    if (b.kind === 'paste') fileClip.pasted(b);
    else if (b.files) hud.show('driven', 'Received ' + b.files + ' file' + (b.files === 1 ? '' : 's') + ' from ' + peerName());
  };
  wake = new Wake({ link, settings, save: saveSettings, onChange: pushState, address: () => ownAddresses()[0] }); // Wake over the network
  const sender = new Sender(link); // every rtc2 video session we send (screen, app windows)
  pcScreen = new PcScreen({ link, helper, sender, vdd, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  pcApps = new PcApps({ link, helper, sender, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  peerApps = new PeerApps({ link, settings, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState });
  helper.on('exit', pushState);
  setupNet(guest);
  helper.start();
  helper.once('ready', () => vdd.check()); // switches a virtual monitor left on by a crash off
  // New releases on GitHub: a notification once per version, the tray item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'win', getSettings: () => settings, save: saveSettings, onChange: pushState,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      updateNote = new Notification({ title, body });
      updateNote.on('click', onClick);
      updateNote.show();
    },
  });
  updates.start();
  const ipc = setupIpc({ link, discovery, screen, clip, kvm, terminal, sshd, fileDrop, smb, apps, sound, pcScreen, pcApps, peerApps, vdd, notifs, fileClip, wake, updates, settings, save: saveSettings, push: pushState, buildState,
    get phone() { return phone; }, get phoneViews() { return phoneViews; }, get phoneDrive() { return phoneDrive; }, connectPhoneDev, cancelPhoneInvite, hub: loadHub,
    get net() { return net; }, applyNet, joinHotspot,
    checkFirewall, fixFirewall, setStartup, onApp: updateTray });
  pairSync = new PairSync({ link, settings, save: saveSettings, set: ipc.set }); // Two-way switches per pair
  nativeTheme.on('updated', () => { checkTaskbar(); pushState(); });
  link.start();

  link.on('welcome', () => { // a pinned Mac app started while the Mac wasn't connected
    if (pendingMacApp && Date.now() < pendingMacApp.until) openMacApp(pendingMacApp.id);
    pendingMacApp = null;
  });
  createTray();
  createMainWindow();
  if (!sendTo.handle(process.argv) && !openMacAppArg(process.argv)) openPhoneAppArg(process.argv);
  setTimeout(checkFirewall, 3000);
  if (process.argv.includes('--test-monitor')) screen.open(true); // dev: ?test=1 pattern
}

// Host role: our own server, once the certificate exists (made on first start).
async function startHost(guest) {
  try {
    const id = await identity.load();
    discovery.self.fp = id.fp; // beacons carry it now
    const server = new Server(id);
    discovery.self.port = server.port;
    // A phone's hello takes the session: the computer we're a guest of is dropped (yieldTo).
    const pairing = new HostPairing(server, { id: device.id, name: device.name, fp: id.fp }, { busy: () => guest.authed, yieldTo: () => guest.yieldSession() });
    pairing.on('request', showMain); // a code to compare: bring the window up
    link.attachHost(server, pairing);
    hostServer = server;
    bleHost = new BleHost({
      helper, server,
      info: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.WIN, port: server.port, fp: id.fp }),
      enabled: () => !bleOff && (settings.net.ble || settings.net.blePc),
      accept: (g) => (g.os === P.OS.ANDROID ? settings.net.ble : settings.net.blePc), // General's two Bluetooth switches
    });
    bleHost.on('change', pushState);
    discovery.extras.unshift(bleHost);
    blePhones = new BlePhones({ helper, server, hello: bleHost.info });
    blePhones.on('change', pushState);
    discovery.extras.push(blePhones);
    server.on('phoneFree', () => { guest.poke(); pushState(); });
    startPhone(server, pairing);
  } catch (e) {
    console.error('[host]', e.message);
    link.host = { on: false, error: 'No certificate: ' + e.message };
    pushState();
  }
}

// A phone as the peer (port of the Mac's): the sidebar tile and Phone page (phone.js), its screen,
// touch, mouse, keyboard and clipboard through wireless debugging (phone-bridge.js), and its
// screen and apps in windows here (phoneview.js).
function startPhone(server, pairing) {
  const pl = new PhoneLink(link, server);
  phone = new Phone({ server: pl, raw: server, discovery, pairing });
  setupHub(pl);
  phone.on('change', pushState);
  // The phone's Keyboard page names this PC's hotkey (double-tap = everything back here).
  pl.on('client', (ctx) => ctx.os === P.OS.ANDROID && pl.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_WIN, 'win') }));
  phone.bridge = new PhoneBridge({ server: pl, phone, getSettings: () => settings, clipboard: clip });
  phone.bridge.on('save', saveSettings);
  // A phone on a USB cable: pairing, the session, screen and sound through it (no Wi-Fi needed).
  wired = new Wired({ adb: phone.bridge.adb, raw: server, peer: pl, getId: () => device.id, getName: () => device.name });
  pairing.isWired = (nonce) => wired.knows(nonce);
  wired.on('change', pushState);
  phone.bridge.wired = wired;
  phone.wired = wired;
  phoneDrive = new PhoneDrive({ adb: phone.bridge.adb, bridge: phone.bridge, phone });
  phoneDrive.on('change', pushState);
  // Screenshots both ways, onto the other clipboard (Clipboard › Screenshots go to / Also save).
  phoneShots = new PhoneShots({ server: pl, clip, getSettings: () => settings, popup: (kind, text) => hud.show(kind, text) });
  phone.bridge.on('change', () => {
    pushState();
    if (pendingView && phone.bridge.serial) {
      const v = pendingView;
      pendingView = null;
      if (Date.now() < v.until) v.kind === 'app' ? phoneViews.openApp(v.app, v.title) : phoneViews.openScreen();
    }
    if (pendingPhoneApp && phone.bridge.state === 'ready') {
      const p = pendingPhoneApp;
      pendingPhoneApp = null;
      if (Date.now() < p.until) openPhoneApp(p.pkg);
    }
  });
  phone.bridge.on('popup', (kind, text) => hud.show(kind, text));
  phoneViews = new PhoneViews({ bridge: phone.bridge, phone, getSettings: () => settings, server: pl, fileSend: fileDrop });
  phoneViews.on('change', pushState);
  viaWifi(phoneViews, 'openScreen', 'phone');
  viaWifi(phoneViews, 'openApp', 'phone');
  // On Wi-Fi after Bluetooth, wireless debugging takes a moment more: the window opens once it's up.
  phoneViews.onNoAdb = (v) => {
    const c = pl.current;
    if (!c || c.os !== P.OS.ANDROID || !(c.transport === 'ble' || net.linked)) return false;
    pendingView = { ...v, until: Date.now() + 60 * 1000 };
    if (net.onBle) net.need('phone').then((ok) => !ok && (pendingView = null));
    else hud.show('home', 'Opening it when wireless debugging is ready…');
    return true;
  };
  // A phone notification clicked here: its app in a window.
  notifs.onClick = (m) => pl.current && pl.current.os === P.OS.ANDROID && phoneViews.openNotified(m.app, m.appName);
  phoneViews.on('focus', () => kvm.applyConfig());
  kvm.local = phone.bridge; // driving a phone goes through adb
  kvm.blockEdge = () => phoneViews.focused; // moving inside the phone window never crosses
  pushState();
}

// Calls, Messages, Photos and Files from a phone (shared/phonehub.js): loaded when a phone connects with
// one of them on, or the first time a page uses it. Before that none of it exists: no module, no
// listener, nothing sent to the phone. The call window (shared/callwin.js) only with a call.
let hub = null;
let phoneLink = null; // phone-link.js, the phone's session (startPhone)
let callwin = null;
function setupHub(pl) {
  phoneLink = pl;
  const anyOn = () => settings.hub.calls || settings.hub.messages || settings.hub.media || settings.hub.files || settings.hub.shareServe;
  pl.on('client', (ctx) => ctx.os === P.OS.ANDROID && !hub && anyOn() && loadHub());
  // The phone shares a folder: loaded for it (its listener comes with it, so this one passes it on).
  pl.on(`t:${P.T.SHARE_OFFER}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !hub && loadHub().share && hub.share.onOffer(m));
  pl.on(`t:${P.T.SHARE_SET}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !hub && loadHub().share && hub.share.act('serve', { on: !!m.serve }));
}

function loadHub() {
  if (hub || !phoneLink) return hub || { act() {} };
  const { PhoneHub } = require('../shared/phonehub.js');
  hub = new PhoneHub({
    server: phoneLink, getSettings: () => settings, save: saveSettings,
    audio: (opts) => require('./callaudio.js').create({ helper, ...opts }), // the calls' sound over Bluetooth
    audioLimit: require('./callaudio.js').LIMIT,
    btSettings: () => shell.openExternal('ms-settings:bluetooth').catch(() => {}), // pairing the phone for the calls' sound
    send: (paths, batch) => !!(fileDrop && fileDrop.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
    choose: () => require('electron').dialog.showOpenDialog(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, { properties: ['openFile', 'multiSelections'] }) // files only: with folders too it picks only folders here
      .then((r) => (r.canceled ? [] : r.filePaths)),
    share: { // shared folders with the phone (shared/foldershare.js)
      mounter: require('./phonedrive').mounter, adb: phone && phone.bridge.adb, serialOf: (id) => wired && wired.serialOf(id),
      chooseFolder: () => require('electron').dialog.showOpenDialog(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, { properties: ['openDirectory', 'createDirectory'] }).then((r) => (r.canceled ? '' : r.filePaths[0])),
      defaultFolder: path.join(os.homedir(), 'MacShare'),
      tls: () => hostServer && hostServer.tls, // served with the session's certificate, which the phone pinned
      wifi: (on) => (!net ? Promise.resolve(false) : on ? net.need('folder') : Promise.resolve(net.release('folder'))), // through Bluetooth
    },
  });
  hub.on('change', pushState);
  hub.on('data', (m) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send('hub', m));
  const popup = () => {
    if (!callwin && !hub.call) return;
    callwin = callwin || require('../shared/callwin.js');
    callwin.update(hub, { corner: 'bottom', open: goTab });
  };
  hub.on('call', popup);
  hub.on('change', popup);
  if (phoneLink.current && phoneLink.current.os === P.OS.ANDROID) hub.started();
  return hub;
}

// ---- not on the same network: Bluetooth, and Wi-Fi when it's needed ----

// The session through Bluetooth (blepipe.js) when the other device isn't on this network; files
// and screens move it onto a Wi-Fi network one side hosts (netlink.js). This PC hosts with Wi-Fi
// Direct (it keeps its own Wi-Fi) or joins the other side's (wifi.js). Nothing here runs with a
// device that doesn't know about it: those never come through Bluetooth. netsh refusing to join
// for want of Location opens its settings, once a run (the status says what to switch on).
function setupNet(guest) {
  bleGuest = new BleGuest({ helper, hello: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.WIN }) });
  bleGuest.on('change', pushState);
  bleGuest.on('invite', () => { pushState(); showMain(); });
  guest.ble = bleGuest;
  discovery.extras.push(bleGuest);
  let locationShown = false;
  wifi = new Wifi(helper, () => {
    if (!locationShown) shell.openExternal('ms-settings:privacy-location').catch(() => {});
    locationShown = true;
  });
  // What this PC can do (a Wi-Fi adapter plugged in, Wi-Fi Direct): the other side hears when it changes.
  const recheck = () => wifi.refresh().then((changed) => changed && net.caps(), () => {});
  helper.on('ready', () => {
    applyNet();
    recheck();
  });
  net = new NetLink({
    os: P.OS.WIN,
    send: (m) => link.sendNow(m),
    current: () => link.current,
    host: { can: () => wifi.canHost(), start: (ssid, pass) => wifi.host(ssid, pass), stop: () => wifi.unhost() },
    join: { can: () => wifi.can(), start: (ssid, pass) => wifi.join(ssid, pass), stop: () => wifi.leave() },
    // Connect with hotspot (a phone): it switches its hotspot on, this PC joins it (the Overview asks
    // for its name and password once; joinHotspot).
    hotspot: (why, peerOs) => peerOs === P.OS.ANDROID && why === 'hotspot',
    cable: () => {
      const c = link.current;
      return !!c && c.os === P.OS.ANDROID && !!wired && wired.toCable(c.deviceId);
    },
  });
  net.on('change', pushState);
  net.on('dropped', () => pcScreen.mode !== 'off' && pcScreen.setMode('off')); // Back to Bluetooth on the phone: it can't carry the screen
  link.hold = (m) => net.holdOut(m, (x) => link.sendNow(x));
  link.tap = (m) => net.onMessage(m);
  link.on('welcome', () => {
    net.started();
    recheck();
  });
  link.on('closed', () => net.ended());
  link.on('transport', () => {
    pushState();
    screen.policy();
    if (!net.onBle && settings.files.mountMac && smb.mac && !smb.drive) smbMount(); // on Wi-Fi now: the folder too
  });
  // The other computer's folder through Bluetooth: not mapped there (its address is the pipe's);
  // Open moves the session onto Wi-Fi Direct and maps it then, kept up while it's mapped.
  const smbMount = smb.mount.bind(smb);
  let smbWait = false;
  smb.canWifi = () => net.onBle;
  smb.mount = () => {
    if (!net.onBle) return smbMount();
    smb.mountMessage = '';
    smb.onChange();
    return Promise.resolve();
  };
  smb.openOverWifi = () => {
    if (smbWait) return;
    smbWait = true;
    waitWifi('smb', () => smbMount().then(() => {
      smbWait = false;
      if (smb.drive) shell.openPath(smb.drive + '\\');
    }), () => { smbWait = false; });
  };
  // Screens wait for Wi-Fi (WebRTC over Bluetooth would never work); each lets go when it closes.
  const policy = screen.policy.bind(screen);
  let screenWait = false;
  screen.policy = () => {
    if (!net.onBle || !screen.watching()) return policy();
    if (screenWait) return;
    screenWait = true;
    waitWifi('screen', () => { screenWait = false; policy(); }, () => { screenWait = false; });
  };
  const setMode = pcScreen.setMode.bind(pcScreen);
  pcScreen.setMode = (mode) => (mode !== 'off' && net.onBle ? waitWifi('share', () => setMode(mode)) : setMode(mode));
  viaWifi(peerApps, 'launch', 'apps');
  viaWifi(apps, 'launch', 'apps');
  setInterval(() => {
    if (!screen.watching()) net.release('screen');
    if (pcScreen.mode === 'off') net.release('share');
    if (!peerApps.view().open && !screen.watching()) net.release('apps');
    if (phoneViews && !phoneViews.list().length && !pendingView) net.release('phone');
    if (!smb.drive && !smbWait) net.release('smb');
    applyQuiet(bleQuiet({ on: settings.net.bleWifiOff, current: () => link.current, onGroup: () => net.onGroup }));
    const near = link.snapshot().link.state !== 'connected' && !link.hosting && !bleOff;
    bleGuest.scan(near && settings.net.blePc); // looking for a host only while there's no session
    if (blePhones) blePhones.scan(near && settings.net.ble); // … and for phones
  }, 2000);
}

// The session on the same Wi-Fi a while (General's Turn off Bluetooth on Wi-Fi connections,
// blepolicy.js wifiQuiet): no advertising, scanning or links, its Bluetooth fallback closed with
// them; back as it was when the session ends.
function applyQuiet(off) {
  if (off !== bleOff) {
    bleOff = off;
    console.log(`[ble] ${off ? 'off: the session is on the same Wi-Fi' : 'on again'}`);
    if (bleHost) bleHost.apply();
    pushState();
  }
  if (!off) return;
  if (bleGuest) bleGuest.drop();
  if (blePhones) blePhones.stop();
}

// Bluetooth on or off (General), or the helper restarted.
function applyNet() {
  if (!settings.net.bleWifiOff) applyQuiet(false);
  if (bleHost) bleHost.apply();
  if (bleGuest && !settings.net.blePc) bleGuest.scan(false);
  if (blePhones && !settings.net.ble) blePhones.stop();
  pushState();
}

// The phone's saved hotspot, for the Overview's form.
function hotspotView() {
  const c = link.current;
  const h = c && settings.net.hotspots[c.deviceId];
  return { hotspotSsid: h ? h.ssid : '', hotspotSaved: !!(h && h.pass) };
}

// The phone's hotspot is on: join it, remembered for that phone (the password field empty = the saved one).
function joinHotspot(arg) {
  const { safeStorage } = require('electron');
  const c = link.current;
  const ssid = String((arg && arg.ssid) || '').trim().slice(0, 32);
  let pass = String((arg && arg.pass) || '').slice(0, 63);
  if (!ssid || !c || !net) return;
  const saved = settings.net.hotspots[c.deviceId];
  if (!pass && saved && saved.ssid === ssid && saved.pass) {
    try { pass = safeStorage.decryptString(Buffer.from(saved.pass, 'base64')); } catch (_) { /* another user's, or DPAPI gone */ }
  }
  const sealed = pass && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(pass).toString('base64') : '';
  settings.net.hotspots[c.deviceId] = { ssid, pass: sealed };
  saveSettings();
  net.joinHotspot(ssid, pass);
}

// fn once the session is on Wi-Fi (now, if it isn't on Bluetooth); a popup if it can't be.
function waitWifi(why, fn, failed) {
  if (!net || (!net.onBle && !net.linked)) return fn();
  if (!net.onBle) return void net.need(why).then(fn); // on a link made for something else: kept up for this too
  hud.show('home', 'Moving to Wi-Fi with {name}…');
  net.need(why).then((ok) => {
    if (ok) return fn();
    hud.show('home', net.error || 'Wi-Fi with {name} didn’t come up');
    if (failed) failed();
  });
}

// obj[method] waits for Wi-Fi first.
function viaWifi(obj, method, why) {
  const orig = obj[method].bind(obj);
  obj[method] = (...args) => waitWifi(why, () => orig(...args));
}

// A phone found nearby: a paired one is asked to connect, any other to pair with this PC (the
// popup says Pair has to be pressed on it, until it starts pairing or a minute went by).
let phoneInvite = null; // {id, name, until}
function connectPhoneDev(d) {
  discovery.clearInvite(d.id);
  const paired = phone && link.pairing && link.pairing.list().some((p) => p.id === d.id);
  if (!paired) {
    phoneInvite = { id: d.id, name: d.name, until: Date.now() + 60 * 1000 };
    setTimeout(pushState, 61 * 1000);
    pushState();
  }
  if (String(d.address).startsWith('ble:')) return discovery.invite(d.address); // near over Bluetooth only (BlePhones)
  if (paired) phone.connect(d.id);
  else discovery.invite(d.address);
}
function phoneInviteView(s) {
  if (phoneInvite && (Date.now() > phoneInvite.until || s.pairing || (s.peer && s.peer.id === phoneInvite.id))) phoneInvite = null;
  return phoneInvite && { name: phoneInvite.name };
}
function cancelPhoneInvite() {
  phoneInvite = null;
  pushState();
}

// ---- pinned Mac apps ----

function openMacAppArg(argv) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--mac-app='));
  if (!arg) return false;
  const id = arg.slice('--mac-app='.length).slice(0, 1024);
  if (id) openMacApp(id);
  return true;
}

// A pinned phone app starts "TwinDesk.exe --phone-app=<package>": open it once the phone's
// wireless debugging is ready (connecting a paired phone nearby first, if none is connected).
let pendingPhoneApp = null; // {pkg, until}
let pendingView = null; // a phone window waiting for wireless debugging (phoneViews.onNoAdb)
function openPhoneAppArg(argv) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--phone-app='));
  if (!arg) return false;
  const pkg = arg.slice('--phone-app='.length);
  if (/^[\w.]{1,200}$/.test(pkg)) openPhoneApp(pkg);
  return true;
}

function openPhoneApp(pkg) {
  if (phone && phoneViews && phone.connected && (phone.bridge.state === 'ready' || (net && net.onBle))) return phoneViews.openApp(pkg, (phone.apps.find((a) => a.id === pkg) || {}).name);
  const first = !pendingPhoneApp;
  pendingPhoneApp = { pkg, until: (pendingPhoneApp && pendingPhoneApp.until) || Date.now() + 2 * 60 * 1000 };
  if (first && hud) hud.show('home', 'Opening it when the phone is ready…');
  // Until then, every 2 s: the phone may not be up (TwinDesk just started) or nearby yet.
  clearTimeout(openPhoneApp.timer);
  if (Date.now() > pendingPhoneApp.until) return (pendingPhoneApp = null);
  if (phone && !phone.connected && !phone.connecting) {
    const near = phone.nearby()[0];
    if (near) phone.connect(near.id);
  }
  openPhoneApp.timer = setTimeout(() => pendingPhoneApp && openPhoneApp(pendingPhoneApp.pkg), 2000);
}

function openMacApp(id) {
  if (link.snapshot().link.state === 'connected' && link.peerOs === P.OS.MAC) {
    apps.launch(id);
    screen.ensureHidden(); // the app windows come from the Mac's screen stream
  } else {
    pendingMacApp = { id, until: Date.now() + 2 * 60 * 1000 };
    if (hud) hud.show('home', 'Opening it when {name} connects…');
  }
}

// ---- state ----

let pushQueued = false;
function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    const s = buildState();
    s.inviting = phoneInviteView(s);
    if (pcScreen) pcScreen.sendState(); // The viewer learns what we share
    if (sendTo) sendTo.sync(s.peer && s.peer.name);
    if (pairSync) pairSync.check(); // Tell the other computer what changed here // the Send to entry follows the peer's name
    // A pairing code to compare: bring the window to the front.
    const phase = s.pairing ? s.pairing.phase : null;
    if (phase === 'code' && lastPairPhase !== 'code') showMain();
    lastPairPhase = phase;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s);
    updateTray(s);
  });
}

// Device names everywhere: fill {me} (this PC's name),
// {name} / {Name} (the other computer's) in a message shown outside the main window.
function fillNames(t) {
  if (!t || !String(t).includes('{')) return t || '';
  const name = peerName();
  const v = { me: (device && device.name) || 'This PC', name, Name: name.charAt(0).toUpperCase() + name.slice(1) };
  return String(t).replace(/\{(me|name|Name)\}/g, (m, k) => v[k]);
}
const fillAll = (o) => (typeof o === 'string' ? fillNames(o) : Array.isArray(o) ? o.map(fillAll)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fillAll(v)])) : o);

// The other computer's name for popups and the tray ("PC2" when it has none yet).
function peerName() {
  const p = peerView();
  return (p && p.name) || 'the other computer';
}

// The other computer: {os, name, role}, null when nothing is paired.
// role: the other computer's role ('host' = we connected to it).
function peerView() {
  const s = link.snapshot();
  if (s.session) return { os: s.session.os, name: s.session.name, id: s.session.id, role: s.session.role === 'host' ? 'guest' : 'host' };
  if (s.paired) return { os: s.paired.os, name: s.paired.macName, id: s.paired.macId, role: 'host' };
  const g = s.guests.slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
  return g ? { os: g.os, name: g.name, id: g.id, role: 'guest' } : null;
}

// Setup items that aren't ready. The driver is optional.
function missing() {
  const m = [];
  if (fw.ok === false && !fw.checking && !fw.error) m.push('firewall');
  const h = kvm.view().helper;
  if (h && h !== 'starting') m.push('helper');
  const v = vdd.view();
  if (v.checked && !v.installed) m.push('driver');
  return m;
}

// Setup shows once: until everything is ready or it's skipped.
function setupShows(miss) {
  if (!settings.setup.done && !fw.checking && !miss.length) {
    settings.setup.done = true;
    saveSettings();
  }
  return (!settings.setup.done && !fw.checking && miss.some((x) => !settings.setup.skipped.includes(x)));
}

function buildState() {
  const miss = missing();
  return {
    device,
    ...link.snapshot(),
    peer: peerView(),
    found: discovery.list(),
    discovery: { ...discovery.status },
    addresses: ownAddresses(),
    stream: { ...screen.state, remote: screen.remote, watching: screen.sentAccept === true },
    wake: wake.view(),
    macInput: screen.macInput, // the Mac's "Receive input" switch
    input: kvm.mode,
    kvmState: kvm.view(),
    kvm: { ...settings.kvm, pcSide: kvm.pcSide },
    keys: settings.keys,
    monitor: settings.monitor,
    clipboard: { ...settings.clipboard, ...clip.view, phoneShots: !!phoneShots }, // phoneShots: its rows (not in Multi-device yet)
    ui: settings.ui,
    app: settings.app,
    version: app.getVersion(),
    about: about || (about = aboutInfo(app)), // About page: this app and this computer
    updates: updates ? updates.view : null,
    firewall: fw,
    audio: { ...settings.audio, ...sound.view() },
    pcScreen: pcScreen.view(),
    pcApps: pcApps.view(),
    macApps: settings.macApps,
    terminal: { ...settings.terminal, ...terminal.view(), installedKey: undefined, server: sshd.view() },
    files: { ...settings.files, ...fileDrop.view(), smb: smb.view(), incoming: fileRecv.view(), drag: kvm.dragRecv.view(), macDrags: kvm.peerDrags, clip: fileClip.view() },
    notifs: { ...settings.notifs, ...notifs.view() },
    apps: link.peerOs !== P.OS.MAC ? peerApps.view() : apps.view(), // A PC's (or Linux computer's) apps come through peerapps.js
    startup: getStartup(),
    setup: { missing: miss, show: setupShows(miss) },
    phone: phone ? { ...phone.view, settings: settings.phone } : null,
    mount: { ...(phoneDrive ? phoneDrive.view : {}), on: settings.mount.on },
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    hub: hub ? hub.view : { ...settings.hub, connected: false },
    net: { ...(net ? net.view : {}), ...hotspotView(), location: !!wifi && wifi.refusedLocation, ble: settings.net.ble, blePc: settings.net.blePc, bleWifiOff: settings.net.bleWifiOff, bleOff, radio: bleHost ? bleHost.state : bleGuest ? bleGuest.state : 'off', transport: link.current ? link.current.transport : '' },
  };
}

// This PC's addresses for the Overview: Wi-Fi and Ethernet first, VPN/WSL/VM adapters last
// (Copy takes the first one).
// The address the other computer can reach comes first (Overview shows only that one):
// on the peer's network, then physical adapters, never a VPN / Hyper-V / WSL adapter if avoidable.
function ownAddresses() {
  const peer = String(link.snapshot().link.address || '').replace(/^::ffff:/, '');
  const onPeerNet = (i) => isIPv4(peer) && ((ipToInt(i.address) ^ ipToInt(peer)) & ipToInt(i.netmask)) === 0;
  const virt = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|Loopback|tun|tap|TAP|VPN|WireGuard|Tailscale|ZeroTier|OpenVPN|Npcap|Bluetooth/i;
  const rank = (i) => (onPeerNet(i) ? 0 : virt.test(i.name) ? 4 : /^Ethernet/i.test(i.name) ? 1 : /^Wi-?Fi/i.test(i.name) ? 2 : 3);
  return interfaces().sort((a, b) => rank(a) - rank(b)).map((i) => i.address);
}

// KVM mode changed: Monitor 2 stops/starts sending input, and the UI updates.
function onKvmChange() {
  if (kvm.mode !== lastMode) {
    lastMode = kvm.mode;
    screen.refreshInput();
  }
  pushState();
}

// ---- firewall, start with Windows ----

async function checkFirewall() {
  fw = { ...fw, checking: true };
  pushState();
  fw = { ...(await firewall.check()), checking: false };
  pushState();
}

async function fixFirewall() {
  fw = { ...fw, checking: true };
  pushState();
  try {
    fw = { ...(await firewall.fix(fw)), checking: false };
  } catch (e) {
    fw = { ...fw, checking: false, message: 'Not fixed: ' + (/cancel/i.test(e.message) ? 'the administrator prompt was declined' : e.message) };
  }
  pushState();
}

// In development the login item starts electron.exe with this app's folder.
const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });
function getStartup() {
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}
function setStartup(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginItem() });
  pushState();
}

function saveSettings() {
  store.write('settings.json', settings);
}

function statusLine(s) {
  switch (s.link.state) {
    case 'connected': return 'Connected to ' + s.link.macName;
    case 'connecting': return 'Connecting…';
    case 'reconnecting': return s.link.busy || 'Reconnecting…';
    case 'stopped': return 'Disconnected';
    case 'identity_changed': return 'Pair again';
    default: return 'Not paired';
  }
}

// ---- IPC ----

// ---- windows and tray ----

function createMainWindow() {
  const b = settings.windows.main || {};
  mainWin = new BrowserWindow({
    width: b.width || 900,
    height: b.height || 680,
    x: b.x,
    y: b.y,
    minWidth: 720,
    minHeight: 480,
    title: 'TwinDesk',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2b2e' : '#e9e9ee',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'app.html'));
  mainWin.once('ready-to-show', () => { if (!startHidden) mainWin.show(); });
  mainWin.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

function saveBounds() {
  if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
  settings.windows.main = mainWin.getNormalBounds();
  saveSettings();
}

// Show the window on one tab (tray items, popups).
function goTab(tab) {
  showMain();
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('go', tab);
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// Tray: the app mark's two screens, white on a dark
// taskbar and black on a light one; the switches people reach for most, one click away.
function trayIcon() {
  const name = trayLight ? 'tray-black' : 'tray-white';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name + '.png'));
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(__dirname, 'assets', name + '@2x.png')).toPNG() });
  return img;
}

// The taskbar follows "Windows mode" (SystemUsesLightTheme), not the apps' light/dark.
function checkTaskbar() {
  execFile('reg', ['query', 'HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize', '/v', 'SystemUsesLightTheme'], { windowsHide: true }, (err, out) => {
    const light = !err && /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(out);
    if (light === trayLight) return;
    trayLight = light;
    if (tray) tray.setImage(trayIcon());
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('TwinDesk');
  tray.on('click', showMain);
  checkTaskbar();
  updateTray();
}

function updateTray(s = buildState()) {
  if (!tray) return;
  const connected = s.link.state === 'connected';
  const name = connected && s.peer ? s.peer.name : '';
  const k = settings.kvm;
  const away = kvm.mode === 'driving' || kvm.mode === 'driven';
  const sharing = s.pcScreen.mode !== 'off';
  const found = s.found.filter((d) => !s.peer || d.id !== s.peer.id);
  const rtt = connected && s.link.rtt != null ? ' · ' + s.link.rtt + ' ms' : '';
  tray.setToolTip('TwinDesk: ' + statusLine(s));
  // Rebuild only when something in the menu changed (state pushes are frequent).
  const watching = screen.sentAccept === true;
  const host = s.paired && s.paired.macName;
  const again = !connected && host && (s.link.state === 'stopped' || !!s.link.busy);
  const key = JSON.stringify([name, rtt, again, away, kvm.linked, kvm.paused, sharing, watching, k.driveOther, k.beDriven, settings.clipboard.enabled,
    settings.audio.send, settings.app.hud, found.map((d) => [d.id, d.name, d.os]), s.updates && s.updates.available && s.updates.latest]);
  if (key === trayKey) return;
  trayKey = key;
  const other = name || 'Other Computer';
  const check = (label, checked, click) => ({ label, type: 'checkbox', checked: !!checked, click });
  const set = (section, partial, after) => {
    if (!applySettings(settings, section, partial)) return;
    saveSettings();
    if (after) after();
    pushState();
  };
  const kind = (os) => (os === 'mac' ? 'Mac' : os === 'linux' ? 'Linux' : os === 'android' ? 'Phone' : 'PC');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? 'Connected to ' + name + rtt : 'Not connected', enabled: false },
    ...(away ? [{ label: 'Bring Mouse and Keyboard Back', click: () => kvm.home() }] : []),
    check('Cursor Sharing', kvm.linked && !kvm.paused, (i) => kvm.setShared(i.checked)),
    { type: 'separator' },
    check('Share Screen', sharing, (i) => pcScreen.setMode(i.checked ? 'mirror' : 'off')),
    // Opens/closes the screen window (opening starts the other computer's sharing).
    check('Receive Screen', watching, (i) => (i.checked ? screen.open(false) : screen.close())),
    check('Use Mouse and Keyboard on ' + other, k.driveOther, (i) => set('kvm', { driveOther: i.checked }, () => kvm.applyConfig())),
    check('Let ' + other + ' Control ' + device.name, k.beDriven, (i) => set('kvm', { beDriven: i.checked }, () => kvm.applyConfig())),
    check('Share Clipboard', settings.clipboard.enabled, (i) => set('clipboard', { enabled: i.checked }, () => clip.applySettings())),
    check('Send Sound', settings.audio.send, (i) => set('audio', { send: i.checked }, () => sound.apply())),
    { type: 'separator' },
    { label: 'Connect To', submenu: [
      ...(found.length ? found.map((d) => ({ label: d.name + ' (' + kind(d.os) + ')', click: () => {
        if (d.os === P.OS.ANDROID) return connectPhoneDev(d);
        discovery.clearInvite(d.id);
        link.startPairing({ address: d.address, port: d.port, macName: d.name, id: d.id });
        showMain();
      } })) : [{ label: 'Nobody nearby', enabled: false }]),
      { type: 'separator' },
      { label: 'Connect by Address…', click: () => goTab('overview') },
      { label: 'Look Again', click: () => discovery.probe() },
    ] },
    ...(connected ? [{ label: 'Disconnect ' + name, click: () => link.disconnect() }] : []),
    ...(again ? [{ label: (s.link.busy ? 'Take Over ' : 'Connect to ') + host, click: () => link.connect(true) }] : []),
    check('Show a Popup When Switching', settings.app.hud, (i) => set('app', { hud: i.checked })),
    { type: 'separator' },
    ...(s.updates && s.updates.available ? [{ label: 'Download TwinDesk ' + s.updates.latest + '…', click: () => updates.open() }] : []),
    { label: 'Open TwinDesk…', click: showMain },
    { label: 'Quit TwinDesk', click: () => app.quit() },
  ]));
}

app.on('before-quit', () => {
  quitting = true;
  saveBounds();
  if (discovery) discovery.stop();
  if (pcScreen) pcScreen.shutdown();
  if (pcApps) pcApps.shutdown();
  if (peerApps) peerApps.shutdown();
  if (fileClip) fileClip.shutdown();
  if (phoneViews) phoneViews.shutdown();
  if (wired) wired.stop();
  if (phoneDrive) phoneDrive.shutdown();
  if (phone) phone.bridge.adb.killServer();
  if (hub && hub.audio) hub.audio.stop(); // the phone's calls go back to it
  if (hub && hub.share) hub.share.stop();
  if (callwin) callwin.close();
  if (kvm) kvm.shutdown(); // gives back any captured input and stops the helper
});

// Closing the main window only hides it; the app lives in the tray until Quit.
app.on('window-all-closed', () => {});
