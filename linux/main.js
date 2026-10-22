// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process (Linux): lifecycle, windows, tray, IPC and the state pushed to the
// main window. Follows windows/main.js: L0–L2 discovery, pairing, clipboard, the other screen in a
// window; L3 mouse and keyboard (kvm.js + linux-helper); L4 the host role (server, pairing
// responder, peer.js with P.swapRole: Linux ↔ Linux, Linux ↔ PC); L5 this screen and sound on the
// other computer, files, notifications, wake; L6 Wayland (portal screen capture; input through the
// helper's uinput backend); L7 packages (package.json "build"); L8 the shared folder (Samba + GVFS),
// copy/paste of files with shortcuts, file drags across the edge, the file managers' Send to, and
// Extend (a virtual monitor from Mutter on Wayland, a spare output on X11).
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification } = require('electron');
const { Updates } = require('../shared/updates.js');
const { aboutInfo } = require('../shared/about.js');
const { spawn } = require('child_process');
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
const Helper = require('./helper');
const Kvm = require('./kvm');
const Hud = require('./hud');
const Sound = require('./sound');
const FileDrop = require('./filedrop');
const FileRecv = require('./filerecv');
const DragRecv = require('./dragrecv');
const FileClip = require('./fclip');
const Smb = require('./smb');
const SendTo = require('./sendto');
const Vdd = require('./vdd');
const PcScreen = require('./pcscreen');
const Sender = require('./sender');
const Notifs = require('./notifs');
const Wake = require('./wake');
const theme = require('./theme');
const Terminal = require('./terminal');
const Sshd = require('./sshd');
const Apps = require('./apps');
const PcApps = require('./pcapps');
const PeerApps = require('./peerapps');
const desktopApps = require('./desktopapps');
const loopback = require('./loopback');
const autostart = require('./autostart');
const { PairSync } = require('./pairsync');
const { PhoneLink } = require('./phone-link');
const { Wired } = require('./wired');
const { PhoneDrive } = require('./phonedrive');
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { PhoneViews } = require('./phoneview');
const setupIpc = require('./ipc');
const system = require('./system');
const { LiveProgress } = require('./liveprogress');
const { BleHost, BleGuest, BlePhones } = require('../shared/blepipe.js');
const { blePolicy, wifiQuiet } = require('../shared/blepolicy.js');
const { NetLink } = require('../shared/netlink.js');
const { Wifi } = require('./wifi');
const { normalize, apply: applySettings } = require('./settings');

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Every sent video frame says "show me now" (RTP playout delay 0/0); FlexFEC repairs
// lost packets without a resend round trip. Same trials as the Mac and the PC.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/');
// Wayland (L6): screen capture through the desktop portal and PipeWire.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
// Renamed MacShare → TwinDesk: settings, pairing and keys stay in the folder they've always been
// in (Electron would follow the new product name). A dev copy's --user-data-dir still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'MacShare'));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null); // its accelerators would steal keys meant for the other computer
  // Starting TwinDesk again shows the window (no tray on some desktops); a Mac app's launcher starts
  // "twindesk --mac-app=<id>": open that app instead; the file managers' Send to, --send-files.
  app.on('second-instance', (_e, argv) => {
    if (sendTo && sendTo.handle(argv)) return;
    if (!openMacAppArg(argv)) showMain();
  });
  app.whenReady().then(start);
}

let mainWin = null;
let tray = null;
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
let kvm = null;
let sound = null;
let fileDrop = null;
let fileRecv = null;
let fileClip = null;
let smb = null;
let sendTo = null;
let vdd = null;
let pcScreen = null;
let notifs = null;
let wake = null;
let updates = null;
let updateNote = null; // the update notification, kept so it isn't collected before a click
let pairSync = null;
let terminal = null;
let sshd = null;
let apps = null;
let pcApps = null;
let peerApps = null;
let pendingMacApp = null; // {id, until}: opened once the Mac connects (2 min)
let wired = null; // wired.js, with the phone
let hostServer = null; // server.js, once the certificate exists
let phone = null; // A phone as the peer: phone.js (its .bridge: phone-bridge.js)
let phoneViews = null; // its screen and apps in windows here (phoneview.js)
let phoneDrive = null; // its storage as a drive here (phonedrive.js)
let bleHost = null; // Bluetooth, for devices not on this network: we host (blepipe.js, the helper's ble.c)
let bleGuest = null; // … we connect to a host
let blePhones = null; // phones that advertise: we connect to them
let bleOff = false; // General's Turn off Bluetooth on Wi-Fi connections, in effect (bleQuiet)
const bleQuiet = wifiQuiet();
let net = null; // Wi-Fi for a session through Bluetooth (netlink.js)
let wifi = null; // this computer's Wi-Fi for it: hosting, joining (wifi.js, NetworkManager)
let pendingView = null; // a phone window waiting for wireless debugging (phoneViews.onNoAdb)
let lastMode = 'home';
let fw = { checking: true, ok: null, message: 'Checking…' };
const session = system.session();
// Started at login (tray only), or by a Mac app's launcher (that app only).
const startHidden = process.argv.includes('--hidden') || process.argv.some((a) => a.startsWith('--mac-app='));
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
  theme.start();
  device = loadDevice();
  settings = normalize(store.read('settings.json', {}));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
  // Asleep: the session we host ends and dark wakes refuse it; awake, the device that was connected is invited back.
  require('../shared/sleepwake.js').sleepWake({ powerMonitor: require('electron').powerMonitor, server: () => hostServer, discovery: () => discovery });
  discovery.on('invite', (d) => {
    // Connect on this computer in our host's list: back to it, taking the session over.
    if (guest.pairing && d && d.id === guest.pairing.macId) return void (discovery.clearInvite(d.id), guest.connect(true));
    pushState();
    showMain();
  }); // another computer wants to connect: Pair is focused
  discovery.start();

  // link = the peer layer (peer.js): guest of a Mac or another computer, or host of a PC/Linux.
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
  fileDrop = new FileDrop({ link, settings, onProgress: (v) => { screen.sendDropProgress(fillAll(v)); pushState(); } });
  screen.fileDrop = fileDrop;
  sound = new Sound({ link, settings, onChange: pushState });
  smb = new Smb({ link, settings, save: saveSettings, onChange: pushState });
  terminal = new Terminal({ link, settings, onChange: pushState });
  sshd = new Sshd({ link, settings, save: saveSettings, onChange: pushState });
  // The helper: X11 (XInput2 + XTest), or on Wayland its uinput backend when /dev/uinput is ours.
  helper = new Helper(() => system.inputBlocker(session));
  fileRecv = new FileRecv({ link, helper, settings, onChange: pushState });
  hud = new Hud(() => settings);
  const dragRecv = new DragRecv({ link, helper, settings, isDriven: () => kvm && kvm.mode === 'driven', popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  kvm = new Kvm({ link, helper, clip, fileDrop, fileRecv, dragRecv, settings, save: saveSettings, onChange: onKvmChange });
  const hudShow = hud.show.bind(hud);
  hud.show = (kind, text, sub) => hudShow(kind, fillNames(text), fillNames(sub || '')); // device names in popups
  // Cursor sharing switched on/off (hotkey double-tap, tray, the Cursor tab or the other side): the big card.
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  kvm.onLinked = (on, here, ble) => {
    const name = link.snapshot().link.state === 'connected' ? peerName() : '';
    const key = P.hotkeyName(settings.keys.hotkey, 'win').replace('Windows key', 'Super');
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
  // Send files and drops show progress in the popup, like the PC.
  const pct = (n, total) => Math.min(99, Math.floor((n / total) * 100));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  let lastPopup = 0;
  const progressPopup = (kind, text, done) => {
    const now = Date.now();
    if (!done && now - lastPopup < 250) return;
    lastPopup = now;
    hud.show(kind, text);
  };
  // …and in a notification with a live progress bar (liveprogress.js), one each way.
  const live = new LiveProgress(path.join(__dirname, 'assets', 'icon.png'));
  fileRecv.onBatchProgress = (b) => {
    if (Date.now() - b.at < 400) return; // small batches: only the "Pasted" / "Received" popup
    const part = b.total ? pct(b.got, b.total) : pct(b.done, b.count);
    const what = (b.kind === 'paste' ? 'Pasting ' : 'Receiving ') + plural(b.count, 'file');
    progressPopup('driven', what + ' from ' + peerName() + ' · ' + part + ' %');
    live.progress('recv', what, 'From ' + peerName(), part);
  };
  fileDrop.onBatchProgress = (b) => {
    if (!(b.bytes > 5 * 1024 * 1024)) return;
    if (b.done) {
      live.done('send', b.ok ? 'Sent ' + b.name : 'Not everything arrived', 'On ' + peerName());
      return progressPopup('away', b.ok ? 'Sent ' + b.name + ' to ' + peerName() : 'Not everything arrived on ' + peerName(), true);
    }
    progressPopup('away', 'Sending ' + b.name + ' to ' + peerName() + ' · ' + pct(b.sent, b.bytes) + ' %');
    live.progress('send', 'Sending ' + b.name, 'To ' + peerName(), pct(b.sent, b.bytes));
  };
  link.on('closed', () => {
    live.done('recv', 'Files stopped', peerName() + ' disconnected');
    live.done('send', 'Files stopped', peerName() + ' disconnected');
  });
  fileRecv.onBatch = (b) => {
    live.done('recv', b.files ? 'Received ' + plural(b.files, 'file') : 'Nothing arrived', 'From ' + peerName());
    if (b.kind === 'paste') fileClip.pasted(b);
    else if (b.files) hud.show('driven', 'Received ' + b.files + ' file' + (b.files === 1 ? '' : 's') + ' from ' + peerName());
  };
  // Copy/paste files with shortcuts (the helper watches the keys), the file managers' Send to.
  fileClip = new FileClip({ link, helper, fileDrop, fileRecv, settings, peerName, popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  kvm.fileClip = fileClip; // our copy/paste shortcut while driving → fclip.key
  sendTo = new SendTo({ link, fileDrop, peerName: () => (peerView() || {}).name || '', popup: (kind, text, sub) => hud.show(kind, text, sub) });
  notifs = new Notifs({ link, helper, settings, save: saveSettings, peerName, onChange: pushState });
  wake = new Wake({ link, settings, save: saveSettings, onChange: pushState, address: () => ownAddresses()[0] });
  const sender = new Sender(link);
  vdd = new Vdd({ onChange: pushState });
  pcScreen = new PcScreen({ link, helper, sender, vdd, settings, popup: (kind, text) => hud.show(kind, text), inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  vdd.check(); // Extend: can this desktop add a virtual monitor? (and one left on by a crash goes)
  apps = new Apps({ link, allowed: () => settings.macApps.on, getMonitor: () => screen.win, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState, onWatch: () => screen.policy() });
  screen.apps = apps;
  pcApps = new PcApps({ link, helper, sender, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  peerApps = new PeerApps({ link, settings, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState });
  helper.on('exit', pushState);
  helper.on('ready', () => { sendScreens(); pushState(); });
  const { screen: displays } = require('electron');
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) displays.on(ev, sendScreens);
  setupNet(guest);
  helper.start();
  // New releases on GitHub: a notification once per version, the tray item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'linux', prefer: process.env.APPIMAGE || !app.isPackaged ? 'appimage' : 'deb', getSettings: () => settings, save: saveSettings, onChange: pushState,
    canInstall: app.isPackaged, idle: () => !kvm || kvm.mode === 'home', quit: () => app.quit(),
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      updateNote = new Notification({ title, body });
      updateNote.on('click', onClick);
      updateNote.show();
    },
  });
  updates.start();
  const ipc = setupIpc({ link, discovery, screen, clip, kvm, fileDrop, smb, fileClip, vdd, sound, pcScreen, notifs, wake, terminal, sshd, apps, pcApps, peerApps, updates, settings, save: saveSettings, push: pushState, buildState,
    get phone() { return phone; }, get phoneViews() { return phoneViews; }, get phoneDrive() { return phoneDrive; }, connectPhoneDev, cancelPhoneInvite, hub: loadHub,
    get net() { return net; }, get wifi() { return wifi; }, applyNet, joinHotspot, openBluetoothSettings,
    checkFirewall, fixFirewall, fixInput, setStartup, onApp: () => updateTray(buildState()) });
  pairSync = new PairSync({ link, settings, save: saveSettings, set: ipc.set }); // Two-way switches per pair
  nativeTheme.on('updated', pushState);
  link.start();
  link.on('welcome', () => { // a Mac app's launcher was used while the Mac wasn't connected
    if (pendingMacApp && Date.now() < pendingMacApp.until) openMacApp(pendingMacApp.id);
    pendingMacApp = null;
  });

  createTray();
  createMainWindow();
  if (!sendTo.handle(process.argv)) openMacAppArg(process.argv);
  checkFirewall();
  if (process.argv.includes('--test-monitor')) screen.open(true); // dev: ?test=1 pattern
}

// The Wayland backend can't ask the compositor for the monitors: tell it ours (logical px).
function sendScreens() {
  if (!helper || helper.backend !== 'uinput') return;
  const { screen: displays } = require('electron');
  const primary = displays.getPrimaryDisplay().id;
  const list = displays.getAllDisplays().map((d) => [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height, d.id === primary ? 1 : 0].join(',')).join(';');
  helper.send('screens', { list });
}

// Host role (L4): our own server, once the certificate exists (made on first start).
async function startHost(guest, tries = 0) {
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
      info: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.LINUX, port: server.port, fp: id.fp }),
      enabled: () => bleHostOn(),
      accept: (g) => bleAccepts(g.os),
    });
    bleHost.on('change', pushState);
    discovery.extras.unshift(bleHost);
    blePhones = new BlePhones({ helper, server, hello: bleHost.info });
    blePhones.on('change', pushState);
    // A phone linked or gone: advertising follows (bleHostOn), after BlePhones has seen the event.
    helper.on('event', (name) => { if (name.startsWith('blp.')) bleHost.apply(); });
    setInterval(() => bleHost.apply(), 2000); // and a pipe our end closed (no event): apply() only compares when nothing changed
    // The phone asks for a pipe: it has none, so one still held for it is dead (an open that crossed
    // its "closed"), and BlePhones, seeing it, opened nothing: our TLS answer sat in it, the phone's
    // hello timed out. Before BlePhones sees the ask: that one goes (no "closed" to the phone), a fresh one comes.
    helper.prependListener('event', (name, m) => {
      const dev = name === 'blp.want' && String(m.dev || '').slice(0, 64);
      if (dev && blePhones.pipes.has(dev)) blePhones._closePipe(dev);
    });
    discovery.extras.push(blePhones);
    server.on('phoneFree', () => { guest.poke(); pushState(); });
  } catch (e) {
    console.error('[host]', e.message);
    link.host = { on: false, error: 'No certificate: ' + e.message };
    pushState();
    if (tries < 5) setTimeout(() => startHost(guest, tries + 1), 15000); // a busy computer at login: try again
    return;
  }
  // Outside the retry: the server already holds the port, a second one would only find it in use.
  try {
    startPhone(hostServer, link.pairing);
  } catch (e) {
    console.error('[phone]', e.message);
  }
}

// A phone as the peer (port of the PC's): the sidebar tile and Phone page (phone.js), its screen,
// touch, mouse, keyboard and clipboard through wireless debugging (phone-bridge.js), and its
// screen and apps in windows here (phoneview.js). X11 and Wayland alike: the phone's input goes
// through adb, not the helper.
function startPhone(server, pairing) {
  const pl = new PhoneLink(link, server);
  phone = new Phone({ server: pl, raw: server, discovery, pairing });
  setupHub(pl);
  phone.on('change', pushState);
  // The phone's Keyboard page names this computer's hotkey (double-tap = everything back here).
  pl.on('client', (ctx) => ctx.os === P.OS.ANDROID && pl.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_WIN, 'win').replace('Windows key', 'Super') }));
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
  phone.bridge.on('change', () => {
    pushState();
    if (pendingView && phone.bridge.serial) {
      const v = pendingView;
      pendingView = null;
      if (Date.now() < v.until) v.kind === 'app' ? phoneViews.openApp(v.app, v.title) : phoneViews.openScreen();
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
    btSettings: openBluetoothSettings, // pairing the phone for the calls' sound
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
    callwin.update(hub, { corner: 'top', open: goTab });
  };
  hub.on('call', popup);
  hub.on('change', popup);
  if (phoneLink.current && phoneLink.current.os === P.OS.ANDROID) hub.started();
  return hub;
}

// ---- not on the same network: Bluetooth, and Wi-Fi when it's needed ----

// The session through Bluetooth (blepipe.js, the helper's ble.c on BlueZ) when the other device
// isn't on this network; files and screens move it onto a Wi-Fi network one side hosts
// (netlink.js). This computer hosts an access point while its Wi-Fi isn't on a network, else joins
// the other side's (wifi.js, NetworkManager). Nothing here runs with a device that doesn't know
// about it: those never come through Bluetooth.
function setupNet(guest) {
  bleGuest = new BleGuest({ helper, hello: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.LINUX }) });
  bleGuest.on('change', pushState);
  bleGuest.on('invite', () => { pushState(); showMain(); });
  guest.ble = bleGuest;
  discovery.extras.push(bleGuest);
  wifi = new Wifi({ keepWifi: () => settings.net.keepWifi, onChange: pushState });
  // What this computer can do (a Wi-Fi adapter plugged in, its Wi-Fi on a network or not): the other side hears when it changes.
  const recheck = () => wifi.refresh().then((changed) => changed && net.caps(), () => {});
  helper.on('ready', () => {
    applyNet();
    recheck();
  });
  // Bluetooth LE links that survive a phone or a Mac busy with Wi-Fi (wifi.js bleTimeout); again
  // now and then: a Bluetooth adapter that resets gets the kernel's default back.
  const bleTimeout = () => wifi.bleTimeout().catch(() => {});
  setTimeout(bleTimeout, 3000);
  setInterval(bleTimeout, 60000).unref();
  net = new NetLink({
    os: P.OS.LINUX,
    send: (m) => link.sendNow(m),
    current: () => link.current,
    host: { can: () => wifi.canHost(link.current && link.current.os), start: (ssid, pass) => wifi.host(ssid, pass), stop: () => wifi.unhost() },
    join: { can: () => wifi.can(), start: (ssid, pass) => wifi.join(ssid, pass), stop: () => wifi.leave() },
    band5: () => wifi.band5,
    // Connect with hotspot (a phone): it switches its hotspot on, this computer joins it (the Overview asks
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
    applyBle();
  });
  link.on('closed', () => {
    bleEnded = Date.now(); // Bluetooth looks a while, window or not: the session comes back by itself
    net.ended();
    applyBle();
  });
  link.on('transport', () => {
    applyBle(); // on Wi-Fi or a cable now: no more looking, the Bluetooth fallback stays
    pushState();
    screen.policy();
    if (!net.onBle && settings.files.mountMac && smb.mac && !smb.mounted) smbMount(); // on Wi-Fi now: the folder too
  });
  // The other computer's folder through Bluetooth: not connected there (its address is the pipe's);
  // Open moves the session onto Wi-Fi Direct and connects it then, kept up while it's connected.
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
      smb.open();
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
    if (!smb.mounted && !smbWait) net.release('smb');
    applyBle();
  }, 2000);
  setInterval(lookForPhones, PHONE_LOOK_MS);
  const refresh = discovery.refresh.bind(discovery);
  discovery.refresh = () => { // Refresh: phones nearby answer again too
    refresh();
    lookForPhones();
  };
}

// Bluetooth, two switches (General): with phones (on unless switched off) and with computers (off
// unless switched on). Advertising runs the whole time either is on, sessions on Wi-Fi or a cable
// included: the Bluetooth fallback stays beside them, and the session goes back to it when the
// network ends. Looking for devices (scanning) only while there's no session and the window is
// open, or one just ended (shared/blepolicy.js).
let bleEnded = 0; // when the last session ended
const blePhonesOn = () => settings.net.ble !== false;
const blePcsOn = () => settings.net.blePc === true;
function bleNow() {
  return blePolicy({ enabled: () => blePhonesOn() || blePcsOn(), windowOpen: () => !!mainWin && !mainWin.isDestroyed() && mainWin.isVisible(), current: () => link.current, ended: bleEnded });
}

// Who may come in through our advertising: a phone with phones on, a computer with computers on.
function bleAccepts(os) {
  return os === P.OS.ANDROID ? blePhonesOn() : blePcsOn();
}

function bleHostOn() {
  if (bleOff || !(blePhonesOn() || blePcsOn())) return false;
  // Linked to a phone ourselves (BlePhones): not while no computer needs it. Seeing us advertise, the
  // phone connected over that same link to read who we are, and closing its side again made Android
  // drop the whole link, ours too: the phone's session went every few seconds to half a minute. It
  // asks for a pipe through our link (blp.want) without seeing us advertise.
  const pc = !!bleHost && ([...bleHost.guests.values()].some((g) => g.os !== P.OS.ANDROID) || bleHost.pipes.size > 0);
  return !(blePhones && blePhones.links.size > 0 && !pc);
}

function applyBle() {
  applyQuiet(bleQuiet({ on: settings.net.bleWifiOff, current: () => link.current, onGroup: () => !!net && net.onGroup }));
  const p = bleNow();
  if (bleHost) bleHost.apply();
  if (bleOff) {
    if (bleGuest) bleGuest.drop();
    if (blePhones) blePhones.stop();
    return;
  }
  if (bleGuest) bleGuest.scan(p.look && blePcsOn());
  if (blePhones) {
    if (!blePhonesOn()) {
      blePhones.stop();
      return bleHost.apply(); // no phone links now: advertising for computers may come back
    }
    blePhones.autoLink = p.look; // in a session: phones found are listed, linked only on Pair or Connect
    blePhones.scan(p.look);
    if (!p.look && !p.hold) blePhones.trim(); // links without a pipe; the session's and its fallback stay
    bleHost.apply(); // links trimmed: advertising may come back (bleHostOn)
  }
}

// The session on the same Wi-Fi a while (General's Turn off Bluetooth on Wi-Fi connections,
// blepolicy.js wifiQuiet): no advertising, scanning or links, its Bluetooth fallback closed with
// them; back as it was when the session ends.
function applyQuiet(off) {
  if (off === bleOff) return;
  bleOff = off;
  console.log(`[ble] ${off ? 'off: the session is on the same Wi-Fi' : 'on again'}`);
  pushState();
}

// Phones advertise while they're open and not connected: with this window open we look for them
// now and then (PHONE_LOOK_MS) and on Refresh, in a session too (listed under Found nearby, nothing
// linked until Pair or Connect). Not while the window is closed, nor while a phone's session runs on
// Bluetooth: the phone advertises under a new address now and then, and found there it counted as
// moved, its link (the session's) dropped for the new one.
const PHONE_LOOK_MS = 5000;
const PHONE_BURST_MS = 2000;
function lookForPhones() {
  if (!blePhones || !blePhonesOn() || bleOff || !mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return;
  const c = link.current;
  if (c && c.os === P.OS.ANDROID && c.transport === 'ble') return;
  blePhones.burst(PHONE_BURST_MS);
}

// Bluetooth on or off (General), or the helper restarted.
function applyNet() {
  applyBle();
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
    try { pass = safeStorage.decryptString(Buffer.from(saved.pass, 'base64')); } catch (_) { /* another user's, or the keyring gone */ }
  }
  const sealed = pass && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(pass).toString('base64') : '';
  settings.net.hotspots[c.deviceId] = { ssid, pass: sealed };
  saveSettings();
  net.joinHotspot(ssid, pass);
}

// Settings › Bluetooth of whichever desktop this is.
function openBluetoothSettings() {
  const tries = [['gnome-control-center', ['bluetooth']], ['cinnamon-settings', ['bluetooth']], ['blueman-manager', []],
    ['systemsettings', ['kcm_bluetooth']], ['blueberry', []], ['xfce4-settings-manager', []]];
  const next = (i) => {
    if (i >= tries.length) return;
    const p = spawn(tries[i][0], tries[i][1], { detached: true, stdio: 'ignore' });
    p.on('error', () => next(i + 1));
    p.unref();
  };
  next(0);
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

// A phone found nearby: a paired one is asked to connect, any other to pair with this computer.
// An unpaired one: the popup says Pair has to be pressed on it, until it starts pairing or a minute went by.
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

// ---- Mac apps from their launchers ----

function openMacAppArg(argv) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--mac-app='));
  if (!arg) return false;
  const id = arg.slice('--mac-app='.length).slice(0, 1024);
  if (id) openMacApp(id);
  return true;
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
    if (pcScreen) pcScreen.sendState(); // the viewer learns what we share
    if (sendTo) sendTo.sync(s.peer && s.peer.name); // the Send to entries follow the peer's name
    if (pairSync) pairSync.check(); // tell the other computer what changed here
    const phase = s.pairing ? s.pairing.phase : null;
    if (phase === 'code' && lastPairPhase !== 'code') showMain(); // a code to compare: to the front
    lastPairPhase = phase;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s);
    updateTray(s);
  });
}

// Device names everywhere.
function fillNames(t) {
  if (!t || !String(t).includes('{')) return t || '';
  const name = peerName();
  const v = { me: (device && device.name) || 'this computer', name, Name: name.charAt(0).toUpperCase() + name.slice(1) };
  return String(t).replace(/\{(me|name|Name)\}/g, (m, k) => v[k]);
}
const fillAll = (o) => (typeof o === 'string' ? fillNames(o) : Array.isArray(o) ? o.map(fillAll)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fillAll(v)])) : o);

function peerName() {
  const p = peerView();
  return (p && p.name) || 'the other computer';
}

// The other computer: {os, name, id, role}, null when nothing is paired.
function peerView() {
  const s = link.snapshot();
  if (s.session) return { os: s.session.os, name: s.session.name, id: s.session.id, role: s.session.role === 'host' ? 'guest' : 'host' };
  if (s.paired) return { os: s.paired.os, name: s.paired.macName, id: s.paired.macId, role: 'host' };
  const g = s.guests.slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
  return g ? { os: g.os, name: g.name, id: g.id, role: 'guest' } : null;
}

// Setup items that aren't ready.
function missing() {
  const m = [];
  if (session.type !== 'x11' && session.type !== 'wayland') m.push('session');
  if (session.type === 'wayland' && !system.inputAccess().uinput) m.push('input');
  if (fw.ok === false && !fw.checking) m.push('firewall');
  const h = kvm.view().helper;
  if (session.type === 'x11' && h && h !== 'starting') m.push('helper');
  return m;
}

// Setup shows once: until everything is ready or it's skipped (no desktop session: always).
function setupShows(miss) {
  if (!settings.setup.done && !fw.checking && !miss.length) {
    settings.setup.done = true;
    saveSettings();
  }
  return miss.includes('session') || (!settings.setup.done && !fw.checking && miss.some((x) => !settings.setup.skipped.includes(x)));
}

function buildState() {
  const miss = missing();
  const snap = link.snapshot();
  return {
    device,
    ...snap,
    // The device in session (link.snapshot's `session`): `session` below is this desktop's (X11 or
    // Wayland) and replaces it, which hid every phone page (Calls, Messages, Photos, Phone Files).
    peerSession: snap.session || null,
    peer: peerView(),
    found: discovery.list(),
    discovery: { ...discovery.status },
    addresses: ownAddresses(),
    stream: { ...screen.state, remote: screen.remote, watching: screen.sentAccept === true },
    wake: wake.view(),
    macInput: screen.macInput,
    input: kvm.mode,
    kvmState: { ...kvm.view(), message: fillNames(kvm.message) },
    kvm: { ...settings.kvm, pcSide: kvm.pcSide },
    keys: settings.keys,
    monitor: settings.monitor,
    clipboard: { ...settings.clipboard, ...clip.view },
    ui: settings.ui,
    app: settings.app,
    version: app.getVersion(),
    about: about || (about = aboutInfo(app)), // About page: this app and this computer
    updates: updates ? updates.view : null,
    firewall: fw,
    session: { ...session, input: helper.backend || '', access: session.type === 'wayland' ? system.inputAccess() : null, inputNote, helperError: helper.error || '' },
    audio: { ...settings.audio, ...sound.view() },
    pcScreen: pcScreen.view(),
    files: { ...settings.files, ...fileDrop.view(), smb: smb.view(), incoming: fileRecv.view(), drag: kvm.dragRecv.view(), macDrags: kvm.peerDrags, clip: fileClip.view(), session: session.type },
    terminal: { ...settings.terminal, ...terminal.view(), installedKey: undefined, server: sshd.view() },
    apps: link.peerOs === P.OS.MAC ? apps.view() : peerApps.view(), // a PC's or Linux computer's apps come through peerapps.js
    pcApps: pcApps.view(),
    macApps: settings.macApps,
    notifs: { ...settings.notifs, ...notifs.view() },
    startup: autostart.get(),
    setup: { missing: miss, show: setupShows(miss) },
    phone: phone ? { ...phone.view, settings: settings.phone } : null,
    mount: { ...(phoneDrive ? phoneDrive.view : {}), on: settings.mount.on },
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    hub: hub ? hub.view : { ...settings.hub, connected: false },
    net: { ...(net ? net.view : {}), ...hotspotView(), side: wifi ? wifi.side : null, location: false, ble: settings.net.ble, blePc: settings.net.blePc, bleWifiOff: settings.net.bleWifiOff, bleOff, radio: bleHost ? bleHost.radio : bleGuest ? bleGuest.state : 'off', transport: link.current ? link.current.transport : '' },
  };
}

// This computer's addresses: the one the other computer can reach first (Overview shows only that one).
function ownAddresses() {
  const peer = String(link.snapshot().link.address || '').replace(/^::ffff:/, '');
  const onPeerNet = (i) => isIPv4(peer) && ((ipToInt(i.address) ^ ipToInt(peer)) & ipToInt(i.netmask)) === 0;
  const rank = (i) => (onPeerNet(i) ? 0 : /^(docker|br-|veth|virbr|tun|tap|wg|tailscale|zt|vmnet|vboxnet)/.test(i.name) ? 3 : /^(en|eth)/.test(i.name) ? 1 : /^wl/.test(i.name) ? 2 : 2);
  return interfaces().sort((a, b) => rank(a) - rank(b)).map((i) => i.address);
}

function onKvmChange() {
  if (kvm.mode !== lastMode) {
    lastMode = kvm.mode;
    screen.refreshInput();
  }
  pushState();
}

// ---- firewall, open at login ----

async function checkFirewall() {
  fw = { ...fw, checking: true };
  pushState();
  fw = { ...(await system.checkFirewall(!!store.read('firewall.json', {}).fixed)), checking: false };
  pushState();
}

async function fixFirewall() {
  fw = { ...fw, checking: true };
  pushState();
  try {
    await system.fixFirewall(fw.tool);
    if (fw.tool === 'ufw') store.write('firewall.json', { fixed: true });
    fw = { ...(await system.checkFirewall(true)), checking: false };
  } catch (e) {
    fw = { ...fw, checking: false, message: 'Not fixed: ' + e.message };
  }
  pushState();
}

async function fixInput() {
  try {
    await system.fixInput();
    inputNote = 'Done. Log out and back in once to finish.';
  } catch (e) {
    inputNote = 'Not fixed: ' + e.message;
  }
  helper.start();
  pushState();
}
let inputNote = '';

function setStartup(on) {
  autostart.set(!!on);
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
  for (const ev of ['show', 'hide', 'minimize', 'restore']) mainWin.on(ev, () => applyBle()); // Bluetooth looks only while it's open
  mainWin.on('show', () => lookForPhones());
  mainWin.on('close', (e) => {
    saveBounds();
    if (!quitting && tray) { // no tray on this desktop: closing quits, or nothing would bring it back
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

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray@2x.png')).toPNG() });
    tray = new Tray(img);
  } catch (e) {
    console.error('[tray]', e.message); // no tray on this desktop: start TwinDesk again to show the window
    return;
  }
  tray.setToolTip('TwinDesk');
  tray.on('click', showMain);
  updateTray(buildState());
}

// The tray menu, like the PC's. Rebuilt when what it shows
// changes (some Linux trays only take a new menu, not changes to the old one).
let trayKey = '';
function updateTray(s) {
  if (!tray) return;
  tray.setToolTip('TwinDesk: ' + statusLine(s));
  const connected = s.link.state === 'connected';
  const name = connected && s.peer ? s.peer.name : '';
  const k = settings.kvm;
  const away = kvm.mode === 'driving' || kvm.mode === 'driven';
  const sharing = s.pcScreen.mode !== 'off';
  const watching = screen.sentAccept === true;
  const found = s.found.filter((d) => !s.peer || d.id !== s.peer.id);
  const rtt = connected && s.link.rtt != null ? ' · ' + s.link.rtt + ' ms' : '';
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
    ...(s.updates && s.updates.available ? [{ label: (s.updates.canInstall ? 'Update to TwinDesk ' : 'Download TwinDesk ') + s.updates.latest + '…', click: () => updates.act() }] : []),
    { label: 'Open TwinDesk…', click: showMain },
    { label: 'Quit TwinDesk', click: () => app.quit() },
  ]));
}

app.on('before-quit', () => {
  quitting = true;
  theme.stop();
  saveBounds();
  if (discovery) discovery.stop();
  if (pcScreen) pcScreen.shutdown();
  if (pcApps) pcApps.shutdown();
  if (peerApps) peerApps.shutdown();
  desktopApps.shutdown();
  if (notifs) notifs.shutdown();
  if (phoneViews) phoneViews.shutdown();
  if (wired) wired.stop();
  if (phoneDrive) phoneDrive.shutdown();
  if (phone) phone.bridge.adb.killServer();
  if (hub && hub.audio) hub.audio.stop(); // the phone's calls go back to it
  if (hub && hub.share) hub.share.stop();
  if (callwin) callwin.close();
  if (kvm) kvm.shutdown(); // gives back any captured input and stops the helper
  loopback.shutdown();
});

// Closing the main window only hides it while there is a tray; the app lives there until Quit.
app.on('window-all-closed', () => { if (!tray) app.quit(); });
