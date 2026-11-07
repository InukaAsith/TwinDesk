// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process (Linux): lifecycle, windows, tray, IPC and the state pushed to the
// main window. Follows windows/main.js: L0–L2 discovery, pairing, clipboard, the other screen in a
// window; L3 mouse and keyboard (kvm.js + linux-helper); L4 the host role (server, pairing
// responder, peer.js with P.swapRole: Linux ↔ Linux, Linux ↔ PC); L5 this screen and sound on the
// other computer, files, notifications, wake; L6 Wayland (portal screen capture; input through the
// helper's uinput backend); L7 packages (package.json "build"); L8 the shared folder (Samba + GVFS),
// copy/paste of files with shortcuts, file drags across the edge, the file managers' Send to, and
// Extend (a virtual monitor from Mutter on Wayland, a spare output on X11).
const { lanType } = require('../shared/lantype.js'); // Wi-Fi or Ethernet for Overview (#140)
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification } = require('electron');
const { Updates } = require('../shared/updates.js');
const { aboutInfo } = require('../shared/about.js');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const P = require('../shared/protocol.js');
const { receivedDir } = require('../shared/received.js'); // General › Received files
const CL = require('../shared/cursorlock.js');
const trayMenu = require('../shared/traymenu.js');
const I18n = require('../shared/i18n.js');
let i18n = I18n.create('en');
const t = (...args) => i18n.t(...args);
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
const { DevCtl } = require('../shared/devctl.js');
const { DevLocal } = require('../shared/devlocal.js');
const { startAdbQr } = require('../shared/adbqr.js');
const Wake = require('./wake');
const theme = require('./theme');
const Look = require('../shared/look.js');
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
// Wayland (L6): screen capture through the desktop portal and PipeWire: WebRTCPipeWireCapturer, in the
// enable-features switch below (with the screen codec's).
// Renamed MacShare → TwinDesk: settings, pairing and keys stay in the folder they've always been
// in (Electron would follow the new product name). A dev copy's --user-data-dir still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'MacShare'));
require('../shared/applog.js').start(app); // console.* and crashes into the log folder, both apps
// Screen share codec (shared/screencodec.js): H.265 available in WebRTC, so the
// Encoder setting works on the next share. One enable-features switch for the app: Chromium keeps only the last one.
{
  const codec = require('../shared/screencodec.js');
  const on = codec.features(['WebRTCPipeWireCapturer']);
  if (on) app.commandLine.appendSwitch('enable-features', on);
}
require('../shared/gpufallback.js').start(app); // a Wayland GPU crash loop: start again through XWayland
// Multi-device switched on (multi.js, docs/multi-device.md): mesh/main.js runs instead of everything below.
if (require('./multi').on()) return void require('./mesh/main.js');
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
let camShare = null; // Camera tab: the cameras of the two computers (shared/camshare.js)
let phoneRemote = null; // the phone's Remote page: touchpad, keyboard and gamepad here (shared/phone-remote.js)
let vcam = null; // Camera: the running camera's picture, to the tab and the virtual camera (shared/vcam.js, vcam.js)
let nowPlaying = null; // what plays on the phone, for the Overview's media controls (shared/nowplaying.js)
let btAudio = null; // the phone's sound here over Bluetooth (shared/btaudio.js)
let rezume = null; // ReZume (shared/rezume.js), only once it's turned on
let rezumeShelf = null; // … its notification and taskbar button (shared/rezume-shelf.js)
let rezumeAct = null; // … what's in front here (activity.js)
let helper = null;
let kvm = null;
let sound = null;
let mic = null; // Audio › Microphone (shared/mic.js), loaded only while one of its switches is on
let fileDrop = null;
let fileRecv = null;
let fileClip = null;
let smb = null;
let sendTo = null;
let vdd = null;
let pcScreen = null;
let notifs = null;
let devctl = null; // Overview's controls of the other device, and this computer's for it (shared/devctl.js)
let chats = null; // Messages' chat apps from a phone, kept per phone (shared/chats.js)
let wake = null;
let updates = null;
let updateNote = null; // the update notification, kept so it isn't collected before a click
let pairSync = null;
let terminal = null; // only while Terminal is on (loadTerminal)
let phoneServer = null; // the phones' session (PhoneLink), for features loaded later
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
let web = null; // TwinDesk Web (shared/web/webwire.js): browsers and iPhones as devices of their own
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
  require('../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
  theme.setPref(settings.ui.theme);
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
  // Asleep: the session we host ends and dark wakes refuse it; awake, the device that was connected is invited back.
  require('../shared/sleepwake.js').sleepWake({ powerMonitor: require('electron').powerMonitor, server: () => hostServer, discovery: () => discovery });
  discovery.on('invite', (d) => {
    // Connect on this computer in our host's list: back to it, taking the session over.
    // A phone connected here (or about to come back) goes first, as with Take over here: it would
    // keep us from connecting.
    if (guest.pairing && d && d.id === guest.pairing.macId) {
      discovery.clearInvite(d.id);
      const busy = !!(hostServer && (hostServer.current || hostServer.phoneHolds()));
      if (busy) hostServer.release();
      return void setTimeout(() => link.connect(true), busy ? 800 : 0);
    }
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
  link.setPlain(settings.files.plain === true); // Files › Encrypt file transfers
  startHost(guest);
  link.onState(() => {
    discovery.wantProbes = link.snapshot().link.state !== 'connected'; // probe every 10 s only while not connected
    pushState();
  });
  clip = new Clip(link, () => settings.clipboard, pushState, { popup: (kind, text) => hud && hud.show(kind, text), peerName });
  devctl = new DevCtl({ link, local: new DevLocal(), version: app.getVersion(), peerName, adb: () => {
    const br = phone && phone.bridge;
    return br && br.state === 'ready' && br.serial ? { adb: br.adb, serial: br.serial } : null;
  } });
  devctl.on('change', pushState);
  // ReZume off here (not loaded): still answer the other side's policy, so it shows ReZume as off
  // here, not missing, and offers nothing.
  link.on(P.T.RZ_POLICY, () => { if (!rezume) link.send({ t: P.T.RZ_POLICY, on: false, web: false, docs: false, apps: false, push: false }); });
  // The other side runs an older TwinDesk (shared/appinfo.js): say so once.
  devctl.on('outdated', (o) => {
    const { FEATURES } = require('../shared/appinfo.js');
    const title = o.version ? t('{name} has an older TwinDesk ({version})', { name: o.name || t('The other device'), version: o.version })
      : t('{name} has an older TwinDesk', { name: o.name || t('The other device') });
    const body = o.missing.length ? t('Update it there for: {features}', { features: o.missing.map((k) => t(FEATURES[k])).join(', ') })
      : t('Update it there: some features need the same version on both');
    try { new Notification({ title, body }).show(); } catch {}
  });
  const { Chats } = require('../shared/chats.js');
  chats = new Chats({ link, dir: app.getPath('userData'), want: () => settings.ui.chats === true, onChange: pushState });
  loadCamera(); // only while it's on
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
  loadMic();
  smb = new Smb({ link, settings, save: saveSettings, onChange: pushState });
  loadTerminal(); // only while it's on
  sshd = new Sshd({ link, settings, save: saveSettings, onChange: pushState });
  // The helper: X11 (XInput2 + XTest), or on Wayland its uinput backend when /dev/uinput is ours.
  helper = new Helper(() => system.inputBlocker(session));
  fileRecv = new FileRecv({ link, helper, settings, onChange: pushState });
  hud = new Hud(() => settings);
  const dragRecv = new DragRecv({ link, helper, settings, isDriven: () => kvm && kvm.mode === 'driven', popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  kvm = new Kvm({ link, helper, clip, fileDrop, fileRecv, dragRecv, settings, save: saveSettings, onChange: onKvmChange });
  kvm.laneReady.then(laneGo);
  require('../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
  // Popups: a {key, vars} is translated in the popup (hud-renderer.js) with the device names added;
  // English text with {me}/{name} (from modules not translated yet) gets the names filled in here.
  const hudShow = hud.show.bind(hud);
  const named = (v) => (v && typeof v === 'object' ? { ...v, vars: { me: (device && device.name) || t('This computer'), name: peerName(), Name: peerName(), ...(v.vars || {}) } } : fillNames(v || ''));
  hud.show = (kind, text, sub) => hudShow(kind, named(text), named(sub || '')); // device names in popups
  // Cursor sharing switched on/off (hotkey double-tap, tray, the Cursor tab or the other side): the big card.
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  kvm.onLinked = (on, here, ble) => {
    const name = link.snapshot().link.state === 'connected' ? peerName() : '';
    const key = t(P.hotkeyName(settings.keys.hotkey, 'win').replace('Windows key', 'Super'));
    const sub = !here && name ? { key: on ? 'Turned on on {name}' : 'Turned off on {name}', vars: { name } }
      : on ? { key: name ? 'With {name}. Double-tap {key} to turn it off' : 'Double-tap {key} to turn it off', vars: { name, key } }
        : { key: ble ? 'It comes back on Wi-Fi. Double-tap {key} to turn it on' : 'Double-tap {key} to turn it on', vars: { key } };
    hud.show(on ? 'linkOn' : 'linkOff', { key: on ? 'Cursor sharing on' : ble ? 'Cursor sharing off over Bluetooth' : 'Cursor sharing off' }, sub);
  };
  kvm.onWhere = (mode) => { // the switching popup
    const name = peerName();
    if (mode === 'driving') hud.show('away', { key: kvm.keyboardOnly ? 'Typing on {name}' : 'Using {name}', vars: { name } });
    else if (mode === 'driven') hud.show('driven', { key: '{name} is using {me}', vars: { name, me: device.name } });
    else hud.show('home', { key: 'Back on {me}', vars: { me: device.name } });
    if (phoneRemote) phoneRemote.refresh(); // the phone's Remote is taken only with the mouse at home
  };
  // Cursor lock: the popup goes where the pointer is (the other computer shows its own while we drive it).
  kvm.onLock = (on, mode) => {
    if (mode === 'driving' && !(kvm.local && kvm.local.drives())) return;
    const where = mode === 'driving' ? peerName() : device.name;
    hud.show('lock', { key: on ? 'Cursor locked on {name}' : 'Cursor unlocked', vars: { name: where } });
  };
  // Send files and drops show progress in the popup, like the PC.
  const pct = (n, total) => Math.min(99, Math.floor((n / total) * 100));
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
    const key = b.kind === 'paste'
      ? b.count === 1 ? 'Pasting {count} file from {name}' : 'Pasting {count} files from {name}'
      : b.count === 1 ? 'Receiving {count} file from {name}' : 'Receiving {count} files from {name}';
    const vars = { count: b.count, name: peerName(), percent: part };
    progressPopup('driven', { key: key + ' · {percent} %', vars });
    live.progress('recv', t(key, vars), t('From {name}', { name: peerName() }), part);
  };
  fileDrop.onBatchProgress = (b) => {
    if (!(b.bytes > 5 * 1024 * 1024)) return;
    const file = b.itemCount > 1 ? { key: '{count} items', vars: { count: b.itemCount } } : b.name;
    const label = b.itemCount > 1 ? t('{count} items', { count: b.itemCount }) : b.name;
    if (b.done) {
      live.done('send', b.ok ? t('Sent {file}', { file: label }) : t('Not everything arrived'), t('On {name}', { name: peerName() }));
      return progressPopup('away', { key: b.ok ? 'Sent {file} to {name}' : 'Not everything arrived on {name}', vars: { file, name: peerName() } }, true);
    }
    progressPopup('away', { key: 'Sending {file} to {name} · {percent} %', vars: { file, name: peerName(), percent: pct(b.sent, b.bytes) } });
    live.progress('send', t('Sending {file}', { file: label }), t('To {name}', { name: peerName() }), pct(b.sent, b.bytes));
  };
  link.on('closed', () => {
    live.done('recv', t('Files stopped'), t('{name} disconnected', { name: peerName() }));
    live.done('send', t('Files stopped'), t('{name} disconnected', { name: peerName() }));
  });
  fileRecv.onBatch = (b) => {
    live.done('recv', b.files ? t(b.files === 1 ? 'Received {count} file' : 'Received {count} files', { count: b.files }) : t('Nothing arrived'), t('From {name}', { name: peerName() }));
    if (rezume && rezume.received(b)) return; // a document taken here: it opens
    if (b.kind === 'paste') fileClip.pasted(b);
    else if (b.files) hud.show('driven', { key: b.files === 1 ? 'Received {count} file from {name}' : 'Received {count} files from {name}', vars: { count: b.files, name: peerName() } });
  };
  // Copy/paste files with shortcuts (the helper watches the keys), the file managers' Send to.
  fileClip = new FileClip({ link, helper, fileDrop, fileRecv, settings, peerName, popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  kvm.fileClip = fileClip; // our copy/paste shortcut while driving → fclip.key
  fileClip.kvm = kvm; // …also when the keyboard isn't shared
  sendTo = new SendTo({ link, fileDrop, peerName: () => (peerView() || {}).name || '', popup: (kind, text, sub) => hud.show(kind, text, sub) });
  notifs = new Notifs({ link, helper, settings, save: saveSettings, peerName, onChange: pushState });
  wake = new Wake({ link, settings, save: saveSettings, onChange: pushState, address: () => ownAddresses()[0] });
  const sender = new Sender(link);
  sender.codec = () => settings.pcScreen.codec; // Share screen › Encoder
  vdd = new Vdd({ onChange: pushState });
  pcScreen = new PcScreen({ link, helper, sender, vdd, settings, popup: (kind, text) => hud.show(kind, text), inputAllowed: () => kvm.mode === 'home', onChange: pushState , needDriver: () => goTab('pc-mac') });
  vdd.check(); // Extend: can this desktop add a virtual monitor? (and one left on by a crash goes)
  apps = new Apps({ link, allowed: () => settings.macApps.on, getLanguage: () => i18n.locale, getMonitor: () => screen.win, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState, onWatch: () => screen.policy() });
  screen.apps = apps;
  pcApps = new PcApps({ link, helper, sender, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  peerApps = new PeerApps({ link, settings, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState });
  // Apps › Move windows: a window grabbed with the move key crossed with the pointer. A
  // copy of the other computer's window goes home there (peerapps.js); one of this PC's goes over (pcapps.js).
  kvm.onMoveWindow = (m) => {
    const wid = Number(m.moving);
    if (!wid || peerApps.returnWindow(wid)) return;
    if (settings.pcApps.moveWindows) pcApps.moveOut(wid);
  };
  helper.on('exit', pushState);
  helper.on('ready', () => { sendScreens(); pushState(); });
  const { screen: displays } = require('electron');
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) displays.on(ev, sendScreens);
  setupNet(guest);
  helper.start();
  // New releases on GitHub: a notification once per version, the tray item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'linux', prefer: process.env.APPIMAGE || !app.isPackaged ? 'appimage' : 'deb', getSettings: () => settings, getLanguage: () => i18n.locale, save: saveSettings, onChange: pushState,
    onShowModal: showUpdateWindow,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      updateNote = new Notification({ title, body });
      updateNote.on('click', onClick);
      updateNote.show();
    },
  });
  updates.start();
  // TwinDesk Web (web.js): an iPhone's (or any browser's) own pages here, beside the one session.
  web = require('./web').setupWeb({ settings: () => settings, save: saveSettings, pushState, t, device: () => device, helper, smb, notifs, fileClip, vdd, pcScreen,
    kvm: () => kvm, devctl: () => devctl, loadVcam });
  const ipc = setupIpc({ devctl: () => devctl, chats: () => chats, qrPair: qrPairView, adbQr: adbQrDo, link, discovery, screen, clip, kvm, fileDrop, smb, fileClip, vdd, sound, pcScreen, notifs, wake, sshd, apps, pcApps, peerApps, updates, settings, save: saveSettings, push: pushState, buildState,
    get rezume() { return rezume; }, loadReZume,
    get phone() { return phone; }, get phoneViews() { return phoneViews; }, get camShare() { return camShare; }, get vcam() { return vcam; }, get phoneRemote() { return phoneRemote; }, get nowPlaying() { return nowPlaying; }, get btAudio() { return btAudio; }, get phoneDrive() { return phoneDrive; }, get terminal() { return terminal; }, loadRemote, setCamera, loadNowPlaying, loadBtAudio, loadMic, loadTerminal, connectPhoneDev, cancelPhoneInvite, hub: loadHub,
    get net() { return net; }, get wifi() { return wifi; }, applyNet, joinHotspot, openBluetoothSettings,
    checkFirewall, fixFirewall, fixInput, leaveInputGroup, removeInput, setStartup, onApp: () => updateTray(buildState()), onLanguage: changeLanguage, onLook: () => theme.setPref(settings.ui.theme) });
  pairSync = new PairSync({ link, settings, save: saveSettings, set: ipc.set }); // Two-way switches per pair
  nativeTheme.on('updated', pushState);
  loadReZume(); // only while it's on
  afterLane().then(() => link.start());
  link.on('welcome', () => { // a Mac app's launcher was used while the Mac wasn't connected
    if (pendingMacApp && Date.now() < pendingMacApp.until) openMacApp(pendingMacApp.id);
    pendingMacApp = null;
  });

  createTray();
  if (!startHidden) createMainWindow(); // in the tray: made when it's first opened
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

// The first session, either way, waits for the helper's input lane (kvm.laneReady), so it's native
// from the start: about 0.3 s at launch, at most LANE_WAIT_MS when the helper doesn't answer.
const LANE_WAIT_MS = 1500;
let laneGo;
const laneGate = new Promise((r) => (laneGo = r));
const afterLane = () => Promise.race([laneGate, new Promise((r) => setTimeout(r, LANE_WAIT_MS))]);

// Host role (L4): our own server, once the certificate exists (made on first start).
async function startHost(guest, tries = 0) {
  try {
    const id = await identity.load();
    await afterLane();
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
  pairing.isWired = (nonce) => wired.knows(nonce) || qrKnows(nonce); // the cable, or Connection's QR code (Allow only)
  pairing.isQr = qrKnows;
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
  phoneViews.vcam = vcam;
  phoneServer = pl;
  loadNowPlaying(); // each only while it's on
  loadBtAudio();
  // Remote off: its page hears so; on, PhoneRemote answers instead.
  pl.on(`t:${P.T.REMOTE_HELLO}`, () => !phoneRemote && pl.current && pl.current.os === P.OS.ANDROID
    && pl.sendToClient({ t: P.T.REMOTE_STATE, allowed: false, off: true, why: 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there' }));
  loadRemote();
  phoneViews.on('change', pushState);
  viaWifi(phoneViews, 'openScreen', 'phone');
  viaWifi(phoneViews, 'openApp', 'phone');
  // On Wi-Fi after Bluetooth, wireless debugging takes a moment more: the window opens once it's up.
  phoneViews.onNoAdb = (v) => {
    const c = pl.current;
    if (!c || c.os !== P.OS.ANDROID || !(c.transport === 'ble' || net.linked)) return false;
    pendingView = { ...v, until: Date.now() + 60 * 1000 };
    if (net.onBle) net.need('phone').then((ok) => !ok && (pendingView = null));
    else hud.show('home', { key: 'Opening it when wireless debugging is ready…' });
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
// Features loaded only while their switch is on: made (and applied) when it's first turned on.
// Audio › Media controls: what plays on the phone.
function loadNowPlaying() {
  if (nowPlaying || !phoneServer || settings.audio.phoneMedia === false) return nowPlaying;
  const { NowPlaying } = require('../shared/nowplaying.js');
  nowPlaying = new NowPlaying({ server: phoneServer, cfg: () => settings.audio });
  nowPlaying.on('change', pushState);
  nowPlaying.apply();
  return nowPlaying;
}

// Audio › Play phone sound here (Bluetooth): this computer as the phone's Bluetooth speaker (a2dp.js).
function loadBtAudio() {
  if (btAudio || !phoneServer || !settings.audio.phoneBt) return btAudio;
  const { BtAudio } = require('../shared/btaudio.js');
  const { LinuxA2dp } = require('./a2dp');
  btAudio = new BtAudio({ server: phoneServer, backend: new LinuxA2dp(), cfg: () => settings.audio, save: saveSettings });
  btAudio.on('change', pushState);
  btAudio.apply();
  return btAudio;
}

// Camera: the cameras of the two computers (shared/camshare.js; a phone's is phoneview.js
// openCamera), and the running one's picture to the tab and the virtual camera (shared/vcam.js).
// The virtual camera by itself: also for a web device's camera (TwinDesk Web).
function loadVcam() {
  if (vcam) return vcam;
  const { VirtualCam } = require('../shared/vcam.js');
  // On or off, the phone's Camera page says so (phone-bridge.js).
  vcam = new VirtualCam({ driver: require('./vcam'), cfg: () => settings.camera, save: saveSettings, onChange: pushState, onReady: () => phoneViews && phoneViews.bridge._tellPhone(), ui: () => mainWin });
  if (phoneViews) phoneViews.vcam = vcam; // the phone may have started first
  vcam.check();
  return vcam;
}

function loadCamera() {
  if (camShare || !settings.camera.on) return camShare;
  const { CamShare } = require('../shared/camshare.js');
  loadVcam();
  const computer = () => link.status.state === 'connected' && !(link.current && link.current.os === P.OS.ANDROID);
  camShare = new CamShare({
    getLanguage: () => i18n.locale,
    link: { on: (t, fn) => link.on(t, fn), send: (m) => link.send(m), connected: computer, ble: () => !!(link.current && link.current.transport === 'ble'), closed: (fn) => link.on('closed', fn) },
    cfg: () => settings.camera,
    save: saveSettings,
    popup: (kind, text, presentation) => hud && hud.show(kind, presentation || text),
    peerName,
    onChange: pushState,
  });
  camShare.sendPolicy(); // connected already: the other computer hears whether it's shared
  return camShare;
}

// Camera's switch: on loads it; off, whatever runs stops (the phone's camera too) and nothing is shared.
function setCamera(on) {
  settings.camera.on = !!on;
  saveSettings();
  if (on) loadCamera();
  else {
    if (camShare) {
      camShare.closeView();
      camShare.stopSending();
      camShare.sendPolicy();
    }
    if (phoneViews) for (const v of phoneViews.list()) if (v.kind === 'camera') phoneViews.close(v.id);
  }
  if (phoneViews) phoneViews.bridge._tellPhone();
  pushState();
}

// Remote: the phone's Remote page here (shared/phone-remote.js). Off, the page hears why (remote.state).
function loadRemote() {
  if (phoneRemote || !phoneServer || !settings.remote.allow) return phoneRemote;
  const { PhoneRemote } = require('../shared/phone-remote.js');
  phoneRemote = new PhoneRemote({ server: phoneServer, helper, getSettings: () => settings, atHome: () => !kvm || kvm.mode === 'home', onChange: pushState,
    loadPad: () => require('./gamepad'), save: saveSettings }); // Real gamepad: loaded when turned on
  phoneRemote.refresh(); // its page may be open already
  return phoneRemote;
}

// ReZume: what's in use here goes on on the other device, and theirs here (shared/rezume.js).
// Loaded the first time it's turned on: until then nothing is looked at.
function loadReZume() {
  if (rezume || !settings.rezume.on) return rezume;
  try { return loadReZumeNow(); } catch (e) { console.error('[rezume] couldn’t start: ' + (e && e.stack || e)); rezume = null; return null; }
}
function loadReZumeNow() {
  const { shell } = require('electron');
  const { ReZume } = require('../shared/rezume.js');
  const { ReZumeShelf } = require('../shared/rezume-shelf.js');
  rezumeAct = require('./activity').create({ helper });
  rezume = new ReZume({
    link: {
      on: (t, fn) => link.on(t, fn),
      send: (m) => link.send(m),
      peer: () => (link.status.state === 'connected' && link.current ? { os: link.current.os, name: peerName() } : null),
      welcome: (fn) => link.on('welcome', fn),
      closed: (fn) => link.on('closed', fn),
    },
    cfg: () => settings.rezume,
    detect: () => rezumeAct.detect(),
    appIcon: (a) => rezumeAct.appIcon(a),
    open: { url: (u) => shell.openExternal(u), file: (p) => shell.openPath(p), phoneApp: (pkg, name) => phoneViews && phoneViews.openApp(pkg, name) },
    sendFile: (p, batch) => !!fileDrop.sendBatch([p], 'rezume', batch),
    expectFile: (batch, dir) => fileRecv.expectBatch(batch, dir || receivedDir(settings, app.getPath('downloads')), 0, false),
    // Documents opened in place (shared/rzlive.js), the chooser (shared/rzpick.js), and where copies go.
    cacheDir: path.join(app.getPath('temp'), 'TwinDesk ReZume'),
    live: liveDocs(),
    pick: (o, ways) => require('../shared/rzpick.js').pick(o, ways, { peer: peerName(), language: i18n.locale }),
    adb: () => phoneAdb(phone && phone.bridge),
    phoneApps: () => (phone && phone.apps) || [],
    save: saveSettings,
    // An app's window between two computers: ours streamed there as the Apps tab's are (pcapps.js),
    // theirs shown here (peerapps.js; a Mac's come through apps.js, which takes them as they come).
    window: {
      canSend: () => !!(pcApps && pcApps.canAdopt),
      send: (app) => !!(pcApps && pcApps.adopt(app)),
      accept: (on) => {
        const set = () => { if (peerApps) peerApps.acceptReZume(on); return true; };
        return on ? waitWifi('apps', set) : set();
      },
      stop: (app) => pcApps && pcApps.unadopt(app),
    },
  });
  rezume.on('change', pushState);
  rezume.on('opened', (o) => hud && hud.show('home', { key: o.how === 'sent' ? 'Sent to {name}: {title}' : 'From {name}: {title}', vars: { name: peerName(), title: o.title } }));
  rezumeShelf = new ReZumeShelf({ rezume, cfg: () => settings.rezume, peerName, appIcon: path.join(__dirname, 'assets', 'icon.png') });
  rezume.apply();
  return rezume;
}

// ReZume's live documents: shared with the session's certificate, mounted as the phone drive is.
function liveDocs() {
  const { LiveShare } = require('../shared/rzlive.js');
  const ls = new LiveShare({ tls: () => hostServer && hostServer.tls, mounter: require('./phonedrive').mounter });
  return {
    share: (p) => ls.share(p),
    mount: (info) => waitWifi('folder', () => ls.mount(info), () => { throw new Error('The other computer could not be reached over Wi-Fi'); }),
    stop: () => ls.stop(),
    shutdown: () => ls.shutdown(),
  };
}

// The phone through wireless debugging, for ReZume: its app in front, and a tab opened there at once.
function phoneAdb(b) {
  if (!b || b.state !== 'ready' || !b.serial) return null;
  return {
    ready: true,
    front: async () => {
      const r = await b.adb.shell(b.serial, 'dumpsys activity activities | grep -m 1 -E "topResumedActivity|mResumedActivity"', { timeout: 4000 });
      const m = /\s([\w.]+)\/[\w.$]+/.exec(r.out || '');
      return m ? m[1] : '';
    },
    openUrl: (u) => b.adb.shell(b.serial, `am start -a android.intent.action.VIEW -d '${String(u).replace(/'/g, "'\\''")}'`, { timeout: 6000 }),
  };
}

// The tray's ReZume items: Continue the other side's, Send ours there.
function rezumeItems() {
  const h = rezume && settings.rezume.tray ? rezume.view : null;
  if (!h || !h.connected) return [];
  const cut = (t) => (t.length > 48 ? t.slice(0, 47) + '…' : t);
  const items = [];
  if (h.incoming) items.push({ label: t('Continue {title} from {name}', { title: cut(h.incoming.title || h.incoming.name || h.incoming.appName), name: peerName() }), click: () => rezume.take() });
  if (h.last && h.send) items.push({ label: t('Send {title} to {name}', { title: cut(h.last.title), name: peerName() }), click: () => rezume.push() });
  return items;
}

// What the Remote tab shows while Remote isn't loaded.
const REMOTE_OFF = { allow: false, why: '', opened: false, using: false, pad: { on: false, supported: true, live: false, busy: '', message: '', name: '' } };

// Terminal: a shell on the other computer.
function loadTerminal() {
  if (terminal || !settings.terminal.enabled) return terminal;
  const Terminal = require('./terminal');
  terminal = new Terminal({ link, settings, onChange: pushState });
  terminal.apply();
  return terminal;
}

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
    callwin.update(hub, { corner: 'top', open: goTab, getLanguage: () => i18n.locale });
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
  hud.show('home', { key: 'Moving to Wi-Fi with {name}…', vars: { name: peerName() } });
  net.need(why).then((ok) => {
    if (ok) return fn();
    hud.show('home', net.error || { key: 'Wi-Fi with {name} didn’t come up', vars: { name: peerName() } });
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
    if (hud) hud.show('home', { key: 'Opening it when {name} connects…', vars: { name: peerName() } });
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
    camera: camShare ? { ...camShare.state, on: !!settings.camera.on } : { on: false }, // on: the switch (off, it stays loaded but stopped)
    web: web ? web.view() : { cfg: { ...settings.web }, devices: [] }, // TwinDesk Web
    vcam: vcam ? vcam.view() : { checked: true, supported: true, on: false },
    remote: phoneRemote ? phoneRemote.view : phoneServer ? REMOTE_OFF : null,
    phoneMedia: nowPlaying ? nowPlaying.view : null,
    btAudio: btAudio ? btAudio.view : null,
    rezume: rezume ? rezume.view : { ...settings.rezume, connected: false }, // ReZume tab (shared/rezume.js)
    ui: settings.ui,
    look: Look.view(settings.ui, null), // Linux has no system accent colour to read
    app: settings.app,
    version: app.getVersion(),
    about: about || (about = aboutInfo(app)), // About page: this app and this computer
    updates: updates ? updates.view : null,
    firewall: fw,
    session: { ...session, input: helper.backend || '', access: session.type === 'wayland' ? system.inputAccess() : null, inputNote, helperError: helper.error || '' },
    audio: { ...settings.audio, ...sound.view(), mic: mic ? mic.view() : null },
    pcScreen: pcScreen.view(),
    files: { ...settings.files, ...fileDrop.view(), received: receivedDir(settings, app.getPath('downloads')), smb: smb.view(), incoming: fileRecv.view(), drag: kvm.dragRecv.view(), macDrags: kvm.peerDrags, clip: fileClip.view(), session: session.type },
    terminal: { ...settings.terminal, ...(terminal ? terminal.view() : { status: 'off', message: '', command: 'ssh twindesk' }), installedKey: undefined, server: sshd.view() },
    apps: link.peerOs === P.OS.MAC ? apps.view() : peerApps.view(), // a PC's or Linux computer's apps come through peerapps.js
    pcApps: pcApps.view(),
    macApps: settings.macApps,
    notifs: { ...settings.notifs, ...notifs.view() },
    chats: chats ? chats.view() : null, // Messages' WhatsApp, Instagram… conversations
    startup: autostart.get(),
    setup: { missing: miss, show: setupShows(miss) },
    phone: phone ? { ...phone.view, settings: settings.phone, ...phoneCtl() } : null,
    adbQr: adbQrState, // wireless debugging's pairing QR code (shared/ui-adbqr.js)
    peerCtl: link.peerOs !== P.OS.ANDROID && devctl ? devctl.view : null, // a computer's controls on Overview
    mount: { ...(phoneDrive ? phoneDrive.view : {}), on: settings.mount.on },
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    hub: hub ? hub.view : { ...settings.hub, connected: false },
    net: { ...(net ? net.view : {}), ...hotspotView(), side: wifi ? wifi.side : null, location: false, ble: settings.net.ble, blePc: settings.net.blePc, bleWifiOff: settings.net.bleWifiOff, bleOff, radio: bleHost ? bleHost.radio : bleGuest ? bleGuest.state : 'off', transport: link.current ? link.current.transport : '', lan: lanType(link.current && link.current.address) },
  };
}

// This computer's addresses: the one the other computer can reach first (Overview shows only that one).
// A phone's controls on Overview (dev.state): its quick settings, volume and ringer, most used apps.
function phoneCtl() {
  const v = devctl && link.peerOs === P.OS.ANDROID ? devctl.view : null;
  return v ? { ctl: v, qs: v.qs || null, top: v.top || [] } : { ctl: null, qs: null, top: [] };
}

// Connection › Pair a phone with a QR code (shared/ui-qrpair.js): this computer's id, name, addresses and
// port, and a nonce that pairs with Allow only, as the USB cable does; a new one every 10 minutes.
// Nearby and the code stay as they were.
let qrPair = null;
function qrPairView() {
  if (!qrPair || Date.now() > qrPair.until) qrPair = { nonce: crypto.randomBytes(8).toString('hex'), until: Date.now() + 10 * 60000 };
  const port = hostServer && hostServer.port;
  const addrs = ownAddresses().filter((a) => isIPv4(a)).slice(0, 4);
  if (!port || !addrs.length) return { url: '', why: !addrs.length ? 'No network' : 'Starting…' };
  const q = new URLSearchParams({ id: device.id, n: device.name, a: addrs.join(','), p: String(port), k: qrPair.nonce });
  return { url: 'twindesk://pair?' + q.toString(), until: qrPair.until };
}
// Connection › Wireless debugging › Pair with a QR code (shared/adbqr.js): on while shown.
let adbQr = null;
let adbQrState = null; // {text} | {done: 'paired' | 'timeout' | 'failed: …'}
function adbQrDo(on) {
  if (adbQr) { adbQr.stop(); adbQr = null; }
  adbQrState = null;
  if (on && phone && phone.bridge && phone.bridge.adb.available) {
    adbQr = startAdbQr({
      adb: phone.bridge.adb,
      onPaired: () => phone.bridge.pairedNow(),
      onEnd: (why) => { adbQr = null; adbQrState = { done: why }; pushState(); },
    });
    adbQrState = { text: adbQr.text };
  }
  pushState();
  return adbQrState;
}
const qrKnows = (nonce) => !!qrPair && typeof nonce === 'string' && nonce === qrPair.nonce && Date.now() < qrPair.until;

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

// Input access on Wayland (system.js, #144): the helper's own, never the user's.
async function fixInput() {
  try {
    await system.fixInput();
    inputNote = 'Done. Only the TwinDesk helper can read and control the mouse and keyboard.';
  } catch (e) {
    inputNote = 'Not fixed: ' + e.message;
  }
  helper.stop();
  helper.start(); // as its setgid copy now
  pushState();
}
async function leaveInputGroup() {
  try {
    await system.leaveInputGroup();
    inputNote = 'Done. Log out and back in once to finish.';
  } catch (e) {
    inputNote = 'Not changed: ' + e.message;
  }
  pushState();
}
async function removeInput() {
  try {
    await system.removeInput();
    inputNote = 'Removed. Log out and back in once to finish. Sharing the mouse and keyboard on Wayland needs Fix again.';
  } catch (e) {
    inputNote = 'Not removed: ' + e.message;
  }
  helper.stop();
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
    case 'connected': return t('Connected to {name}', { name: s.link.macName });
    case 'connecting': return t('Connecting…');
    case 'reconnecting': return s.link.busy || t('Reconnecting…');
    case 'stopped': return t('Disconnected');
    case 'identity_changed': return t('Pair again');
    default: return t('Not paired');
  }
}

// ---- windows and tray ----

// The main window exists only while it's open: closing it (to the tray) frees its page, about
// 50-100 MB; opening it again makes it anew (showMain).
function createMainWindow(tab) {
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
  mainWin.loadFile(path.join(__dirname, 'app.html'), { query: { language: i18n.locale } });
  const win = mainWin;
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (tab) win.webContents.send('go', tab);
    win.show();
    win.focus();
  };
  win.once('ready-to-show', show);
  // Hidden-window painting can stall; a loaded page can already be shown on our background.
  win.webContents.once('did-finish-load', show);
  for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, () => applyBle()); // Bluetooth looks only while it's open
  win.on('show', () => lookForPhones());
  // No tray on this desktop: closing quits (window-all-closed), or nothing would bring it back.
  win.on('close', () => saveBounds());
  win.on('closed', () => {
    if (mainWin === win) mainWin = null;
    applyBle();
  });
}

// Refresh only the settings window: active links, streams and native helpers keep running.
function changeLanguage() {
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  for (const player of BrowserWindow.getAllWindows()) {
    if (!player.isDestroyed()) player.webContents.send('ui-language', i18n.locale);
  }
  trayKey = '';
  updateTray(buildState());
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.loadFile(path.join(__dirname, 'app.html'), { query: { language: i18n.locale } });
  }
}

function saveBounds() {
  if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
  settings.windows.main = mainWin.getNormalBounds();
  saveSettings();
}

function goTab(tab) {
  if (!mainWin || mainWin.isDestroyed()) return void createMainWindow(tab); // goes there once loaded
  showMain();
  mainWin.webContents.send('go', tab);
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return void createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function showUpdateWindow() {
  showMain();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('show-update');
  }
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

// The tray menu, by kind (shared/traymenu.js) like the PC's. Rebuilt when what it shows
// changes (some Linux trays only take a new menu, not changes to the old one). A new menu redraws
// an open one (GNOME's top bar flickered, #100), so nothing that changes by itself is in it: the
// round trip (ms) is only in the tooltip, and that too is set only when it changes.
let trayKey = '';
let trayTip = '';
function updateTray(s) {
  if (!tray) return;
  const tip = 'TwinDesk: ' + statusLine(s);
  if (tip !== trayTip) { trayTip = tip; tray.setToolTip(tip); }
  const connected = s.link.state === 'connected';
  const name = connected && s.peer ? s.peer.name : '';
  const k = settings.kvm;
  const away = kvm.mode === 'driving' || kvm.mode === 'driven';
  const sharing = s.pcScreen.mode !== 'off';
  const watching = screen.sentAccept === true;
  const found = s.found.filter((d) => !s.peer || d.id !== s.peer.id);
  const host = s.paired && s.paired.macName;
  const again = !connected && host && (s.link.state === 'stopped' || !!s.link.busy);
  const key = JSON.stringify([name, again, away, pcApps ? pcApps.moved.size : 0, kvm.linked, kvm.paused, kvm.locked, kvm.mode, settings.keys.lockKeys, sharing, s.pcScreen.mode, watching, k.driveOther, k.beDriven, settings.clipboard.enabled,
    settings.audio.send, settings.app.hud, k.keyboard, settings.files.edgeDrag, settings.files.shortcuts, settings.files.copyKeys, rezumeItems().map((i) => i.label), found.map((d) => [d.id, d.name, d.os]), s.updates && s.updates.available && s.updates.latest]);
  if (key === trayKey) return;
  trayKey = key;
  const other = name || t('Other Computer');
  const set = (section, partial, after) => {
    if (!applySettings(settings, section, partial)) return;
    saveSettings();
    if (after) after();
    pushState();
  };
  const kind = (os) => (os === 'mac' ? 'Mac' : os === 'linux' ? 'Linux' : os === 'android' ? t('Phone') : 'PC');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu.template({
    t,
    connected,
    status: connected ? t('Connected to {name}', { name }) : t('Not connected'),
    home: away ? () => kvm.home() : null,
    windowsBack: pcApps && pcApps.moved.size ? { label: t(pcApps.moved.size === 1 ? 'Bring the Window Back from {name}' : 'Bring {count} Windows Back from {name}', { count: pcApps.moved.size, name: other }), click: () => pcApps.bringBack() } : null,
    shared: { checked: kvm.linked && !kvm.paused, set: (on) => kvm.setShared(on) },
    lock: connected ? { label: t('Lock Cursor on {name} ({keys})', { name: kvm.mode === 'driving' ? other : device.name, keys: CL.keysLabel(settings.keys.lockKeys, 'linux') }), checked: kvm.locked, set: (on) => kvm.setLocked(on) } : null,
    keyboard: { checked: k.keyboard, set: (on) => set('kvm', { keyboard: on }, () => kvm.applyConfig()) },
    drive: { label: t('Use Mouse and Keyboard on {name}', { name: other }), checked: k.driveOther, set: (on) => set('kvm', { driveOther: on }, () => kvm.applyConfig()) },
    driven: { label: t('Let {name} Control {me}', { name: other, me: device.name }), checked: k.beDriven, set: (on) => set('kvm', { beDriven: on }, () => kvm.applyConfig()) },
    popup: { checked: settings.app.hud, set: (on) => set('app', { hud: on }) },
    screen: [
      { label: t('Share Screen'), checked: sharing, set: (on) => pcScreen.setMode(on ? 'last' : 'off') }, // in the mode last picked here
      { label: t('Extend'), checked: pcScreen.mode === 'extend', set: (on) => (on ? pcScreen.extend() : pcScreen.setMode('off')) },
      { label: t('Mirror'), checked: pcScreen.mode === 'mirror', set: (on) => pcScreen.setMode(on ? 'mirror' : 'off') },
      { sep: true },
      // Opens/closes the screen window (opening starts the other computer's sharing).
      { label: t('Receive Screen'), checked: watching, set: (on) => (on ? screen.open(false) : screen.close()) },
    ],
    clipboard: { checked: settings.clipboard.enabled, set: (on) => set('clipboard', { enabled: on }, () => clip.applySettings()) },
    sound: { checked: settings.audio.send, set: (on) => set('audio', { send: on }, () => sound.apply()) },
    drag: { checked: settings.files.edgeDrag, set: (on) => set('files', { edgeDrag: on }, () => kvm.applyConfig()) },
    shortcuts: { label: t('Copy and Paste Files ({copy}, {paste})', { copy: CL.keysLabel(settings.files.copyKeys, 'linux'), paste: CL.keysLabel(settings.files.pasteKeys, 'linux') }), checked: settings.files.shortcuts, set: (on) => set('files', { shortcuts: on }, () => { kvm.applyConfig(); fileClip.apply(); }) },
    found: found.map((d) => ({ label: d.name + ' (' + kind(d.os) + ')', click: () => {
      if (d.os === P.OS.ANDROID) return connectPhoneDev(d);
      discovery.clearInvite(d.id);
      link.startPairing({ address: d.address, port: d.port, macName: d.name, id: d.id });
      showMain();
    } })),
    byAddress: () => goTab('overview'),
    lookAgain: () => discovery.probe(),
    again: again ? { label: s.link.busy ? t('Take Over {name}', { name: host }) : t('Connect to {name}', { name: host }), click: () => link.connect(true) } : null,
    disconnect: connected ? { label: t('Disconnect {name}', { name }), click: () => link.disconnect() } : null,
    update: s.updates && s.updates.available ? { label: t('Download TwinDesk {version}…', { version: s.updates.latest }), click: showUpdateWindow } : null,
    rezume: rezumeItems(),
    open: showMain,
    quit: () => app.quit(),
  })));
}

// Audio › Microphone: loaded the first time one of its switches is on (each change applies it).
function loadMic() {
  if (mic || !(settings.audio.micSend || settings.audio.micReceive)) return mic;
  const { Mic } = require('../shared/mic.js');
  mic = new Mic({ link, cfg: () => settings.audio, onChange: pushState });
  return mic;
}

app.on('before-quit', () => {
  if (web) web.shutdown();
  if (mic) mic.shutdown();
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
  if (rezumeShelf) rezumeShelf.shutdown();
  if (rezume) rezume.shutdown();
  if (rezumeAct) rezumeAct.stop();
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
