// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Main process with Multi-device on (docs/multi-device.md): ../main.js starts this file instead of its
// own code when multi.json says so. Lifecycle, windows, tray, IPC and the state pushed to the main
// window, as ../main.js, over the mesh (hub.js) instead of one peer. When a fix in ../main.js applies
// here too, make it in both.
const { lanType } = require('../../shared/lantype.js'); // Wi-Fi or Ethernet for Overview (#140)
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification, shell, globalShortcut, systemPreferences } = require('electron');
const { Updates } = require('../../shared/updates.js');
const { aboutInfo } = require('../../shared/about.js');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const P = require('../../shared/protocol.js');
const { receivedDir } = require('../../shared/received.js'); // General › Received files
const CL = require('../../shared/cursorlock.js');
const trayMenu = require('../../shared/traymenu.js');
const I18n = require('../../shared/i18n.js');
const Look = require('../../shared/look.js');
let i18n = I18n.create('en');
const t = (...args) => i18n.t(...args);
const store = require('../store');
const { Discovery, interfaces, isIPv4, ipToInt } = require('../discovery');
const { LinkManager } = require('./links');
const { Mesh } = require('../../shared/mesh.js');
const { Hub } = require('./hub');
const { Server } = require('./server');
const { Pairing: HostPairing } = require('./hostpair');
const identity = require('../identity');
const Screen = require('../screen');
const Clip = require('./clip');
const setupIpc = require('./ipc');
const Helper = require('./helper'); // Multi-device's helper (several watched sides), else the one-to-one one
const Kvm = require('./kvm');
const { AutoJoin } = require('./autojoin');
const LayoutSync = require('./layout-sync'); // the mesh's shared layout (docs/mesh.md)
const firewall = require('../firewall');
const Terminal = require('../terminal');
const FileDrop = require('../filedrop');
const Smb = require('../smb');
const Apps = require('../apps');
const Sound = require('../sound');
const FileRecv = require('../filerecv');
const DragRecv = require('../dragrecv');
const Sshd = require('../sshd');
const PcScreen = require('./pcscreen');
const { PcScreenSet } = require('./pcscreenset');
const PcApps = require('../pcapps');
const PeerApps = require('../peerapps');
const Sender = require('./sender');
const Vdd = require('../vdd');
const Hud = require('../hud');
const Notifs = require('./notifs');
const FileClip = require('../fclip');
const Wake = require('../wake');
const SendTo = require('../sendto');
const { PairSync } = require('../pairsync');
const { PhoneLink } = require('./phone-link');
const { Wired } = require('./wired');
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { PhoneSet } = require('./phones');
const { Explorer } = require('../explorer');
const { Adb } = require('../adb');
const { PhoneViews } = require('../phoneview');
const { PhoneDrive } = require('../phonedrive');
const { BleHost, BleGuest, BlePhones } = require('../../shared/blepipe.js');
const { wifiQuiet } = require('../../shared/blepolicy.js');
const { NetLink } = require('../../shared/netlink.js');
const { Wifi } = require('../wifi');
const { apply: applySettings, migrateKvm, load: loadSettings, save: storeSettings } = require('./settings');

// Packaged: electron-builder's appId is the shortcut's AppUserModelID. In development Windows
// only shows toasts for an id it knows, and electron.exe's path works.
// The Store's MSIX: the package's own app id (storepkg.js).
const Store = require('../storepkg');
const AUMID = Store.STORE ? Store.AUMID : app.isPackaged ? 'org.macshare.windows' : process.execPath;

// ../main.js has set the command-line switches (WebRTC) and the user data folder before handing over.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null); // its accelerators would steal keys meant for the Mac
  app.setAppUserModelId(AUMID); // toasts need it; the installer's shortcut carries the same id
  // A pinned Mac app starts "TwinDesk.exe --mac-app=<id>": open it, else show the window.
  // twindesk: links (a toast's Copy, Explorer's TwinDesk menu) come to this copy of TwinDesk.
  // The Store's MSIX declares twindesk: in its manifest; an NSIS install registers itself.
  if (Store.STORE) { /* the manifest's */ } else if (app.isPackaged) app.setAsDefaultProtocolClient('twindesk');
  else app.setAsDefaultProtocolClient('twindesk', process.execPath, [path.resolve(process.argv[1] || '.')]);
  app.on('second-instance', (_e, argv) => {
    if (openLink(argv)) return;
    if (sendTo && sendTo.handle(argv)) return; // Explorer › Send to
    if (!openMacAppArg(argv) && !openPhoneAppArg(argv)) showMain();
  });
  app.whenReady().then(start);
}

// twindesk:copy?code=… (a one-time code's Copy on a toast), twindesk:open?app=…&from=… (the toast
// itself: the app on the phone it came from), twindesk:go?tab=… (a page). True: it was one of them.
function openLink(argv) {
  if (explorer && explorer.handle(argv)) return true; // Explorer's TwinDesk › Import / Capture from phone
  const a = (argv || []).find((x) => /^twindesk:/i.test(String(x)));
  if (!a) return false;
  let u;
  try { u = new URL(a); } catch (_) { return true; }
  const q = u.searchParams;
  const what = u.pathname.replace(/^\/+/, '');
  if (what === 'copy' && /^\d{3,10}$/.test(q.get('code') || '')) {
    require('electron').clipboard.writeText(q.get('code'));
    if (hud) hud.show('clip', { key: 'Code copied' });
  } else if (what === 'open' && notifs && notifs.onClick && q.get('app')) {
    notifs.onClick({ app: q.get('app').slice(0, 200), appName: (q.get('name') || '').slice(0, 100), originId: (q.get('from') || '').slice(0, 200) || undefined });
  } else if (what === 'go' && q.get('tab')) {
    goTab(q.get('tab').slice(0, 30));
  }
  return true;
}

let explorer = null; // Explorer's right-click › TwinDesk (../explorer.js), for the active phone
let mainWin = null;
let tray = null;
let trayKey = '';
let trayLight = false; // the taskbar is light: black tray glyph
let hud = null;
let about = null; // shared/about.js, read once for the About page
let quitting = false;
let discovery = null;
let autoJoin = null; // autojoin.js: introduces devices to each other (docs/mesh.md)
let hub = null; // hub.js: every paired device (pooled features use its bus and mesh)
let iosNet = null; // shared/iosnet.js: iPhones on a USB cable
let links = null; // links.js: our guest links, one per host
let mesh = null; // shared/mesh.js: the device registry and roster
let link = null; // hub.facade: the SELECTED device, for every one-to-one feature
let devctl = null; // Overview's controls of the selected device (shared/devctl.js)
let chats = null; // Messages' chat apps from a phone, kept per phone (shared/chats.js)
let settings = null;
let device = null;
let web = null; // TwinDesk Web (../web.js), beside the mesh as in the one-to-one app
let screen = null;
let clip = null;
let helper = null;
let terminal = null;
let fileDrop = null;
let smb = null;
let apps = null;
let sound = null;
let mic = null; // Audio › Microphone (shared/mic.js), loaded only while one of its switches is on
let rezume = null; // ReZume (shared/rezume.js), only once it's turned on, and only with one phone (shared/rezume-solo.js)
let rezumeShelf = null; // … its notification and taskbar button (shared/rezume-shelf.js)
let rzSolo = null; // shared/rezume-solo.js: the phone while it is the only device connected
let camShare = null; // Camera tab: the selected computer's camera here, this one's there (shared/camshare.js)
let vcam = null; // Camera: the running camera's picture, to the tab and the virtual camera (shared/vcam.js, ../vcam.js)
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
let historyKeeper = null; // Clipboard and Notifications › History: kept encrypted when asked (shared/histkeeper.js)
let fileClip = null;
let sshd = null;
let kvm = null;
let lockKey = null; // the cursor lock key at home (shared/cursorlock.js)
let layoutSync = null; // layout-sync.js: where every paired device sits; the kvm's edges come from it
let wired = null; // wired.js, with the phone
let phoneRemote = null; // each phone's Remote page: touchpad, keyboard and gamepad here (shared/perphone.js phoneRemote)
let deck = null; // the Deck (shared/deck.js): each phone's (and web device's) buttons run here
let iosSign = null; // shared/iossign.js: TwinDesk iPhone, one iPhone at a time, as in the one-to-one app (shared/perphone.js anyPhone)
let modulesAtStart = []; // General › Modules: the ones off at start aren't loaded (fixed for this run)
let nowPlaying = null; // what plays on each phone, for the Overview's media controls (shared/perphone.js)
let btAudio = null; // the phone's sound here over Bluetooth (shared/btaudio.js), for the first phone
let phone = null; // A phone as the peer: phone.js (its .bridge: phone-bridge.js)
let phoneDrive = null; // its storage as a drive here (phonedrive.js), the first phone's
let bleHost = null; // Bluetooth, for devices not on this network: we host (blepipe.js)
let bleGuest = null; // … we connect to a host
let blePhones = null; // phones that advertise: we connect to them (a PC's Bluetooth often can't advertise)
let bleOff = false; // General's Turn off Bluetooth on Wi-Fi connections, in effect (bleQuiet)
const bleQuiet = wifiQuiet();
let net = null; // Wi-Fi for a session through Bluetooth (netlink.js)
let wifi = null; // this PC's Wi-Fi for it: hosting, joining (wifi.js)
let hostServer = null; // server.js, once the certificate exists
// (the screen and apps of a phone in windows here: phoneview.js, per phone, phone.views for the active one)
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
  settings = loadSettings(store); // settings.json and the mesh's own in multi.json (settings.js)
  modulesAtStart = require('../../shared/modules.js').normalize(settings.modules).off.filter((id) => id !== 'multi'); // the window's scripts are fixed at load
  require('../../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
  // Quiet links (#143): an idle session stops pinging every second; General › Advanced › Keep pinging.
  require('../../shared/quiet.js').use(() => !!(settings && settings.app && settings.app.keepPinging === true));
  require('../../shared/tailnet.js').use(() => !(settings && settings.net && settings.net.tailscale === false)); // General › Tailscale (#161)
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
  discovery.on('invite', () => { pushState(); showMain(); }); // a Mac wants to connect: Pair is focused
  discovery.start();

  // The mesh (docs/mesh.md): one guest link per paired host (links.js), the device registry (mesh),
  // and the hub that joins them to the host side (startHost attaches it) and to the features:
  // pooled ones (clipboard, notifications) use hub.bus, the one-to-one ones use `link`, the facade of
  // the selected device.
  links = new LinkManager({ device, resolveAddress: (macId) => discovery.get(macId) });
  mesh = new Mesh({ selfId: device.id });
  hub = new Hub({ device, links, mesh });
  rzSolo = require('../../shared/rezume-solo.js').soloLink({ bus: hub.bus, sessions: hub.sessions });
  // ReZume off here (not loaded): still answer the phone's policy, so it shows ReZume as off
  hub.bus.on(P.T.RZ_POLICY, (m, from) => { if (!rezume && from && from === rzSolo.id()) hub.bus.send(from, { t: P.T.RZ_POLICY, on: false, web: false, docs: false, apps: false, push: false }); });
  link = hub.facade;
  // Overview's controls of the selected device (a computer or a phone), and this computer's for it.
  const { DevCtl } = require('../../shared/devctl.js');
  const { DevLocal } = require('../../shared/devlocal.js');
  devctl = new DevCtl({ link, local: new DevLocal(), version: app.getVersion(), adb: () => {
    const br = phone && phone.bridge;
    return br && br.state === 'ready' && br.serial ? { adb: br.adb, serial: br.serial } : null;
  } });
  devctl.on('change', pushState);
  // The selected device runs an older TwinDesk (shared/appinfo.js): say so once.
  devctl.on('outdated', (o) => {
    const { FEATURES } = require('../../shared/appinfo.js');
    const title = o.version ? t('{name} has an older TwinDesk ({version})', { name: o.name || t('The other device'), version: o.version })
      : t('{name} has an older TwinDesk', { name: o.name || t('The other device') });
    const body = o.missing.length ? t('Update it there for: {features}', { features: o.missing.map((k) => t(FEATURES[k])).join(', ') })
      : t('Update it there: some features need the same version on both');
    try { new Notification({ title, body }).show(); } catch {}
  });
  const { Chats } = require('../../shared/chats.js');
  chats = new Chats({ link, dir: app.getPath('userData'), want: () => settings.ui.chats === true, onChange: pushState });
  hub.on('change', () => {
    discovery.wantProbes = link.snapshot().link.state !== 'connected'; // probe every 10 s only while not connected
    pushState();
  });
  startHost();
  autoJoin = new AutoJoin({ hub, enabled: () => settings.mesh.autoJoin !== false, addrs: () => ownAddresses() });
  clip = new Clip({ bus: hub.bus, mesh, getSettings: () => settings.clipboard, onChange: pushState, session: (id) => hub.sessions.get(id), popup: (kind, text) => hud && hud.show(kind, text) });
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
  fileDrop = new FileDrop({ link, settings, onProgress: (v) => { screen.sendDropProgress({ ...v, peerName: peerName() }); pushState(); } });
  screen.fileDrop = fileDrop;
  apps = new Apps({ link, allowed: () => settings.macApps.on, getLanguage: () => i18n.locale, getMonitor: () => screen.win, popup: (kind, text) => hud && hud.show(kind, text), peerName, onChange: pushState, onWatch: () => screen.policy() });
  screen.apps = apps;
  sound = new Sound({ link: hub.audioLink(), settings, onChange: pushState, meshHub: hub });
  loadMic();
  smb = new Smb({ link, settings, save: saveSettings, onChange: pushState });
  helper = new Helper();
  fileRecv = new FileRecv({ link, helper, settings, onChange: pushState });
  const dragRecv = new DragRecv({ link, helper, settings, isDriven: () => kvm && kvm.mode === 'driven', onChange: pushState });
  // Settings from before the cursor edges: one paired device takes the side its old pcSide gave it.
  if (migrateKvm(settings, hub.peers().map((p) => p.id))) saveSettings();
  // The shared layout: one map of the paired devices for the whole mesh (its own pool, docs/mesh.md).
  // The layout is drawn for the paired devices; a forgotten one leaves it.
  layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: device.id,
    storage: { get: () => settings.layout, set: (l) => { settings.layout = l; saveSettings(); } },
    knownIds: () => hub.peers({ indirect: true }).map((p) => p.id), // with those known through a peer: one map everywhere
    canDrive: (pid) => { const s = hub.sessions.get(pid); return !!s && s.connected; }, // the Multi-device tab's reach
    endsChain: (pid) => { const s = hub.sessions.get(pid); return !!s && P.isPhoneOs(s.peerOs); },
    legacyEdges: () => settings.kvm.edges, // settings from before the layout: once
    onChange: () => { if (kvm) kvm.layoutChanged(); pushState(); },
  });
  kvm = new Kvm({ hub, layoutSync, helper, clip, fileDrop, fileRecv, dragRecv, settings, save: saveSettings, onChange: onKvmChange });
  require('../../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
  hud = new Hud(() => settings);
  // Cursor sharing switched on/off (hotkey double-tap, tray, or the other computer): the big card.
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  kvm.onLinked = (on, here, ble) => {
    const p = peerView();
    const name = link.snapshot().link.state === 'connected' && p ? p.name : '';
    const key = P.hotkeyName(settings.keys.hotkey, 'win');
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
  };
  // Cursor lock: the popup goes where the pointer is (the device we drive shows its own).
  kvm.onLock = (on, mode) => {
    if (mode === 'driving' && !(kvm.local && kvm.local.drives(kvm.partner))) return;
    const where = mode === 'driving' ? peerName() : device.name;
    hud.show('lock', { key: on ? 'Cursor locked on {name}' : 'Cursor unlocked', vars: { name: where } });
  };
  // The lock key at home: a global shortcut, held while connected (pushState syncs it).
  lockKey = new CL.GlobalLockKey(globalShortcut, () => kvm.toggleLock());

  vdd = new Vdd({ helper, onChange: pushState });
  // Notifications both ways, Send files, copy/paste files with shortcuts
  notifs = new Notifs({
    bus: hub.bus, mesh, helper, settings, save: saveSettings, selfIds: [AUMID, 'org.macshare.windows'],
    peerName: (id) => ((mesh.get(id) || {}).name || ''), selfName: () => device.name, onChange: pushState,
  });
  fileClip = new FileClip({ link, helper, fileDrop, fileRecv, dragRecv, settings, peerName, popup: (kind, text) => hud.show(kind, text), onChange: pushState });
  // A paste Windows copies itself (dragrecv.js) — its files skip filerecv.js.
  fileRecv.claims = (m) => dragRecv._pasteOf(m);
  dragRecv.onPasted = (b) => fileClip.pasted(b);
  kvm.fileClip = fileClip; // Our copy/paste shortcut while driving → fclip.key
  fileClip.kvm = kvm; // …also when the keyboard isn't shared
  sendTo = new SendTo({ link, fileDrop, peerName: () => (peerView() || {}).name || '', popup: (kind, text, sub) => hud.show(kind, text, sub) });
  // Copy/paste and Send files show progress in the popup, like a drag. Receiving: every
  // batch that takes longer than a moment; sending: batches over 5 MB.
  const pct = (n, total) => Math.min(99, Math.floor((n / total) * 100));
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
    const key = b.kind === 'paste'
      ? b.count === 1 ? 'Pasting {count} file from {name}' : 'Pasting {count} files from {name}'
      : b.count === 1 ? 'Receiving {count} file from {name}' : 'Receiving {count} files from {name}';
    const vars = { count: b.count, name: peerName(), percent: part };
    progressPopup('driven', { key: key + ' · {percent} %', vars });
    liveToast('recv', t(key, vars), b.total ? b.got : b.done, b.total || b.count);
  };
  fileDrop.onBatchProgress = (b) => {
    if (!(b.bytes > 5 * 1024 * 1024)) return;
    const file = b.itemCount > 1 ? { key: '{count} items', vars: { count: b.itemCount } } : b.name;
    const label = b.itemCount > 1 ? t('{count} items', { count: b.itemCount }) : b.name;
    if (b.done) {
      liveDone('send', b.ok ? t('Sent {file}', { file: label }) : t('Not everything arrived'), t(b.ok ? 'On {name}' : 'On {name}: some files didn’t make it', { name: peerName() }));
      return progressPopup('away', { key: b.ok ? 'Sent {file} to {name}' : 'Not everything arrived on {name}', vars: { file, name: peerName() } }, true);
    }
    progressPopup('away', { key: 'Sending {file} to {name} · {percent} %', vars: { file, name: peerName(), percent: pct(b.sent, b.bytes) } });
    liveToast('send', t('Sending {file}', { file: label }), b.sent, b.bytes);
  };
  link.on('closed', () => {
    liveDone('recv', t('Files stopped'), t('{name} disconnected', { name: peerName() }));
    liveDone('send', t('Files stopped'), t('{name} disconnected', { name: peerName() }));
  });
  fileRecv.onBatch = (b) => {
    liveDone('recv', b.files ? t(b.files === 1 ? 'Received {count} file' : 'Received {count} files', { count: b.files }) : t('Nothing arrived'), b.files ? t('From {name}', { name: peerName() }) : '');
    if (b.kind === 'paste') fileClip.pasted(b);
    else if (b.files) hud.show('driven', { key: b.files === 1 ? 'Received {count} file from {name}' : 'Received {count} files from {name}', vars: { count: b.files, name: peerName() } });
  };
  wake = new Wake({ link, settings, save: saveSettings, onChange: pushState, address: () => ownAddresses()[0] }); // Wake over the network
  const sender = new Sender(link); // every rtc2 video session we send (screen, app windows)
  let senders = 0; // one per sharing target (a link of its own each), numbers far from the selected-device sender's
  pcScreen = new PcScreenSet({
    hub, model: PcScreen.displayModel, onChange: pushState,
    make: (scoped, extendFree) => {
      const pc = new PcScreen({ link: scoped, helper, sender: new Sender(scoped, 1000000 * ++senders), vdd, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState, needDriver: () => goTab('pc-mac') });
      pc.extendFree = extendFree;
      return pc;
    },
  });
  pcApps = new PcApps({ link, helper, sender, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  peerApps = new PeerApps({ link, settings, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState });
  // Apps › Move windows: a window grabbed with the move key crossed with the pointer. A
  // copy of the other computer's window goes home there (peerapps.js); one of this PC's goes over (pcapps.js).
  kvm.onMoveWindow = (m, to) => {
    const wid = Number(m.moving);
    if (to && to !== hub.selectedId) return; // apps and windows go to the selected device only
    if (!wid || peerApps.returnWindow(wid)) return;
    if (settings.pcApps.moveWindows) pcApps.moveOut(wid);
  };
  helper.on('exit', pushState);
  setupNet();
  helper.start();
  helper.once('ready', () => vdd.check()); // switches a virtual monitor left on by a crash off
  // New releases on GitHub: a notification once per version, the tray item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'win', store: Store.STORE, getSettings: () => settings, getLanguage: () => i18n.locale, save: saveSettings, onChange: pushState,
    isBusy: () => !!(hub && hub.bus && hub.bus.connectedIds().length), // Install automatically waits until no device is connected
    onShowModal: showUpdateWindow,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      updateNote = new Notification({ title, body });
      updateNote.on('click', onClick);
      updateNote.show();
    },
  });
  updates.start();
  // TwinDesk Web (../web.js): the same server and pairings as the one-to-one app (one userData).
  web = require('../web').setupWeb({ deck: (bus) => (loadDeck() ? deck.web(bus) : null), settings: () => settings, save: saveSettings, pushState, t, device: () => device, helper, smb, notifs, fileClip,
    kvm: () => kvm, devctl: () => devctl });
  historyKeeper = new (require('../../shared/histkeeper.js').HistoryKeeper)({ dir: app.getPath('userData'), clip, notifs, changed: pushState });
  loadCamera(); // only while it's on
  loadReZume(); // only while it's on
  const ipc = setupIpc({ history: (r) => historyKeeper && historyKeeper.act(r), clearFiles: () => { fileDrop.last = null; if (fileRecv) fileRecv.last = null; if (kvm && kvm.dragRecv) kvm.dragRecv.last = null; pushState(); }, // Files › Recent › Clear: only the list
    devctl: () => devctl, chats: () => chats, qrPair: qrPairView, adbQr: adbQrDo, explorer: () => explorer, hub, link, discovery, screen, clip, kvm, layoutSync, terminal, sshd, fileDrop, smb, apps, sound, pcScreen, pcApps, peerApps, vdd, notifs, fileClip, wake, updates, settings, save: saveSettings, push: pushState, buildState,
    get phone() { return phone; }, get phoneViews() { return phone ? phone.views : null; }, get camShare() { return camShare; }, iosSign: () => iosSign, deck: () => loadDeck(), get phoneRemote() { return phoneRemote && phoneRemote.loaded ? phoneRemote : null; }, loadRemote, get rezume() { return rezume; }, loadReZume, get vcam() { return vcam; }, setCamera, get phoneDrive() { return phoneDrive; }, get nowPlaying() { return nowPlaying; }, get btAudio() { return btAudio; }, loadNowPlaying: () => nowPlaying, loadBtAudio, connectPhoneDev, cancelPhoneInvite, phoneHub: loadHub, loadMic,
    get net() { return net; }, applyNet, joinHotspot, applyMesh: () => autoJoin && autoJoin.schedule(),
    checkFirewall, fixFirewall, setStartup, onApp: updateTray, onLanguage: changeLanguage, onLook: () => Look.applyTheme(nativeTheme, settings.ui.theme) });
  Look.applyTheme(nativeTheme, settings.ui.theme);
  pairSync = new PairSync({ link, settings, save: saveSettings, set: ipc.set, only: ['clipboard', 'notifs', 'apps', 'audio', 'cursor', 'terminal', 'files'],
    bus: hub.bus,
    peerRole: (id) => { const s = hub.sessions.get(id); return s ? s.role : null; },
    peerOs: (id) => { const s = hub.sessions.get(id); return s ? s.peerOs : null; } }); // Two-way switches per pair (no ReZume or Remote here)
  nativeTheme.on('updated', () => { checkTaskbar(); pushState(); });
  link.start();

  link.on('welcome', () => { // a pinned Mac app started while the Mac wasn't connected
    if (pendingMacApp && Date.now() < pendingMacApp.until) openMacApp(pendingMacApp.id);
    pendingMacApp = null;
  });
  createTray();
  createMainWindow();
  if (!openLink(process.argv) && !sendTo.handle(process.argv) && !openMacAppArg(process.argv)) openPhoneAppArg(process.argv);
  setTimeout(checkFirewall, 3000);
  if (process.argv.includes('--test-monitor')) screen.open(true); // dev: ?test=1 pattern
}

// Host role: our own server, once the certificate exists (made on first start). Until then the hub
// has its guest links only.
async function startHost() {
  try {
    const id = await identity.load();
    discovery.self.fp = id.fp; // beacons carry it now
    const server = new Server(id);
    discovery.self.port = server.port;
    const pairing = new HostPairing(server, { id: device.id, name: device.name, fp: id.fp });
    pairing.on('request', showMain); // a code to compare: bring the window up
    hub.attachHost(server, pairing);
    hostServer = server;
    bleHost = new BleHost({
      helper, server,
      info: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.WIN, port: server.port, fp: id.fp }),
      enabled: () => !bleOff && (settings.net.ble || settings.net.blePc),
      accept: (g) => (P.isPhoneOs(g.os) ? settings.net.ble : settings.net.blePc), // General's two Bluetooth switches
      // Quiet on Wi-Fi with an iPhone or iPad in the session or linked: its link stays (the helper's bleHold).
      hold: () => settings.net.ble && (iosNow() || bleHost.list().some((g) => g.os === P.OS.IOS)),
      // …but advertising until the iPhone or iPad in the session has linked (another device's link
      // kept it silent: an iPhone paired over Wi-Fi never found it, and fell back to nothing).
      holdAds: () => iosSessions().some((s) => !bleHost.list().some((g) => g.id === s.id)),
    });
    bleHost.on('change', pushState);
    discovery.extras.unshift(bleHost);
    blePhones = new BlePhones({ helper, server, hello: bleHost.info });
    blePhones.on('change', pushState);
    discovery.extras.push(blePhones);
    server.on('phoneFree', () => { for (const l of links.list()) l.poke(); pushState(); });
    startPhone(server, pairing);
  } catch (e) {
    console.error('[host]', e.message);
    hub.hostFailed('No certificate: ' + e.message);
  }
}

// A phone as the peer (port of the Mac's): the sidebar tile and Phone page (phone.js), its screen,
// touch, mouse, keyboard and clipboard through wireless debugging (phone-bridge.js), and its
// screen and apps in windows here (phoneview.js).
function startPhone(server, pairing) {
  const pl = new PhoneLink(hub, server);
  setupHub(pl);
  const adb = new Adb(); // one adb for every phone
  // A phone on a USB cable: pairing, the session, screen and sound through it (no Wi-Fi needed).
  wired = new Wired({ adb, raw: server, peer: pl, getId: () => device.id, getName: () => device.name,
    hasPhone: () => pairing.list().some((x) => P.isPhoneOs(x.os)) });
  pairing.isWired = (nonce) => wired.knows(nonce) || qrKnows(nonce); // the cable, or Connection's QR code (Allow only)
  pairing.isQr = qrKnows;
  pairing.consumeQr = () => { qrPair = null; }; // a QR pairing that went through: the link is single-use
  wired.on('change', pushState);
  // An iPhone's or iPad's session through its USB cable (shared/iosnet.js: usbmuxd to the app's port):
  // this server and the WebRTC relay (wired.js), nothing else.
  iosNet = new (require('../../shared/iosnet.js').IosNet)({
    getId: () => device.id, getName: () => device.name,
    allowed: (port) => port === server.port || port === wired.turnPort,
  });
  iosNet.on('change', () => { if (iosNet.view.devices.some((d) => d.app)) wired.relay(); pushState(); });
  // Every phone gets its own stack (phone.js, phone-bridge.js, phoneview.js) made on a link scoped to it
  // (phones.js); `phone` is also the single-phone API for the active one.
  // What plays on each phone (one shared/nowplaying.js per phone while Audio › Media controls is on),
  // and on this computer for each phone's Media page (shared/pcnow.js).
  nowPlaying = require('../../shared/perphone.js').phoneMedia({
    NowPlaying: require('../../shared/nowplaying.js').NowPlaying, cfg: () => settings.audio, onChange: pushState, phones: () => phone,
  });
  // Each phone's Remote page drives this computer (shared/phone-remote.js, one per phone), made once
  // Remote or Keyboard's voice typing is on; the Remote page shows the active phone's.
  phoneRemote = require('../../shared/perphone.js').phoneRemote({
    PhoneRemote: require('../../shared/phone-remote.js').PhoneRemote,
    opts: { helper, getSettings: () => settings, atHome: () => !kvm || kvm.mode === 'home', onChange: pushState, loadPad: () => require('../gamepad'), save: saveSettings },
    wanted: () => !!(settings.remote.allow || settings.kvm.keyboard),
    phones: () => phone,
  });
  // TwinDesk iPhone (shared/iossign.js): TwinDesk for iPhone signed with the person's Apple ID, for
  // whichever iPhone connected or spoke last. Off in General › Modules: not loaded.
  const anyPhone = require('../../shared/perphone.js').anyPhone({ want: (c) => c.os === P.OS.IOS }); // TwinDesk iPhone: one iPhone at a time
  if (!modulesAtStart.includes('iossign')) iosSign = require('../../shared/iossign-host.js').create({
    app, safeStorage: require('electron').safeStorage, link: anyPhone.link,
    near: { list: () => (bleHost ? bleHost.list() : []), invite: (devId) => bleHost && bleHost.invite(devId) }, // iPhones linked over Bluetooth
    usbSerials: () => (iosNet ? iosNet.view.devices.filter((x) => x.app).map((x) => x.serial) : []),
    onChange: pushState,
  });
  const { PcNow } = require('../../shared/pcnow.js');
  phone = new PhoneSet({
    hub, link: pl, raw: server, discovery, pairing, wired,
    make: (scoped) => {
      const ph = new Phone({ server: scoped, raw: server, discovery, pairing });
      const bridge = new PhoneBridge({ server: scoped, phone: ph, getSettings: () => settings, clipboard: clip, adb });
      ph.bridge = bridge;
      ph.wired = wired;
      bridge.wired = wired;
      const views = new PhoneViews({ bridge, phone: ph, getSettings: () => settings, server: scoped, fileSend: fileDrop });
      // On Wi-Fi after Bluetooth, wireless debugging takes a moment more: the window opens once it's up.
      views.onNoAdb = (v) => {
        const c = scoped.current;
        if (!c || c.os !== P.OS.ANDROID || !(c.transport === 'ble' || (net && net.linked))) return false;
        pendingView = { ...v, until: Date.now() + 60 * 1000 };
        if (net && net.onBle) net.need('phone').then((ok) => !ok && (pendingView = null));
        else hud.show('home', { key: 'Opening it when wireless debugging is ready…' });
        return true;
      };
      viaWifi(views, 'openScreen', 'phone');
      viaWifi(views, 'openApp', 'phone');
      return { phone: ph, bridge, views };
    },
    onUnit: (u) => {
      u.phone.on('change', pushState);
      if (vcam) u.views.vcam = vcam; // a phone's camera feeds the virtual camera too
      // The phone's Keyboard page names this PC's hotkey (double-tap = everything back here).
      u.link.on('client', (ctx) => u.link.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_WIN, 'win') }));
      u.bridge.on('save', saveSettings);
      u.bridge.on('change', () => {
        pushState();
        if (pendingView && u.bridge.serial) {
          const v = pendingView;
          pendingView = null;
          if (Date.now() < v.until) v.kind === 'app' ? u.views.openApp(v.app, v.title) : u.views.openScreen();
        }
        if (pendingPhoneApp && u.bridge.state === 'ready') {
          const p = pendingPhoneApp;
          pendingPhoneApp = null;
          if (Date.now() < p.until) openPhoneApp(p.pkg);
        }
      });
      u.bridge.on('popup', (kind, text) => hud.show(kind, text));
      u.views.on('change', pushState);
      u.views.on('focus', () => kvm.applyConfig());
      nowPlaying.unit(u);
      phoneRemote.unit(u);
      anyPhone.unit(u);
      if (loadDeck()) deck.add(u.link); // that phone's Deck runs here
      new PcNow({ server: u.link, key: (code) => {
        if (!helper) return;
        helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
        helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
      } });
    },
  });
  loadBtAudio();
  // A phone notification clicked here: its app in a window (on the phone it came from).
  notifs.onClick = (m) => {
    const u = phone.unit(m.originId);
    if (u && u.link.current) u.views.openNotified(m.app, m.appName);
  };
  // Explorer's right-click › TwinDesk: Send to phone, Import / Capture from phone (the active phone).
  explorer = new Explorer({
    phoneOn: () => { const c = phone.active.link.current; return !!(c && c.os === P.OS.ANDROID); },
    send: (m) => phone.active.link.sendToClient(m), on: (t, fn) => pl.on('t:' + t, fn),
    goTab, popup: (kind, text, sub) => hud && hud.show(kind, text, sub), onChange: pushState,
  });
  explorer.install();
  kvm.local = phone; // driving a phone goes through adb, by the partner: phone.drives(id) / handle(msg, id)
  kvm.blockEdge = () => phone.focused; // moving inside the phone window never crosses
  pushState();
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

// Calls, Messages, Photos and Files from a phone (shared/phonehub.js): loaded when a phone connects with
// one of them on, or the first time a page uses it. Before that none of it exists: no module, no
// listener, nothing sent to the phone. The call window (shared/callwin.js) only with a call.
let phoneHub = null;
let phoneLink = null; // phone-link.js, the phone's session (startPhone)
let callwin = null;
function setupHub(pl) {
  phoneLink = pl;
  const anyOn = () => settings.hub.calls || settings.hub.messages || settings.hub.media || settings.hub.files || settings.hub.shareServe;
  pl.on('client', (ctx) => P.isPhoneOs(ctx.os) && !phoneHub && anyOn() && loadHub());
  // The phone shares a folder: loaded for it (its listener comes with it, so this one passes it on).
  pl.on(`t:${P.T.SHARE_OFFER}`, (m, ctx) => ctx && P.isPhoneOs(ctx.os) && !phoneHub && loadHub().share && phoneHub.share.onOffer(m));
  pl.on(`t:${P.T.SHARE_SET}`, (m, ctx) => ctx && P.isPhoneOs(ctx.os) && !phoneHub && loadHub().share && phoneHub.share.act('serve', { on: !!m.serve }));
}

function loadHub() {
  if (phoneHub || !phoneLink) return phoneHub || { act() {} };
  const { PhoneHub } = require('../../shared/phonehub.js');
  phoneHub = new PhoneHub({
    server: phoneLink, getSettings: () => settings, save: saveSettings,
    // The calls' sound over Bluetooth; not in the Store's MSIX (Partner Center doesn't grant its phone line capabilities).
    audio: Store.STORE ? null : (opts) => require('../callaudio.js').create({ helper, ...opts }),
    audioLimit: Store.STORE ? '' : require('../callaudio.js').LIMIT,
    audioStore: Store.STORE,
    btSettings: () => shell.openExternal('ms-settings:bluetooth').catch(() => {}), // pairing the phone for the calls' sound
    shareSheet: (paths, title) => helper && helper.send('share', { paths, title }), // Photos › Share: Windows' Share (Share.cs)
    send: (paths, batch) => !!(fileDrop && fileDrop.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
    choose: () => require('electron').dialog.showOpenDialog(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, { properties: ['openFile', 'multiSelections'] }) // files only: with folders too it picks only folders here
      .then((r) => (r.canceled ? [] : r.filePaths)),
    share: { // shared folders with the phone (shared/foldershare.js)
      mounter: require('../phonedrive').mounter, adb: phone && phone.bridge.adb, serialOf: (id) => wired && wired.serialOf(id),
      chooseFolder: () => require('electron').dialog.showOpenDialog(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, { properties: ['openDirectory', 'createDirectory'] }).then((r) => (r.canceled ? '' : r.filePaths[0])),
      defaultFolder: path.join(os.homedir(), 'MacShare'),
      tls: () => hostServer && hostServer.tls, // served with the session's certificate, which the phone pinned
      wifi: (on) => (!net ? Promise.resolve(false) : on ? net.need('folder') : Promise.resolve(net.release('folder'))), // through Bluetooth
    },
  });
  phoneHub.on('change', pushState);
  phoneHub.on('data', (m) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send('hub', m));
  const popup = () => {
    if (!callwin && !phoneHub.call) return;
    callwin = callwin || require('../../shared/callwin.js');
    callwin.update(phoneHub, { corner: 'bottom', open: goTab, getLanguage: () => i18n.locale });
  };
  phoneHub.on('call', popup);
  phoneHub.on('change', popup);
  if (phoneLink.current && P.isPhoneOs(phoneLink.current.os)) phoneHub.started();
  return phoneHub;
}

// ---- not on the same network: Bluetooth, and Wi-Fi when it's needed ----

// The session through Bluetooth (blepipe.js) when the other device isn't on this network; files
// and screens move it onto a Wi-Fi network one side hosts (netlink.js). This PC hosts with Wi-Fi
// Direct (it keeps its own Wi-Fi) or joins the other side's (wifi.js). Nothing here runs with a
// device that doesn't know about it: those never come through Bluetooth. netsh refusing to join
// for want of Location opens its settings, once a run (the status says what to switch on).
function setupNet() {
  bleGuest = new BleGuest({ helper, hello: () => ({ id: device.id, name: device.name.slice(0, 40), os: P.OS.WIN }) });
  bleGuest.on('change', pushState);
  bleGuest.on('invite', () => { pushState(); showMain(); });
  links.setBle(bleGuest);
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
  hub.netHold = (m) => net.holdOut(m, (x) => link.sendNow(x)); // files wait for Wi-Fi (netlink.js)
  link.fx.active = () => net.touch('files'); // fast files on a link made for them keep it up, as file.chunk does
  hub.netTap = (m) => net.onMessage(m); // every message of the selected device (net.*)
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
    if (!(phone && phone.views && phone.views.list().length) && !pendingView) net.release('phone');
    if (!smb.drive && !smbWait) net.release('smb');
    applyQuiet(bleQuiet({ on: settings.net.bleWifiOff, current: () => link.current, onGroup: () => net.onGroup }));
    inviteIos();
    const near = link.snapshot().link.state !== 'connected' && !link.hosting && !bleOff;
    bleGuest.scan(near && settings.net.blePc); // looking for a host only while there's no session
    if (blePhones) blePhones.scan(near && settings.net.ble); // … and for phones
  }, 2000);
}

// iPhones and iPads in a session (their Bluetooth link is held through quiet: BleHost hold).
const iosSessions = () => (hub ? hub.sessions.list().filter((s) => s.connected && s.peerOs === P.OS.IOS) : []);
const iosNow = () => iosSessions().length > 0;

// An iPhone or iPad linked over Bluetooth but not in a session (it links only to computers it's
// paired with): invited now and then, which wakes TwinDesk there to come back (its Ble.swift).
let iosInvitedAt = 0;
function inviteIos() {
  if (!bleHost || bleOff || Date.now() - iosInvitedAt < 20000) return;
  const on = new Set(iosSessions().map((s) => s.id));
  for (const g of bleHost.list()) {
    if (g.os !== P.OS.IOS || on.has(g.id)) continue;
    iosInvitedAt = Date.now();
    bleHost.invite(g.id);
  }
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
  } else if (off && bleHost) bleHost.apply(); // an iPhone linked or gone while quiet: held or stopped
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
  if (phone && phone.connected && (phone.bridge.state === 'ready' || (net && net.onBle))) return phone.views.openApp(pkg, (phone.apps.find((a) => a.id === pkg) || {}).name);
  const first = !pendingPhoneApp;
  pendingPhoneApp = { pkg, until: (pendingPhoneApp && pendingPhoneApp.until) || Date.now() + 2 * 60 * 1000 };
  if (first && hud) hud.show('home', { key: 'Opening it when the phone is ready…' });
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
    if (hud) hud.show('home', { key: 'Opening it when {name} connects…', vars: { name: peerName() } });
  }
}

// ---- state ----

let pushQueued = false;
// Queued: one state push per tick. It never throws (an exception here became an Electron error
// dialog, or a window that stopped updating): a failure is logged and the next push tries again.
function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    try {
      const s = buildState();
      s.inviting = phoneInviteView(s);
      if (lockKey) {
        lockKey.sync(kvm.hub.bus.connectedIds().length > 0 ? settings.keys.lockKeys : '');
        s.kvmState.lockError = lockKey.error;
      }
      if (fileClip) fileClip.syncConnected(kvm.hub.bus.connectedIds().length > 0); // the file shortcuts too
      if (pcScreen) pcScreen.sendState(); // The viewer learns what we share
      if (sendTo) sendTo.sync(s.peer && s.peer.name);
      if (pairSync) pairSync.check(); // Tell the other computer what changed here // the Send to entry follows the peer's name
      // A pairing code to compare: bring the window to the front.
      const phase = s.pairing ? s.pairing.phase : null;
      if (phase === 'code' && lastPairPhase !== 'code') showMain();
      lastPairPhase = phase;
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s);
      updateTray(s);
    } catch (e) {
      console.error('[state] error', e && e.stack ? e.stack : e);
    }
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

// The selected device is a phone: its controls go with state.phone (as one to one).
function selectedIsPhone() {
  const p = peerView();
  return !!(p && P.isPhoneOs(p.os));
}
function meshPhoneCtl() {
  const v = devctl && selectedIsPhone() ? devctl.view : null;
  return v ? { ctl: v, qs: v.qs || null, top: v.top || [] } : { ctl: null, qs: null, top: [] };
}

// Audio › Play phone sound here (Bluetooth): this PC as the phone's Bluetooth speaker (A2dp.cs). A computer is one phone's
// speaker at a time: the first phone that connected here (PhoneSet's first stack).
function loadBtAudio() {
  if (btAudio || !phone || !settings.audio.phoneBt) return btAudio;
  const { BtAudio } = require('../../shared/btaudio.js');
  btAudio = new BtAudio({
    server: phone.first.link,
    backend: {
      list: async () => ((await helper.request('a2dpList', {}, 15000)).devices || []).map((d) => ({ id: String(d.id || ''), name: String(d.name || '') })),
      open: (id) => helper.request('a2dpOpen', { dev: id }, 40000),
      close: () => helper.request('a2dpClose'),
      on: (fn) => helper.on('event', (name, m) => name === 'a2dp.state' && fn(m.state)),
    },
    cfg: () => settings.audio,
    save: saveSettings,
  });
  btAudio.on('change', pushState);
  btAudio.apply();
  return btAudio;
}

// Connection › Pair a phone with a QR code (shared/ui-qrpair.js): this computer's id, name, addresses
// and port, and a nonce that pairs with Allow only, as the USB cable does; a new one every 10 minutes.
let qrPair = null;
function qrPairView() {
  if (!qrPair || Date.now() > qrPair.until) qrPair = { nonce: crypto.randomBytes(8).toString('hex'), until: Date.now() + 10 * 60000 };
  const port = hostServer && hostServer.port;
  const addrs = ownAddresses().filter((a) => isIPv4(a)).slice(0, 4);
  if (!port || !addrs.length) return { url: '', why: !addrs.length ? 'No network' : 'Starting…' };
  const q = new URLSearchParams({ id: device.id, n: device.name, a: addrs.join(','), p: String(port), k: qrPair.nonce });
  return { url: 'twindesk://pair?' + q.toString(), until: qrPair.until };
}
const qrKnows = (nonce) => !!qrPair && typeof nonce === 'string' && nonce === qrPair.nonce && Date.now() < qrPair.until;
// Connection › Wireless debugging › Pair with a QR code (shared/adbqr.js), for the active phone: on while shown.
let adbQr = null;
let adbQrState = null; // {text} | {done: 'paired' | 'timeout' | 'failed: …'}
function adbQrDo(on) {
  if (adbQr) { adbQr.stop(); adbQr = null; }
  adbQrState = null;
  const br = phone && phone.bridge;
  if (on && br && br.adb.available) {
    adbQr = require('../../shared/adbqr.js').startAdbQr({
      adb: br.adb,
      onPaired: () => br.pairedNow(),
      onEnd: (why) => { adbQr = null; adbQrState = { done: why }; pushState(); },
    });
    adbQrState = { text: adbQr.text };
  }
  pushState();
  return adbQrState;
}

// General › Advanced › Engines in use (shared/engines.js): the selected device's session.
function enginesView() {
  const s = hub && hub.selected;
  if (!link || !s || !s.connected) return null;
  return require('../../shared/engines.js').snapshot({
    current: link.current, il: s.il, lane: s.lane(), fx: link.fx, fx2: hub.sessions.fxShared.fx2 ? hub.sessions.fxShared.fx2.fx2 : null, net: net ? net.view : null,
    lan: lanType(link.current && link.current.address), screen: null,
  });
}

function buildState() {
  const miss = missing();
  return {
    device,
    ...link.snapshot(),
    peer: peerView(),
    // Every paired device (connected or not), and the mesh's selection and live links.
    peers: hub.peers({ indirect: true }),
    mesh: { selectedId: hub.selectedId, connectedIds: hub.bus.connectedIds(), autoJoin: settings.mesh.autoJoin !== false },
    found: discovery.list(),
    discovery: { ...discovery.status },
    addresses: ownAddresses(),
    stream: { ...screen.state, remote: screen.remote, watching: screen.sentAccept === true },
    wake: wake.view(),
    macInput: screen.macInput, // the Mac's "Receive input" switch
    input: kvm.mode,
    kvmState: kvm.view(),
    kvm: { ...settings.kvm },
    layout: layoutSync.state(), // the shared layout: { rev, by, cells (this device's view), grid, targets }
    keys: settings.keys,
    monitor: settings.monitor,
    clipboard: { ...settings.clipboard, ...clip.view },
    web: web ? web.view() : { cfg: { ...settings.web }, devices: [] }, // TwinDesk Web
    ui: settings.ui,
    look: Look.view(settings.ui, systemPreferences),
    app: settings.app,
    engines: enginesView(),
    encoder: require('../encoder').view(), // General › Advanced › Hardware encoder
    version: app.getVersion(),
    about: about || (about = aboutInfo(app)), // About page: this app and this computer
    updates: updates ? updates.view : null,
    firewall: fw,
    audio: { ...settings.audio, ...sound.view(), mic: mic ? mic.view() : null },
    pcScreen: pcScreen.view(),
    pcApps: pcApps.view(),
    macApps: settings.macApps,
    terminal: { ...settings.terminal, ...terminal.view(), installedKey: undefined, server: sshd.view() },
    files: { ...settings.files, importTo: explorer ? explorer.view : null, ...fileDrop.view(), received: receivedDir(settings, app.getPath('downloads')), smb: smb.view(), incoming: fileRecv.view(), drag: kvm.dragRecv.view(), macDrags: kvm.peerDrags, clip: fileClip.view() },
    notifs: { ...settings.notifs, ...notifs.view() },
    phoneMedia: nowPlaying ? nowPlaying.view : null,
    btAudio: btAudio ? btAudio.view : null,
    adbQr: adbQrState, // wireless debugging's pairing QR code (shared/ui-adbqr.js)
    history: historyKeeper ? historyKeeper.view() : null,
    modules: require('../../shared/modules.js').view(settings.modules, modulesAtStart), // General › Modules
    iosSign: iosSign ? iosSign.view : null, // TwinDesk iPhone
    deck: deck ? deck.view() : null, // the Deck page: shown while a device has a Deck
    remote: (phoneRemote && phoneRemote.view) || REMOTE_OFF, // Remote tab: the active phone's
    rezume: { ...(rezume ? rezume.view : { ...settings.rezume, connected: false }), mesh: rzSolo ? rzSolo.blocked() : '' }, // ReZume tab; mesh: why not here (one phone only)
    camera: camShare ? { ...camShare.state, on: !!settings.camera.on } : { on: false }, // on: the switch (off, it stays loaded but stopped)
    vcam: vcam ? vcam.view() : { checked: true, supported: true, on: false },
    chats: chats ? chats.view() : null, // Messages' WhatsApp, Instagram… conversations
    apps: link.peerOs !== P.OS.MAC ? peerApps.view() : apps.view(), // A PC's (or Linux computer's) apps come through peerapps.js
    startup: getStartup(),
    setup: { missing: miss, show: setupShows(miss) },
    phone: phone ? { ...phone.view, settings: settings.phone, ...meshPhoneCtl() } : null,
    peerCtl: devctl && !selectedIsPhone() ? devctl.view : null, // a computer's controls on Overview
    mount: { ...(phoneDrive ? phoneDrive.view : {}), on: settings.mount.on },
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    hub: phoneHub ? phoneHub.view : { ...settings.hub, connected: false },
    net: { ...(net ? net.view : {}), ...hotspotView(), location: !!wifi && wifi.refusedLocation, ble: settings.net.ble, blePc: settings.net.blePc, bleWifiOff: settings.net.bleWifiOff, bleOff, radio: bleHost ? bleHost.state : bleGuest ? bleGuest.state : 'off', transport: link.current ? link.current.transport : '', lan: lanType(link.current && link.current.address), tailscale: settings.net.tailscale !== false, tailnet: require('../../shared/tailnet.js').mine(), bleInput: settings.net.bleInput === true },
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
    if (phoneRemote) phoneRemote.refresh(); // the phones' Remote is taken only with the mouse at home
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
const loginItem = () => ({ path: Store.launcher(), args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });
function getStartup() {
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}
function setStartup(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginItem() });
  pushState();
}

function saveSettings() {
  storeSettings(store, settings);
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
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2b2e' : '#e9e9ee',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'app.html'), { query: { language: i18n.locale, off: modulesAtStart.join(',') } });
  const win = mainWin;
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!startHidden) win.show();
  };
  win.once('ready-to-show', show);
  // Match the ordinary window's fallback without revealing a start-to-tray launch.
  win.webContents.once('did-finish-load', show);
  mainWin.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

// A new language restarts TwinDesk: every window then loads English and that language only
// (shared/lang/pick.js), not every catalog. Settings are already saved (synchronously).
function changeLanguage() {
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') }); // the window shows
  app.quit();
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

function showUpdateWindow() {
  showMain();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('show-update');
  }
}

// Tray: the app mark's two screens, white on a dark
// taskbar and black on a light one. Its menu by kind (shared/traymenu.js); only connecting while
// nothing is connected.
function trayIcon() {
  const name = trayLight ? 'tray-black' : 'tray-white';
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name + '.png'));
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name + '@2x.png')).toPNG() });
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
  const key = JSON.stringify([name, rtt, again, away, pcApps ? pcApps.moved.size : 0, kvm.linked, kvm.paused, kvm.locked, kvm.mode, settings.keys.lockKeys, sharing, s.pcScreen.mode, watching, k.driveOther, k.beDriven, settings.clipboard.enabled,
    settings.audio.send, settings.app.hud, k.keyboard, settings.files.edgeDrag, settings.files.shortcuts, settings.files.copyKeys, found.map((d) => [d.id, d.name, d.os]), s.updates && s.updates.available && s.updates.latest]);
  if (key === trayKey) return;
  trayKey = key;
  const other = name || t('Other Computer');
  const set = (section, partial, after) => {
    if (!applySettings(settings, section, partial)) return;
    saveSettings();
    if (after) after();
    pushState();
  };
  const kind = (os) => (os === 'mac' ? 'Mac' : os === 'linux' ? 'Linux' : os === 'ios' ? 'iPhone' : os === 'android' ? t('Phone') : 'PC');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu.template({
    t,
    connected,
    status: connected ? t('Connected to {name}', { name }) + rtt : t('Not connected'),
    home: away ? () => kvm.home() : null,
    windowsBack: pcApps && pcApps.moved.size ? { label: t(pcApps.moved.size === 1 ? 'Bring the Window Back from {name}' : 'Bring {count} Windows Back from {name}', { count: pcApps.moved.size, name: other }), click: () => pcApps.bringBack() } : null,
    shared: { checked: kvm.linked && !kvm.paused, set: (on) => kvm.setShared(on) },
    lock: connected ? { label: t('Lock Cursor on {name} ({keys})', { name: kvm.mode === 'driving' ? other : device.name, keys: CL.keysLabel(settings.keys.lockKeys, 'win') }), checked: kvm.locked, set: (on) => kvm.setLocked(on) } : null,
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
    shortcuts: { label: t('Copy and Paste Files ({copy}, {paste})', { copy: CL.keysLabel(settings.files.copyKeys, 'win'), paste: CL.keysLabel(settings.files.pasteKeys, 'win') }), checked: settings.files.shortcuts, set: (on) => set('files', { shortcuts: on }, () => { kvm.applyConfig(); fileClip.apply(); }) },
    found: found.map((d) => ({ label: d.name + ' (' + kind(d.os) + ')', click: () => {
      if (P.isPhoneOs(d.os)) return connectPhoneDev(d);
      discovery.clearInvite(d.id);
      link.startPairing({ address: d.address, port: d.port, macName: d.name, id: d.id });
      showMain();
    } })),
    byAddress: () => goTab('connection'),
    lookAgain: () => discovery.probe(),
    update: s.updates && s.updates.available ? { label: t('Download TwinDesk {version}…', { version: s.updates.latest }), click: showUpdateWindow } : null,
    open: showMain,
    log: () => require('../../shared/applog.js').open(),
    quit: () => app.quit(),
  })));
}

// Audio › Microphone: loaded the first time one of its switches is on (each change applies it).
// Camera: the selected computer's camera here and this one's there (shared/camshare.js, over the
// hub's facade: the selected device), a phone's through its own stack (phoneview.js openCamera),
// and the running one's picture to the tab and the virtual camera (shared/vcam.js, ../vcam.js).
const tellPhones = () => { if (phone) for (const u of phone.all || []) u.bridge._tellPhone(); }; // each phone's Camera page says so
function loadVcam() {
  if (vcam) return vcam;
  const { VirtualCam } = require('../../shared/vcam.js');
  vcam = new VirtualCam({ driver: require('../vcam'), cfg: () => settings.camera, save: saveSettings, onChange: pushState, onReady: tellPhones, ui: () => mainWin });
  if (phone) for (const u of phone.all || []) u.views.vcam = vcam;
  vcam.check();
  return vcam;
}

function loadCamera() {
  if (camShare || !settings.camera.on) return camShare;
  const { CamShare } = require('../../shared/camshare.js');
  loadVcam();
  const computer = () => link.status.state === 'connected' && !(link.current && P.isPhoneOs(link.current.os));
  camShare = new CamShare({
    getLanguage: () => i18n.locale,
    link: { on: (t, fn) => link.on(t, fn), send: (m) => link.send(m), connected: computer, ble: () => !!(link.current && link.current.transport === 'ble'), closed: (fn) => link.on('closed', fn) },
    cfg: () => settings.camera,
    save: saveSettings,
    popup: (kind, text, presentation) => hud && hud.show(kind, presentation || text),
    peerName,
    onChange: pushState,
  });
  camShare.sendPolicy(); // connected already: the selected computer hears whether it's shared
  return camShare;
}

// Camera's switch: on loads it; off, whatever runs stops (every phone's camera too) and nothing is shared.
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
    if (phone) for (const u of phone.all || []) for (const v of u.views.list()) if (v.kind === 'camera') u.views.close(v.id);
  }
  tellPhones();
  pushState();
}

// ReZume (shared/rezume.js) between this computer and a phone, while that phone is the only device
// connected (shared/rezume-solo.js): between two computers it needs Multi-device off.
function loadReZume() {
  if (rezume || !settings.rezume.on) return rezume;
  try { return loadReZumeNow(); } catch (e) { console.error('[rezume] couldn’t start: ' + (e && e.stack || e)); rezume = null; return null; }
}
function loadReZumeNow() {
  const { shell } = require('electron');
  const { ReZume } = require('../../shared/rezume.js');
  const { ReZumeShelf } = require('../../shared/rezume-shelf.js');
  const { phoneAdb } = require('../../shared/rezume-solo.js');
  const act = require('../activity').create({ helper });
  const solo = () => (phone && rzSolo.id() ? phone.unit(rzSolo.id()) : null);
  const name = () => { const pr = rzSolo.link.peer(); return pr ? pr.name : 'the phone'; };
  rezume = new ReZume({
    link: rzSolo.link,
    cfg: () => settings.rezume,
    detect: () => act.detect(),
    appIcon: (exe) => (path.isAbsolute(exe) ? act.appIcon(exe) : ''),
    open: { url: (u) => shell.openExternal(u), file: (f) => shell.openPath(f), phoneApp: (pkg, n) => { const u = solo(); if (u) u.views.openApp(pkg, n || (u.phone.apps.find((a) => a.id === pkg) || {}).name); } },
    cacheDir: path.join(app.getPath('temp'), 'TwinDesk ReZume'),
    pick: (o, ways) => require('../../shared/rzpick.js').pick(o, ways, { peer: name(), language: i18n.locale }),
    adb: () => { const u = solo(); return phoneAdb(u && u.bridge); },
    phoneApps: () => { const u = solo(); return (u && u.phone.apps) || []; },
    save: saveSettings,
  });
  rezume.on('change', pushState);
  rezume.on('opened', (o) => hud && hud.show('home', { key: o.how === 'sent' ? 'Sent to {name}: {title}' : 'From {name}: {title}', vars: { name: name(), title: o.title } }));
  rezumeShelf = new ReZumeShelf({ rezume, cfg: () => settings.rezume, peerName: name, appIcon: path.join(__dirname, '..', 'assets', 'icon.png'), appId: 'org.macshare.windows.rezume' });
  rezume.apply();
  return rezume;
}

// Remote: made for every phone once it's turned on (or Keyboard's voice typing is).
const REMOTE_OFF = { allow: false, why: '', opened: false, using: false, pad: { on: false, supported: true, live: false, busy: '', message: '', name: '' } };
function loadRemote() {
  if (!phoneRemote || (!settings.remote.allow && !settings.kvm.keyboard)) return null;
  phoneRemote.load();
  return phoneRemote;
}

// The Deck (shared/deck.js): made once, then one per phone (deck.add) and per web device (deck.web).
// Not loaded at all while its module is off (General › Modules).
function loadDeck() {
  if (modulesAtStart.includes('deck')) return null;
  if (!deck) {
    const { clipboard: cb } = require('electron');
    deck = require('../../shared/deck.js').startDeck({
      platform: 'win', helper: () => helper, server: null, settings: () => settings, saveSettings,
      readClipboard: () => cb.readText(), onChange: pushState,
    });
  }
  return deck;
}

function loadMic() {
  if (mic || !(settings.audio.micSend || settings.audio.micReceive)) return mic;
  const { Mic } = require('../../shared/mic.js');
  mic = new Mic({ link: hub.audioLink(), cfg: () => settings.audio, onChange: pushState, meshHub: hub });
  return mic;
}

app.on('before-quit', () => {
  if (web) web.shutdown();
  if (mic) mic.shutdown();
  quitting = true;
  saveBounds();
  if (discovery) discovery.stop();
  if (pcScreen) pcScreen.shutdown();
  if (pcApps) pcApps.shutdown();
  if (peerApps) peerApps.shutdown();
  if (fileClip) fileClip.shutdown();
  if (phone) phone.shutdown();
  if (wired) wired.stop();
  if (devctl) devctl.stop();
  if (chats) chats.stop();
  if (phoneDrive) phoneDrive.shutdown();
  if (phone) phone.bridge.adb.killServer();
  if (phoneHub && phoneHub.audio) phoneHub.audio.stop(); // the phone's calls go back to it
  if (phoneHub && phoneHub.share) phoneHub.share.stop();
  if (callwin) callwin.close();
  if (kvm) kvm.shutdown(); // gives back any captured input and stops the helper
});

// Closing the main window only hides it; the app lives in the tray until Quit.
app.on('window-all-closed', () => {});
