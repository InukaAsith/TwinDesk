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
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { PhoneViews } = require('./phoneview');
const setupIpc = require('./ipc');
const system = require('./system');
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
  device = loadDevice();
  settings = normalize(store.read('settings.json', {}));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
  discovery.on('invite', () => { pushState(); showMain(); }); // another computer wants to connect: Pair is focused
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
  kvm.onLinked = (on, here) => {
    const name = link.snapshot().link.state === 'connected' ? peerName() : '';
    const key = P.hotkeyName(settings.keys.hotkey, 'win').replace('Windows key', 'Super');
    const sub = !here && name ? 'Turned ' + (on ? 'on' : 'off') + ' on ' + name
      : on ? (name ? 'With ' + name + '. ' : '') + 'Double-tap ' + key + ' to turn it off' : 'Double-tap ' + key + ' to turn it on';
    hud.show(on ? 'linkOn' : 'linkOff', 'Cursor sharing ' + (on ? 'on' : 'off'), sub);
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
  fileRecv.onBatchProgress = (b) => {
    if (Date.now() - b.at < 400) return; // small batches: only the "Pasted" / "Received" popup
    const part = b.total ? pct(b.got, b.total) : pct(b.done, b.count);
    progressPopup('driven', (b.kind === 'paste' ? 'Pasting ' : 'Receiving ') + plural(b.count, 'file') + ' from ' + peerName() + ' · ' + part + ' %');
  };
  fileDrop.onBatchProgress = (b) => {
    if (!(b.bytes > 5 * 1024 * 1024)) return;
    if (b.done) return progressPopup('away', b.ok ? 'Sent ' + b.name + ' to ' + peerName() : 'Not everything arrived on ' + peerName(), true);
    progressPopup('away', 'Sending ' + b.name + ' to ' + peerName() + ' · ' + pct(b.sent, b.bytes) + ' %');
  };
  fileRecv.onBatch = (b) => {
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
    get phone() { return phone; }, get phoneViews() { return phoneViews; }, connectPhoneDev,
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
  phone.on('change', pushState);
  // The phone's Keyboard page names this computer's hotkey (double-tap = everything back here).
  pl.on('client', (ctx) => ctx.os === P.OS.ANDROID && pl.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_WIN, 'win').replace('Windows key', 'Super') }));
  phone.bridge = new PhoneBridge({ server: pl, phone, getSettings: () => settings, clipboard: clip });
  // A paired phone on a USB cable: the session, screen and sound through it (no Wi-Fi needed).
  wired = new Wired({ adb: phone.bridge.adb, raw: server, peer: pl, getId: () => device.id,
    hasPhone: () => pairing.list().some((x) => x.os === P.OS.ANDROID) });
  wired.on('change', pushState);
  phone.bridge.wired = wired;
  phone.wired = wired;
  phone.bridge.on('change', pushState);
  phone.bridge.on('popup', (kind, text) => hud.show(kind, text));
  phoneViews = new PhoneViews({ bridge: phone.bridge, phone, getSettings: () => settings, server: pl, fileSend: fileDrop });
  phoneViews.on('change', pushState);
  // A phone notification clicked here: its app in a window.
  notifs.onClick = (m) => pl.current && pl.current.os === P.OS.ANDROID && phoneViews.openNotified(m.app, m.appName);
  phoneViews.on('focus', () => kvm.applyConfig());
  kvm.local = phone.bridge; // driving a phone goes through adb
  kvm.blockEdge = () => phoneViews.focused; // moving inside the phone window never crosses
  pushState();
}

// A phone found nearby: a paired one is asked to connect, any other to pair with this computer.
function connectPhoneDev(d) {
  discovery.clearInvite(d.id);
  if (phone && link.pairing && link.pairing.list().some((p) => p.id === d.id)) phone.connect(d.id);
  else discovery.invite(d.address);
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
  return {
    device,
    ...link.snapshot(),
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
    case 'reconnecting': return 'Reconnecting…';
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
  const key = JSON.stringify([name, rtt, away, kvm.linked, sharing, watching, k.driveOther, k.beDriven, settings.clipboard.enabled,
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
    check('Cursor Sharing', kvm.linked, (i) => kvm.setLinked(i.checked)),
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
        link.startPairing({ address: d.address, port: d.port, macName: d.name });
        showMain();
      } })) : [{ label: 'Nobody nearby', enabled: false }]),
      { type: 'separator' },
      { label: 'Connect by Address…', click: () => goTab('overview') },
      { label: 'Look Again', click: () => discovery.probe() },
    ] },
    check('Show a Popup When Switching', settings.app.hud, (i) => set('app', { hud: i.checked })),
    { type: 'separator' },
    ...(s.updates && s.updates.available ? [{ label: (s.updates.canInstall ? 'Update to TwinDesk ' : 'Download TwinDesk ') + s.updates.latest + '…', click: () => updates.act() }] : []),
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
  desktopApps.shutdown();
  if (notifs) notifs.shutdown();
  if (phoneViews) phoneViews.shutdown();
  if (wired) wired.stop();
  if (phone) phone.bridge.adb.killServer();
  if (kvm) kvm.shutdown(); // gives back any captured input and stops the helper
  loopback.shutdown();
});

// Closing the main window only hides it while there is a tray; the app lives there until Quit.
app.on('window-all-closed', () => { if (!tray) app.quit(); });
