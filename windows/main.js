// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process: lifecycle, windows, tray, IPC and the state pushed to the main window.
const { lanType } = require('../shared/lantype.js'); // Wi-Fi or Ethernet for Overview (#140)
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification, shell, globalShortcut, systemPreferences } = require('electron');
const Look = require('../shared/look.js');
const { Updates } = require('../shared/updates.js');
const { aboutInfo } = require('../shared/about.js');
const { execFile } = require('child_process');
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
const setupIpc = require('./ipc');
const Helper = require('./helper');
const Kvm = require('./kvm');
const firewall = require('./firewall');
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
const { Explorer } = require('./explorer');
const { DevCtl } = require('../shared/devctl.js');
const { DevLocal } = require('../shared/devlocal.js');
const { startAdbQr } = require('../shared/adbqr.js');
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
const { BleHost, BleGuest, BlePhones } = require('../shared/blepipe.js');
const { wifiQuiet } = require('../shared/blepolicy.js');
const { NetLink } = require('../shared/netlink.js');
const { Wifi } = require('./wifi');
const { normalize, apply: applySettings } = require('./settings');
const { TdWebServer } = require('../shared/tdweb.js');
const { TdPlayManager } = require('../shared/tdplay.js');

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
require('../shared/applog.js').start(app); // console.* and crashes into the log folder, both apps
require('./encoder').start(app); // General › Advanced › Hardware encoder (#133), both apps: a switch read at startup
// Screen share codec (shared/screencodec.js): H.265 available in WebRTC, so the
// Encoder setting works on the next share. One enable-features switch for the app: Chromium keeps only the last one.
{
  const codec = require('../shared/screencodec.js');
  const on = codec.features([]);
  if (on) app.commandLine.appendSwitch('enable-features', on);
}
// Multi-device switched on (multi.js, docs/multi-device.md): mesh/main.js runs instead of everything below.
if (require('./multi').on()) return void require('./mesh/main.js');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null); // its accelerators would steal keys meant for the Mac
  app.setAppUserModelId(AUMID); // toasts need it; the installer's shortcut carries the same id
  // A pinned Mac app starts "TwinDesk.exe --mac-app=<id>": open it, else show the window.
  // twindesk: links (a toast's Copy, Explorer's TwinDesk menu) come to this copy of TwinDesk.
  if (app.isPackaged) app.setAsDefaultProtocolClient('twindesk');
  else app.setAsDefaultProtocolClient('twindesk', process.execPath, [path.resolve(process.argv[1] || '.')]);
  app.on('second-instance', (_e, argv) => {
    if (openLink(argv)) return;
    if (sendTo && sendTo.handle(argv)) return; // Explorer › Send to
    if (!openMacAppArg(argv) && !openPhoneAppArg(argv)) showMain();
  });
  app.whenReady().then(start);
}

// twindesk:copy?code=… (a one-time code's Copy on a toast), twindesk:open?app=… (the toast itself:
// the app on the phone), twindesk:go?tab=… (a page). True: it was one of them.
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
    notifs.onClick({ app: q.get('app').slice(0, 200), appName: (q.get('name') || '').slice(0, 100) });
  } else if (what === 'go' && q.get('tab')) {
    goTab(q.get('tab').slice(0, 30));
  }
  return true;
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
let camShare = null; // Camera tab: the cameras of the two computers (shared/camshare.js)
let vcam = null; // Camera: the running camera's picture, to the tab and the virtual camera (shared/vcam.js, vcam.js)
let nowPlaying = null; // what plays on the phone, for the Overview's media controls (shared/nowplaying.js)
let btAudio = null; // the phone's sound here over Bluetooth (shared/btaudio.js)
let rezume = null; // ReZume (shared/rezume.js), only once it's turned on
let rezumeShelf = null; // … its notification and taskbar button (shared/rezume-shelf.js)
let helper = null;
let terminal = null; // only while Terminal is on (loadTerminal)
let phoneServer = null; // the phones' session (PhoneLink), for features loaded later
let fileDrop = null;
let smb = null;
let apps = null;
let sound = null;
let mic = null; // Audio › Microphone (shared/mic.js), loaded only while one of its switches is on
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
let explorer = null; // Explorer's right-click › TwinDesk (explorer.js)
let devctl = null; // Overview's controls of the other device, and this PC's for it (shared/devctl.js)
let chats = null; // Messages' chat apps from a phone, kept per phone (shared/chats.js)
let fileClip = null;
let sshd = null;
let kvm = null;
let lockKey = null; // the cursor lock key at home (shared/cursorlock.js)
let wired = null; // wired.js, with the phone
let hostServer = null; // server.js, once the certificate exists
let phone = null; // A phone as the peer: phone.js (its .bridge: phone-bridge.js)
let phoneViews = null; // its screen and apps in windows here (phoneview.js)
let phoneRemote = null; // its Remote page: touchpad, keyboard and gamepad here (shared/phone-remote.js)
let phoneDrive = null; // its storage as a drive here (phonedrive.js)
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
let tdweb = null;
let tdplay = null;

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
  require('../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));

  discovery = new Discovery(device);
  discovery.on('change', pushState);
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
  loadTerminal(); // only while it's on
  sshd = new Sshd({ link, settings, save: saveSettings, onChange: pushState });
  fileDrop = new FileDrop({ link, settings, onProgress: (v) => { screen.sendDropProgress({ ...v, peerName: peerName() }); pushState(); } });
  screen.fileDrop = fileDrop;
  apps = new Apps({ link, allowed: () => settings.macApps.on, getLanguage: () => i18n.locale, getMonitor: () => screen.win, popup: (kind, text) => hud && hud.show(kind, text), peerName, onChange: pushState, onWatch: () => screen.policy() });
  screen.apps = apps;
  sound = new Sound({ link, settings, onChange: pushState });
  loadMic();
  smb = new Smb({ link, settings, save: saveSettings, onChange: pushState });
  helper = new Helper();
  screen.helper = helper; // Wi-Fi low-latency mode while a screen is shown (Wlan.cs)
  clip.useHelper(helper); // its "clipboard" event: something was copied
  fileRecv = new FileRecv({ link, helper, settings, onChange: pushState });
  const dragRecv = new DragRecv({ link, helper, settings, isDriven: () => kvm && kvm.mode === 'driven', onChange: pushState });
  kvm = new Kvm({ link, helper, clip, fileDrop, fileRecv, dragRecv, settings, save: saveSettings, onChange: onKvmChange });
  kvm.laneReady.then(laneGo);
  require('../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
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
    if (phoneRemote) phoneRemote.refresh(); // the phone's Remote is taken only with the mouse at home
  };
  // Cursor lock: the popup goes where the pointer is (the other computer shows its own while we drive it).
  kvm.onLock = (on, mode) => {
    if (mode === 'driving' && !(kvm.local && kvm.local.drives())) return;
    const where = mode === 'driving' ? peerName() : device.name;
    hud.show('lock', { key: on ? 'Cursor locked on {name}' : 'Cursor unlocked', vars: { name: where } });
  };
  // The lock key at home: a global shortcut, held while connected (pushState syncs it).
  lockKey = new CL.GlobalLockKey(globalShortcut, () => kvm.toggleLock());

  vdd = new Vdd({ helper, onChange: pushState });
  // Notifications both ways, Send files, copy/paste files with shortcuts
  notifs = new Notifs({ link, helper, settings, save: saveSettings, selfIds: [AUMID, 'org.macshare.windows'], peerName, onChange: pushState });
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
    if (rezume && rezume.received(b)) return; // a document taken here: it opens
    if (b.kind === 'paste') fileClip.pasted(b);
    else if (b.files) hud.show('driven', { key: b.files === 1 ? 'Received {count} file from {name}' : 'Received {count} files from {name}', vars: { count: b.files, name: peerName() } });
  };
  wake = new Wake({ link, settings, save: saveSettings, onChange: pushState, address: () => ownAddresses()[0] }); // Wake over the network
  const sender = new Sender(link); // every rtc2 video session we send (screen, app windows)
  sender.codec = () => settings.pcScreen.codec; // Share screen › Encoder
  pcScreen = new PcScreen({ link, helper, sender, vdd, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState, needDriver: () => goTab('pc-mac') });
  pcApps = new PcApps({ link, helper, sender, settings, inputAllowed: () => kvm.mode === 'home', onChange: pushState });
  peerApps = new PeerApps({ link, settings, popup: (kind, text) => hud.show(kind, text), peerName, onChange: pushState });
  // Apps › Move windows: a window grabbed with the move key crossed with the pointer. A
  // copy of the other computer's window goes home there (peerapps.js); one of this PC's goes over (pcapps.js).
  kvm.onMoveWindow = (m) => {
    const wid = Number(m.moving);
    if (!wid || peerApps.returnWindow(wid)) return;
    if (settings.pcApps.moveWindows) pcApps.moveOut(wid, { x: Number(m.fromX), y: Number(m.fromY) });
  };
  helper.on('exit', pushState);
  setupNet(guest);
  helper.start();
  helper.once('ready', () => vdd.check()); // switches a virtual monitor left on by a crash off
  // New releases on GitHub: a notification once per version, the tray item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'win', getSettings: () => settings, getLanguage: () => i18n.locale, save: saveSettings, onChange: pushState,
    onShowModal: showUpdateWindow,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      updateNote = new Notification({ title, body });
      updateNote.on('click', onClick);
      updateNote.show();
    },
  });
  updates.start();
  const ipc = setupIpc({ devctl: () => devctl, chats: () => chats, explorer: () => explorer, qrPair: qrPairView, adbQr: adbQrDo, link, discovery, screen, clip, kvm, sshd, fileDrop, smb, apps, sound, pcScreen, pcApps, peerApps, vdd, notifs, fileClip, wake, updates, settings, save: saveSettings, push: pushState, buildState,
    get rezume() { return rezume; }, loadReZume,
    get phone() { return phone; }, get phoneViews() { return phoneViews; }, get camShare() { return camShare; }, get vcam() { return vcam; }, get phoneRemote() { return phoneRemote; }, get nowPlaying() { return nowPlaying; }, get btAudio() { return btAudio; }, get phoneDrive() { return phoneDrive; }, get terminal() { return terminal; }, loadRemote, setCamera, loadNowPlaying, loadBtAudio, loadMic, loadTerminal, connectPhoneDev, cancelPhoneInvite, hub: loadHub,
    get net() { return net; }, applyNet, joinHotspot, applyWeb, get tdweb() { return tdweb; },
    checkFirewall, fixFirewall, setStartup, onApp: updateTray, onLanguage: changeLanguage, onLook: () => Look.applyTheme(nativeTheme, settings.ui.theme) });
  Look.applyTheme(nativeTheme, settings.ui.theme);
  systemPreferences.on('accent-color-changed', () => pushState());
  pairSync = new PairSync({ link, settings, save: saveSettings, set: ipc.set }); // Two-way switches per pair
  nativeTheme.on('updated', () => { checkTaskbar(); pushState(); });
  loadReZume(); // only while it's on
  applyWeb(); // only while it's on
  afterLane().then(() => link.start());

  link.on('welcome', () => { // a pinned Mac app started while the Mac wasn't connected
    if (pendingMacApp && Date.now() < pendingMacApp.until) openMacApp(pendingMacApp.id);
    pendingMacApp = null;
  });
  createTray();
  if (!startHidden) createMainWindow(); // in the tray: made when it's first opened
  if (!openLink(process.argv) && !sendTo.handle(process.argv) && !openMacAppArg(process.argv)) openPhoneAppArg(process.argv);
  setTimeout(checkFirewall, 3000);
  if (process.argv.includes('--test-monitor')) screen.open(true); // dev: ?test=1 pattern
}

// The first session, either way, waits for the helper's input lane (kvm.laneReady), so it's native
// from the start: about 0.3 s at launch, at most LANE_WAIT_MS when the helper doesn't answer.
const LANE_WAIT_MS = 1500;
let laneGo;
const laneGate = new Promise((r) => (laneGo = r));
const afterLane = () => Promise.race([laneGate, new Promise((r) => setTimeout(r, LANE_WAIT_MS))]);

// Host role: our own server, once the certificate exists (made on first start).
async function startHost(guest) {
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
    if (pendingPhoneApp && phone.bridge.state === 'ready') {
      const p = pendingPhoneApp;
      pendingPhoneApp = null;
      if (Date.now() < p.until) openPhoneApp(p.pkg);
    }
  });
  phone.bridge.on('popup', (kind, text) => hud.show(kind, text));
  phoneViews = new PhoneViews({ bridge: phone.bridge, phone, getSettings: () => settings, server: pl, fileSend: fileDrop });
  phoneViews.vcam = vcam;
  phoneServer = pl;
  loadNowPlaying(); // each only while it's on
  loadBtAudio();
  phoneViews.on('change', pushState);
  // Remote off: its page hears so; on, PhoneRemote answers instead.
  pl.on(`t:${P.T.REMOTE_HELLO}`, () => !phoneRemote && pl.current && pl.current.os === P.OS.ANDROID
    && pl.sendToClient({ t: P.T.REMOTE_STATE, allowed: false, off: true, why: 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there' }));
  loadRemote();
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
  explorer = new Explorer({
    phoneOn: () => !!(pl.current && pl.current.os === P.OS.ANDROID), send: (m) => pl.sendToClient(m), on: (t, fn) => pl.on('t:' + t, fn),
    goTab, popup: (kind, text, sub) => hud && hud.show(kind, text, sub), onChange: pushState,
  });
  explorer.install();
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

// Audio › Play phone sound here (Bluetooth): this PC as the phone's Bluetooth speaker (A2dp.cs).
function loadBtAudio() {
  if (btAudio || !phoneServer || !settings.audio.phoneBt) return btAudio;
  const { BtAudio } = require('../shared/btaudio.js');
  btAudio = new BtAudio({
    server: phoneServer,
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

// Camera: the cameras of the two computers (shared/camshare.js; a phone's is phoneview.js
// openCamera), and the running one's picture to the tab and the virtual camera (shared/vcam.js).
function loadCamera() {
  if (camShare || !settings.camera.on) return camShare;
  const { CamShare } = require('../shared/camshare.js');
  const { VirtualCam } = require('../shared/vcam.js');
  // On or off, the phone's Camera page says so (phone-bridge.js).
  vcam = new VirtualCam({ driver: require('./vcam'), cfg: () => settings.camera, save: saveSettings, onChange: pushState, onReady: () => phoneViews && phoneViews.bridge._tellPhone(), ui: () => mainWin });
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
  if (phoneViews) phoneViews.vcam = vcam; // the phone may have started first
  vcam.check();
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
function applyWeb() {
  const w = settings.web || {};
  if (!w.enabled) {
    if (tdweb) { tdweb.stop(); tdweb = null; }
    if (tdplay) { tdplay.stop(); tdplay = null; }
    pushState();
    return;
  }

  if (w.portal) {
    if (!tdweb) {
      let creds = {};
      try { creds = identity.getCredentials ? identity.getCredentials() : {}; } catch (_) {}
      tdweb = new TdWebServer({
        getSettings: () => settings,
        getIdentity: () => ({ name: os.hostname() }),
        getClipboard: () => {
          try { return clipboard.readText(); } catch (_) { return ''; }
        },
        setClipboard: (text) => {
          try { clipboard.writeText(text); } catch (_) {}
        },
        getDownloadsDir: () => receivedDir(settings, app.getPath('downloads')),
        onInput: (_m) => {},
      });
      tdweb.on('file-received', (info) => {
        pushState();
        if (Notification.isSupported()) {
          new Notification({ title: 'TwinDesk Web', body: `Received ${info.name}` }).show();
        }
      });
      tdweb.on('client-connected', () => pushState());
      tdweb.on('client-disconnected', () => pushState());
      tdweb.on('devices-change', () => pushState());
      tdweb.on('chats-change', () => pushState());
      tdweb.on('dev-action', ({ action, value }) => {
        if (action === 'ring') {
          if (hud) hud.show('ring', 'Ringing this computer…');
        } else if (action === 'lock') {
          try { require('child_process').exec('rundll32.exe user32.dll,LockWorkStation'); } catch (_) {}
        }
      });
      tdweb.start({ port: w.port || 47802, credentials: creds });
    }
  } else if (tdweb) {
    tdweb.stop();
    tdweb = null;
  }

  if (w.airplay) {
    if (!tdplay) {
      tdplay = new TdPlayManager();
      tdplay.on('ready', () => pushState());
      tdplay.on('client', () => pushState());
      tdplay.on('mirror_start', () => {
        if (phoneViews) phoneViews.openScreen(true);
        pushState();
      });
      tdplay.on('mirror_stop', () => pushState());
      tdplay.on('video', (buf) => {
        if (phoneViews) {
          for (const v of phoneViews.views.values()) {
            if (v.kind === 'screen') {
              phoneViews._send(v, 'phoneview:video', { data: buf });
            }
          }
        }
      });
      tdplay.start({ name: `TwinDesk (${os.hostname()})`, port: 7000, mirrorPort: 7100 });
    }
  } else if (tdplay) {
    tdplay.stop();
    tdplay = null;
  }

  pushState();
}

function loadReZume() {
  if (rezume || !settings.rezume.on) return rezume;
  try { return loadReZumeNow(); } catch (e) { console.error('[rezume] couldn’t start: ' + (e && e.stack || e)); rezume = null; return null; }
}
function loadReZumeNow() {
  const { ReZume } = require('../shared/rezume.js');
  const { ReZumeShelf } = require('../shared/rezume-shelf.js');
  const act = require('./activity').create({ helper });
  rezume = new ReZume({
    link: {
      on: (t, fn) => link.on(t, fn),
      send: (m) => link.send(m),
      peer: () => (link.status.state === 'connected' && link.current ? { os: link.current.os, name: peerName() } : null),
      welcome: (fn) => link.on('welcome', fn),
      closed: (fn) => link.on('closed', fn),
    },
    cfg: () => settings.rezume,
    detect: () => act.detect(),
    appIcon: (exe) => (path.isAbsolute(exe) ? act.appIcon(exe) : ''),
    open: { url: (u) => shell.openExternal(u), file: (p) => shell.openPath(p), phoneApp: (pkg) => openPhoneApp(pkg) },
    sendFile: (p, batch) => !!fileDrop.sendBatch([p], 'rezume', batch),
    expectFile: (batch, dir) => fileRecv.expectBatch(batch, dir || receivedDir(settings, app.getPath('downloads')), 0, true),
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
      canSend: () => !!pcApps,
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
  rezumeShelf = new ReZumeShelf({ rezume, cfg: () => settings.rezume, peerName, appIcon: path.join(__dirname, 'assets', 'icon.png'), appId: 'org.macshare.windows.rezume' });
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
    callwin.update(hub, { corner: 'bottom', open: goTab, getLanguage: () => i18n.locale });
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
  pcScreen.setMode = (mode) => setMode(mode, mode !== 'off' && net.onBle ? () => waitWifi('share', () => true) : null);
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
  if (net.onBle) hud.show('home', { key: 'Moving to Wi-Fi with {name}…', vars: { name: peerName() } });
  return net.need(why).then((ok) => {
    if (ok) return fn();
    hud.show('home', net.error || { key: 'Wi-Fi with {name} didn’t come up', vars: { name: peerName() } });
    if (failed) failed();
    return false;
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
function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    const s = buildState();
    s.inviting = phoneInviteView(s);
    if (lockKey) {
      lockKey.sync(kvm.connected ? settings.keys.lockKeys : '');
      s.kvmState.lockError = lockKey.error;
    }
    if (fileClip) fileClip.syncConnected(kvm.connected); // the file shortcuts too
    if (pcScreen) pcScreen.sendState(); // The viewer learns what we share
    if (sendTo) sendTo.sync(s.peer && s.peer.name);
    if (pairSync) pairSync.check(); // Tell the other computer what changed here // the Send to entry follows the peer's name
    // A pairing code to compare: bring the window to the front.
    const phase = s.pairing ? s.pairing.phase : null;
    if (phase === 'code' && lastPairPhase !== 'code') showMain();
    lastPairPhase = phase;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s);
    if (tdweb && tdweb.running) {
      try { tdweb.notifyClipboard(clipboard.readText()); } catch (_) {}
    }
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
    clipboard: { ...settings.clipboard, ...clip.view },
    camera: camShare ? { ...camShare.state, on: !!settings.camera.on } : { on: false }, // on: the switch (off, it stays loaded but stopped)
    vcam: vcam ? vcam.view() : { checked: true, supported: true, on: false },
    remote: phoneRemote ? phoneRemote.view : phoneServer ? REMOTE_OFF : null,
    phoneMedia: nowPlaying ? nowPlaying.view : null,
    btAudio: btAudio ? btAudio.view : null,
    rezume: rezume ? rezume.view : { ...settings.rezume, connected: false }, // ReZume tab (shared/rezume.js)
    web: {
      ...settings.web,
      urls: tdweb && tdweb.running ? TdWebServer.getNetworkLinks(settings.web.port, tdweb.token) : null,
      pairCode: tdweb && tdweb.running ? tdweb.token : null,
      airplayActive: !!(tdplay && tdplay.running),
      airplayClient: tdplay ? tdplay.activeDevice : null,
    },
    webDevices: tdweb && tdweb.running ? tdweb.getDevices() : [],
    activeWebDevice: tdweb && tdweb.running ? tdweb.getActiveDevice() : null,
    webChats: tdweb && tdweb.running ? tdweb.getChats() : [],
    ui: settings.ui,
    look: Look.view(settings.ui, systemPreferences),
    app: settings.app,
    encoder: require('./encoder').view(), // General › Advanced › Hardware encoder
    version: app.getVersion(),
    about: about || (about = aboutInfo(app)), // About page: this app and this computer
    updates: updates ? updates.view : null,
    firewall: fw,
    audio: { ...settings.audio, ...sound.view(), mic: mic ? mic.view() : null },
    pcScreen: pcScreen.view(),
    pcApps: pcApps.view(),
    macApps: settings.macApps,
    terminal: { ...settings.terminal, ...(terminal ? terminal.view() : { status: 'off', message: '', command: 'ssh twindesk' }), installedKey: undefined, server: sshd.view() },
    files: { ...settings.files, importTo: explorer ? explorer.view : null, ...fileDrop.view(), received: receivedDir(settings, app.getPath('downloads')), smb: smb.view(), incoming: fileRecv.view(), drag: kvm.dragRecv.view(), macDrags: kvm.peerDrags, clip: fileClip.view() },
    notifs: { ...settings.notifs, ...notifs.view() },
    chats: chats ? chats.view() : null, // Messages' WhatsApp, Instagram… conversations
    apps: link.peerOs !== P.OS.MAC ? peerApps.view() : apps.view(), // A PC's (or Linux computer's) apps come through peerapps.js
    startup: getStartup(),
    setup: { missing: miss, show: setupShows(miss) },
    phone: phone ? { ...phone.view, settings: settings.phone, ...phoneCtl() } : null,
    adbQr: adbQrState, // wireless debugging's pairing QR code (shared/ui-adbqr.js)
    peerCtl: link.peerOs !== P.OS.ANDROID && devctl ? devctl.view : null, // a computer's controls on Overview
    mount: { ...(phoneDrive ? phoneDrive.view : {}), on: settings.mount.on },
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    hub: hub ? hub.view : { ...settings.hub, connected: false },
    net: { ...(net ? net.view : {}), ...hotspotView(), location: !!wifi && wifi.refusedLocation, ble: settings.net.ble, blePc: settings.net.blePc, bleWifiOff: settings.net.bleWifiOff, bleOff, radio: bleHost ? bleHost.state : bleGuest ? bleGuest.state : 'off', transport: link.current ? link.current.transport : '', lan: lanType(link.current && link.current.address) },
  };
}

// A phone's controls on Overview (dev.state): its quick settings, volume and ringer, most used apps.
function phoneCtl() {
  const v = devctl && link.peerOs === P.OS.ANDROID ? devctl.view : null;
  return v ? { ctl: v, qs: v.qs || null, top: v.top || [] } : { ctl: null, qs: null, top: [] };
}

// Connection › Pair a phone with a QR code (shared/ui-qrpair.js): this PC's id, name, addresses and
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
  win.on('close', () => saveBounds());
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
}

// Refresh only the settings window: active links, streams and native helpers keep running.
function changeLanguage() {
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  for (const player of BrowserWindow.getAllWindows()) {
    if (!player.isDestroyed()) player.webContents.send('ui-language', i18n.locale);
  }
  trayKey = '';
  updateTray();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.loadFile(path.join(__dirname, 'app.html'), { query: { language: i18n.locale } });
  }
}

function saveBounds() {
  if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
  settings.windows.main = mainWin.getNormalBounds();
  saveSettings();
}

// Show the window on one tab (tray items, popups).
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

// Tray: the app mark's two screens, white on a dark
// taskbar and black on a light one. Its menu by kind (shared/traymenu.js); only connecting while
// nothing is connected.
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
  const key = JSON.stringify([name, rtt, again, away, pcApps ? pcApps.moved.size : 0, kvm.linked, kvm.paused, kvm.locked, kvm.mode, settings.keys.lockKeys, sharing, s.pcScreen.mode, watching, k.driveOther, k.beDriven, settings.clipboard.enabled,
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
  if (mic) mic.shutdown();
  quitting = true;
  saveBounds();
  if (discovery) discovery.stop();
  if (pcScreen) pcScreen.shutdown();
  if (pcApps) pcApps.shutdown();
  if (peerApps) peerApps.shutdown();
  if (fileClip) fileClip.shutdown();
  if (phoneViews) phoneViews.shutdown();
  if (rezumeShelf) rezumeShelf.shutdown();
  if (rezume) rezume.shutdown();
  if (wired) wired.stop();
  if (devctl) devctl.stop();
  if (chats) chats.stop();
  if (phoneDrive) phoneDrive.shutdown();
  if (phone) phone.bridge.adb.killServer();
  if (hub && hub.audio) hub.audio.stop(); // the phone's calls go back to it
  if (hub && hub.share) hub.share.stop();
  if (callwin) callwin.close();
  if (kvm) kvm.shutdown(); // gives back any captured input and stops the helper
});

// Closing the main window only hides it; the app lives in the tray until Quit.
app.on('window-all-closed', () => {});
