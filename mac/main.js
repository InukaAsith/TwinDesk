// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process: lifecycle, windows, tray, IPC, and the state pushed to the control window.
//
// State object sent to the control window ('state' channel) on every change:
// {
//   macName, macId, fp,                       // this Mac's identity (fp = cert SHA-256 hex)
//   addresses: ['192.168.1.5', ...],           // this Mac's IPv4 addresses (the server listens on P.PORT)
//   discovery: { on, error, localNetwork },      // discovery.js status
//   found: [{ id, name, os, address, port, invited }],   // other TwinDesk computers nearby
//   guest: { status: {state, message}, pairing: null|{phase, name, address, code, error}, hosts: [...] },  // link.js
//   connect: { busy, message, error },           // last "Connect by address" / Pair attempt
//   serverError: null | 'message',            // e.g. port already in use
//   client: null | { id, name, os, role, address, rttMs },   // the session (peer.js); role 'host' = we are its guest
//   input: { where: 'home'|'driving'|'driven', message: '', tapError: null|'msg' },   // kvm.js
//   pairing: null | { name, code: null|'123456', confirmed, allowed },
//   paired: [{ id, name, pairedAt, lastSeen }],
//   permissions: { screen: 'granted'|'denied'|'not-determined'|..., accessibility: bool,
//                  inputMonitoring: null|bool },   // null = not checked yet (asked from the helper)
//   helper: { running: bool },
//   sharing: { on, displayId: null|id, bitrateMbps, streamMaxHeight (0 = native),
//              displays: [{ id, label, width, height, pixelWidth, pixelHeight, virtual, primary }],
//              targetId: null|id,                  // the display being shared now
//              virtual: { enabled, width, height, hiDPI, hz, active: bool, error: null|'msg' } },
//   displayMode: 'extend'|'mirror'|'custom',    // what Monitor 2 shows (Display tab)
//   streamInput: bool,                          // accept mouse/keyboard from Monitor 2
//   stream: { status, display, width, height, fps, mbps, encoder, codec, qp, ... },   // stream.js
//   kvm: settings.kvm, keys: settings.keys,     // Cursor / Keyboard tabs
//   clipboard: { ...settings.clipboard, peerAccepts, lastSkip,
//                history: [{ dir: 'out'|'in', at, size, text (preview) }] },
//   receive: { on, fullScreen, input, session, kind, status, stats, open },   // (pcview.js)
//   papps: { on, apps: [{id, name, icon}], listing, launch: {id: ''|'ok'|why}, windows: [{wid, id, title, live}] },   //
//   ui: { tab }, app: { openAtLogin, keepAwake },
//   wake: { womp, peers: {id: {name, os, at}}, last },   // (wake.js)
// }
'use strict';

let qrPair = null; // Connection's phone pairing QR code: {nonce, until}
let adbQr = null; // wireless debugging's pairing QR code while shown (shared/adbqr.js)
const qrKnows = (nonce) => !!qrPair && typeof nonce === 'string' && nonce === qrPair.nonce && Date.now() < qrPair.until;

const { lanType } = require('../shared/lantype.js'); // Wi-Fi or Ethernet for Overview (#140)
const { TdWebServer } = require('../shared/tdweb.js');
let tdweb = null;
const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, systemPreferences, Notification, dialog, globalShortcut } = require('electron');
const Look = require('../shared/look.js');

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// The hidden capture window plays system audio into WebRTC without any user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Every sent video frame says "show me now" (RTP playout delay 0/0): the lowest latency, whatever
// the viewer app does. A viewer in "Smooth" playback adds its own small buffer on top
// (jitterBufferTarget). FlexFEC repairs lost packets without waiting a round trip for a resend; it
// costs bandwidth only while packets are being lost.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/');
// Renamed to TwinDesk: settings, pairing and the identity stay in the old folder.
app.setPath('userData', process.env.MACSHARE_PROFILE || path.join(app.getPath('appData'), 'MacShare')); // PROFILE: a second dev copy
require('../shared/applog.js').start(app); // console.* and crashes into the log folder, both apps
// Screen share codec (shared/screencodec.js): H.265 available in WebRTC, so the
// Encoder setting works on the next share. One enable-features switch for the app: Chromium keeps only the last one.
{
  const codec = require('../shared/screencodec.js');
  const hub = require('./audiohub.js'); // the screen's sound captured by Chromium (macOS 14.2+)
  const on = codec.features(hub.loopback() ? hub.LOOPBACK_FEATURES : []);
  if (on) app.commandLine.appendSwitch('enable-features', on);
}
// Multi-device switched on (multi.js, docs/multi-device.md): mesh/main.js runs instead of everything below.
if (require('./multi').on()) return void require('./mesh/main.js');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const P = require('../shared/protocol.js');
const CL = require('../shared/cursorlock.js');
const trayMenu = require('../shared/traymenu.js');
const I18n = require('../shared/i18n.js');
let i18n = I18n.create('en');
const t = (...args) => i18n.t(...args);
const store = require('./store');
const identity = require('./identity');
const { Discovery, interfaces } = require('./discovery');
const { Link } = require('./link');
const { Peer } = require('./peer');
const { Server } = require('./server');
const { Pairing } = require('./pairing');
const { startServices } = require('./services');
const { setupIpc, TABS } = require('./ipc');
const login = require('./login');
const { Hud } = require('./hud');
const { PairSync } = require('./pairsync');
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { Wired } = require('./wired');
const { PhoneViews } = require('./phoneview');
const { PhoneDrive } = require('./phonedrive');
const { Updates } = require('../shared/updates.js');
const { BleHost, BleLook } = require('../shared/blepipe.js');
const { wifiQuiet } = require('../shared/blepolicy.js');
const { NetLink } = require('../shared/netlink.js');
const { aboutInfo } = require('../shared/about.js');

let win = null;
let tray = null;
let lockKey = null; // the cursor lock key at home (shared/cursorlock.js)
let hud = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden');
let settings, id, server, pairing, discovery, link, peer, svc, actions, pairSync, updates;
let phoneHub = null; // Calls, Messages and Photos (loadHub); svc.hub is the Mac's sound capture (audiohub.js)

const state = {
  macName: '',
  macId: '',
  fp: '',
  addresses: [],
  serverError: null,
  client: null,
  input: { where: 'home', message: '' },
  pairing: null,
  paired: [],
  permissions: { screen: 'unknown', accessibility: false, inputMonitoring: null },
  helper: { running: false },
  sharing: null,
  streamInput: true,
  stream: null,
  discovery: { on: false, error: '', localNetwork: true },
  found: [],
  guest: null,
  connect: { busy: false, message: '', error: false },
};

// A phone app kept in the Dock (phoneview.js pin): open it once the phone's wireless debugging is
// ready, connecting a paired phone nearby first if none is connected; tries for 2 minutes.
let pendingPhoneApp = null; // {pkg, until}
function openPhoneApp(pkg) {
  if (!/^[\w.]{1,200}$/.test(pkg)) return;
  const phone = svc.phone;
  if (phone.connected && (phone.bridge.state === 'ready' || svc.net.onBle)) { // through Bluetooth: Wi-Fi first (onNoAdb)
    pendingPhoneApp = null;
    return svc.phoneViews.openApp(pkg, (phone.apps.find((a) => a.id === pkg) || {}).name);
  }
  if (!pendingPhoneApp) hud.show('home', { key: 'Opening it when the phone is ready…' });
  pendingPhoneApp = { pkg, until: (pendingPhoneApp && pendingPhoneApp.until) || Date.now() + 2 * 60 * 1000 };
  clearTimeout(openPhoneApp.timer);
  if (Date.now() > pendingPhoneApp.until) return (pendingPhoneApp = null);
  if (!phone.connected && !phone.connecting) {
    const near = phone.nearby()[0];
    if (near) phone.connect(near.id);
  }
  openPhoneApp.timer = setTimeout(() => pendingPhoneApp && openPhoneApp(pendingPhoneApp.pkg), 2000);
}

// macshare://pc-app/<id> from a PC app's Dock icon / Launchpad entry. It can arrive
// before the services exist, so it waits in `linkQueue`.
let linkQueue = [];
function handleLink(url) {
  if (!svc) return linkQueue.push(url);
  if (/^macshare:\/\/send\b/.test(String(url))) return handleSendLink(String(url));
  const m = /^macshare:\/\/pc-app\/(.+)$/.exec(String(url));
  if (!m) return;
  const id = decodeURIComponent(m[1]).slice(0, 1024);
  if (id.startsWith('phone:')) return openPhoneApp(id.slice(6));
  if (!settings.papps.on) actions.setPcApps({ on: true });
  svc.pcApps.openFromLink(id);
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleLink(url);
});

let defaultIf = '';
function readDefaultIf() {
  require('child_process').execFile('/sbin/route', ['-n', 'get', 'default'], (err, out) => {
    const m = !err && /interface:\s*(\S+)/.exec(out);
    const name = m ? m[1] : '';
    if (name !== defaultIf) {
      defaultIf = name;
      pushState();
    }
  });
}

let pushQueued = false;
function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    // The address the other computer can reach, first (the UI shows only this one):
    // on the peer's network, then real adapters (en*), the default route, VPN tunnels and bridges last.
    const peerNet = String((peer && peer.current && peer.current.address) || '').replace(/^::ffff:/, '').split('.').slice(0, 3).join('.');
    const rank = (i) => (peerNet && i.address.startsWith(`${peerNet}.`) ? 0 : /^en\d/.test(i.name) ? 1
      : /^(utun|bridge|vmnet|vnic|llw|awdl)/.test(i.name) ? 4 : i.name === defaultIf ? 2 : 3);
    state.addresses = interfaces().sort((a, b) => rank(a) - rank(b)).map((i) => i.address);
    state.pairing = pairing ? pairing.pendingView() : null;
    state.paired = pairing ? pairing.list() : [];
    if (discovery) {
      state.discovery = { ...discovery.status };
      state.found = discovery.list();
    }
    if (link) state.guest = link.view();
    const c = peer && peer.current;
    state.client = c ? { id: c.deviceId, name: c.name, os: c.os, role: c.role, address: c.address, rttMs: c.rttMs, transport: c.transport || 'ip' } : null;
    if (svc && svc.net) {
      const hs = c && settings.net.hotspots[c.deviceId];
      state.net = { ...svc.net.view, ble: settings.net.ble !== false, blePc: settings.net.blePc === true, bleWifiOff: settings.net.bleWifiOff !== false, bleOff, radio: svc.ble.state, hotspotSsid: hs ? hs.ssid : '', hotspotSaved: !!(hs && hs.pass), lan: lanType(c && c.address) };
    }
    const { helper, displays, stream, clipboard: clip, kvm } = svc || {};
    state.helper.running = !!(helper && helper.running);
    if (displays) {
      const target = displays.target();
      state.sharing = {
        on: !!settings.sharing.on,
        audio: !!settings.sharing.audio,
        remote: settings.sharing.remote !== false,
        pace: settings.sharing.pace || 'fast',
        codec: settings.sharing.codec || 'h264', // Encoder (shared/screencodec.js)
        displayId: settings.sharing.displayId,
        bitrateMbps: settings.bitrateMbps,
        streamMaxHeight: settings.streamMaxHeight,
        displays: displays.list(),
        targetId: target ? target.id : null,
        virtual: { ...settings.virtual, active: displays.virtualId !== null, error: displays.virtualError },
      };
    }
    if (stream) {
      state.stream = stream.view;
      state.audio = { ...settings.audio, ...svc.audio.view, screen: stream.audio, mic: svc.mic ? svc.mic.view() : null };
    }
    state.streamInput = settings.streamInput !== false;
    state.displayMode = displayMode();
    state.kvm = settings.kvm;
    state.keys = settings.keys;
    state.clipboard = clip ? { ...settings.clipboard, ...clip.view } : null;
    // on: the switch (turned off, CamShare stays loaded but stopped).
    state.camera = svc && svc.camShare ? { ...svc.camShare.state, on: settings.camera.on !== false } : svc ? { on: false } : null;
    state.vcam = svc && svc.vcam ? svc.vcam.view() : svc ? { checked: true, supported: true, on: false } : null;
    state.rezume = svc && svc.rz ? svc.rz.view : svc ? { ...settings.rezume, connected: false } : null; // ReZume tab (shared/rezume.js)
    state.web = {
      ...settings.web,
      urls: tdweb && tdweb.running ? TdWebServer.getNetworkLinks(settings.web.port, tdweb.token) : null,
      pairCode: tdweb && tdweb.running ? tdweb.token : null,
      airplayActive: false,
    };
    state.webDevices = tdweb && tdweb.running ? tdweb.getDevices() : [];
    state.activeWebDevice = tdweb && tdweb.running ? tdweb.getActiveDevice() : null;
    state.webChats = tdweb && tdweb.running ? tdweb.getChats() : [];
    state.remote = svc && svc.phoneRemote ? svc.phoneRemote.view
      : svc ? { allow: false, why: '', opened: false, using: false, pad: { on: false, supported: false, live: false, busy: '', message: '', name: '' } } : null;
    state.phoneMedia = svc && svc.nowPlaying ? svc.nowPlaying.view : null;
    state.btAudio = null; // macOS can't be a phone's Bluetooth speaker
    state.ui = settings.ui;
    state.look = Look.view(settings.ui, systemPreferences); // General › Appearance
    state.app = settings.app;
    if (kvm) state.input = kvm.view;
    if (kvm && lockKey) {
      lockKey.sync(kvm.server.current ? settings.keys.lockKeys : '');
      state.input.lockError = lockKey.error;
    }
    if (kvm && svc) svc.fileClip.syncConnected(!!kvm.server.current); // the file shortcuts too
    if (svc) state.terminal = { ...settings.terminal, ...svc.terminal.view, toPc: svc.sshClient.view };
    if (svc) state.files = { ...settings.files, ...svc.drop.view, ...svc.fileSend.view, clip: svc.fileClip.view };
    if (svc) state.notifs = { ...settings.notifs, ...svc.notifs.view };
    state.chats = svc && svc.chats ? svc.chats.view() : null; // Messages' WhatsApp, Instagram… conversations
    if (svc) {
      const { secret, ...smb } = settings.smb; // never send the share password to the window
      state.smb = { ...smb, ...svc.smb.view };
      state.apps = { ...settings.apps, ...svc.apps.view };
      state.receive = { ...settings.receive, ...svc.pcView.view };
      state.papps = { ...settings.papps, ...svc.pcApps.view };
    }
    if (svc) state.wake = svc.wake.view;
    if (svc && svc.phone) {
      // A phone's controls on Overview (dev.state): quick settings, volume and ringer, most used apps.
      const v = svc.devctl && state.client && state.client.os === 'android' ? svc.devctl.view : null;
      state.phone = { ...svc.phone.view, settings: settings.phone, ctl: v, qs: v ? v.qs || null : null, top: v ? v.top || [] : [] };
    }
    state.peerCtl = svc && svc.devctl && state.client && state.client.os !== 'android' ? svc.devctl.view : null; // a computer's controls on Overview
    if (svc && svc.phoneDrive) state.mount = { ...svc.phoneDrive.view, on: !!settings.mount.on };
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    state.hub = phoneHub ? phoneHub.view : { ...settings.hub, connected: false };
    if (updates) state.updates = updates.view;
    if (pairSync) pairSync.check();
    sendScreenState();
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
    if (tdweb && tdweb.running) {
      try { tdweb.notifyClipboard(clipboard.readText()); } catch (_) {}
    }
    updateTray();
  });
}

// Tell the viewer what we share, so it can show Start / Extend / Mirror itself
// (screen.state); only when something changed or the peer is new.
let screenStateKey = '';
function sendScreenState() {
  const c = peer && peer.current;
  if (!c || !svc) return void (screenStateKey = '');
  const msg = { t: P.T.SCREEN_STATE, on: !!settings.sharing.on, mode: displayMode(), remote: settings.sharing.remote !== false, modes: ['extend', 'mirror'] };
  const key = JSON.stringify([c.deviceId, msg]);
  if (key === screenStateKey) return;
  screenStateKey = key;
  peer.sendToClient(msg);
}

// The viewer on the other computer starts/stops our sharing or switches Extend/Mirror.
function onScreenCtl(m) {
  // The phone viewer's Close stops sharing even when the viewer may not start and switch it.
  if (m.share === false && m.close === true) return void (settings.sharing.on && actions.setSharing(false, 'remote'));
  if (settings.sharing.remote === false) return void (screenStateKey = '', pushState()); // re-send: remote false
  // Started from the viewer without a mode: Mirror (the virtual display doesn't always start); Extend is its switch.
  const mode = m.mode === 'extend' || m.mode === 'mirror' ? m.mode : m.share === true && !settings.sharing.on ? 'mirror' : null;
  if (mode && displayMode() !== mode) actions.setDisplayMode(mode);
  if (typeof m.share === 'boolean' && m.share !== !!settings.sharing.on) actions.setSharing(m.share, 'remote');
}

// macshare://send?p=<path>&p=… from the Share menu extension: Send files to the peer.
function handleSendLink(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  const paths = u.searchParams.getAll('p').filter((x) => x.startsWith('/')).slice(0, 1000);
  if (!paths.length) return;
  if (!peer.current) return hud && hud.show('away', { key: 'Not connected' }, { key: 'Open TwinDesk on the other computer first' });
  actions.sendFiles(paths);
  hud && hud.show('away', { key: paths.length === 1 ? 'Sending {count} item to {name}' : 'Sending {count} items to {name}', vars: { count: paths.length, name: peer.current.name } });
}

// The menu's Share Screen, Extend and Mirror: share in that mode (null: stop), as the viewer's screen.ctl does.
function shareAs(mode) {
  if (!mode) return void (settings.sharing.on && actions.setSharing(false));
  if (displayMode() !== mode) actions.setDisplayMode(mode);
  if (!settings.sharing.on) actions.setSharing(true);
}

function displayMode() {
  const t = svc && svc.displays.target();
  if (!t) return 'custom';
  if (t.virtual) return 'extend';
  return t.primary && !settings.virtual.enabled ? 'mirror' : 'custom';
}

function refreshPermissions() {
  state.permissions.screen = systemPreferences.getMediaAccessStatus('screen');
  state.permissions.accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  if (svc && svc.helper.running) {
    svc.helper.request('permissions').then((r) => {
      state.permissions.inputMonitoring = !!r.inputMonitoring;
      if (r.screen === true) state.permissions.screen = 'granted'; // the helper sees a fresh grant first
      setupSeen();
      clearStalePermissions();
      pushState();
    }, () => {});
  }
  pushState();
}

// After an update signed differently (every ad-hoc build was), macOS still lists TwinDesk as
// allowed but the grant belongs to the old signature, so the switches are on and nothing works,
// and switching them on again does nothing. Once per new signature: whatever reads as missing is
// reset (tccutil drops the stale entry), so Allow asks afresh and the switch in System Settings
// really is ours. Builds signed with TwinDesk's certificate keep one signature (build-app.sh).
let staleChecked = false;
function clearStalePermissions() {
  if (staleChecked || !app.isPackaged) return;
  staleChecked = true;
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  require('child_process').execFile('/usr/bin/codesign', ['-dr', '-', bundle], (err, out, errOut) => {
    const m = /designated => (.+)/.exec(`${out}${errOut}`);
    if (!m || m[1] === settings.app.signature) return;
    const p = state.permissions;
    const services = [
      p.screen !== 'granted' && 'ScreenCapture',
      !p.accessibility && 'Accessibility',
      p.inputMonitoring === false && 'ListenEvent',
    ].filter(Boolean);
    const id = 'org.macshare.mac';
    let left = services.length;
    const done = () => {
      settings.app.signature = m[1];
      store.saveSettings(settings);
      refreshPermissions();
    };
    if (!left) return done();
    console.log(`[permissions] new signature: resetting ${services.join(', ')}`);
    for (const svcName of services) require('child_process').execFile('/usr/bin/tccutil', ['reset', svcName, id], () => --left || done());
  });
}

// Setup shows once: when everything is allowed it's done for good (like Skip for now).
function setupSeen() {
  const p = state.permissions;
  if (settings.ui.setupDone || p.screen !== 'granted' || !p.accessibility || p.inputMonitoring !== true) return;
  settings.ui.setupDone = true;
  store.saveSettings(settings);
}

// The window exists only while it's open: closing it (to the menu bar) frees its page, about
// 50-100 MB; opening it again makes it anew (showWindow).
function changeLanguage() {
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  for (const player of BrowserWindow.getAllWindows()) {
    if (!player.isDestroyed()) player.webContents.send('ui-language', i18n.locale);
  }
  trayKey = '';
  updateTray();
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'control.html'), { query: { language: i18n.locale } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'TwinDesk',
    show: false,
    titleBarStyle: 'hiddenInset', // the sidebar runs up under the traffic lights
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') console.log(`[window] ${e.level}: ${e.message}`);
  });
  win.loadFile(path.join(__dirname, 'control.html'), { query: { language: i18n.locale } });
  win.once('ready-to-show', showWindow);
  // In the Dock and ⌘-Tab only while the window is open; menu bar only otherwise.
  const w = win;
  w.on('show', dockIcon);
  w.on('hide', dockIcon);
  w.on('focus', refreshPermissions);
  w.on('closed', () => {
    if (win === w) win = null;
    dockIcon();
  });
}

function dockIcon() {
  if (!app.dock) return;
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  if (visible && !app.dock.isVisible()) {
    app.dock.show().then(() => win && !win.isDestroyed() && win.focus()); // showing the Dock icon can take focus away
  } else if (!visible && app.dock.isVisible()) {
    app.dock.hide();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
}

function showUpdateWindow() {
  showWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('show-update');
  }
}

// The menu bar's ReZume items: Continue the other side's, Send ours there.
function rezumeItems() {
  const h = svc && svc.rz && settings.rezume.tray ? svc.rz.view : null;
  if (!h || !h.connected) return [];
  const name = (peer.current && peer.current.name) || t('the other device');
  const cut = (t) => (t.length > 48 ? t.slice(0, 47) + '…' : t);
  const items = [];
  if (h.incoming) items.push({ label: t('Continue {title} from {name}', { title: cut(h.incoming.title || h.incoming.name || h.incoming.appName), name }), click: () => svc.rz.take() });
  if (h.last && h.send) items.push({ label: t('Send {title} to {name}', { title: cut(h.last.title), name }), click: () => svc.rz.push() });
  return items;
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

// Menu bar: the app mark as a template icon; its menu by kind (shared/traymenu.js), only connecting
// while nothing is connected. Set again only when what it shows changes: a menu replaced while it's open closes (or its click
// goes nowhere), and the state is pushed every second (the ping time isn't in it for that reason).
let trayKey = '';
function updateTray() {
  if (!tray) return;
  const c = state.client;
  const phone = !!(c && c.os === P.OS.ANDROID);
  const name = c ? c.name : t('Other Computer');
  const k = settings.kvm;
  const where = state.input && state.input.where;
  const found = (state.found || []).filter((d) => !c || d.id !== c.id);
  const phoneView = !!(phone && svc && svc.phoneViews.list().some((v) => v.kind === 'screen'));
  const OS = { mac: 'Mac', linux: 'Linux', android: t('Phone') };
  const g = (svc && link && link.view()) || { status: {}, hosts: [] };
  const again = !c && g.hosts.length && (g.status.state === 'stopped' || !!g.status.busy);
  const key = JSON.stringify([c && c.name, c && c.transport, phone, again, where, k.linked, k.ble, svc && svc.kvm.locked, settings.keys.lockKeys, k.driveOther, k.beDriven, settings.sharing.on, displayMode(),
    !!(svc && svc.pcView.isOpen), phoneView, settings.clipboard.enabled, settings.audio.send, settings.app.hud, k.keyboard, settings.files.dragEdge, settings.files.shortcuts, settings.files.copyKeys, rezumeItems().map((i) => i.label),
    found.map((d) => [d.id, d.name, d.os]), updates && updates.status.available && updates.status.latest]);
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(c ? `TwinDesk: ${c.name}` : 'TwinDesk');
  const model = {
    t,
    connected: !!c,
    status: c ? t('Connected to {name}', { name: c.name }) + (c.transport === 'ble' ? ' · ' + t('Bluetooth') : '') : t('Not connected'),
    home: where === 'driving' || where === 'driven' ? () => svc.kvm.home() : null,
    shared: { checked: k.linked !== false && !(svc && svc.kvm.paused), set: (on) => actions.setKvm({ shared: on }) },
    lock: c ? { label: t('Lock Cursor on {name} ({key})', { name: where === 'driving' ? name : id.macName, key: CL.keysLabel(settings.keys.lockKeys, 'mac') }), checked: svc && svc.kvm.locked, set: (on) => svc.kvm.setLocked(on) } : null,
    keyboard: { checked: k.keyboard, set: (on) => actions.setKvm({ keyboard: on }) },
    drive: { label: t('Use Mouse and Keyboard on {name}', { name }), checked: k.driveOther, set: (on) => actions.setKvm({ driveOther: on }) },
    driven: phone ? null : { label: t('Let {name} Control {me}', { name, me: id.macName }), checked: k.beDriven, set: (on) => actions.setKvm({ beDriven: on }) },
    popup: { checked: settings.app.hud !== false, set: (on) => actions.setApp({ hud: on }) },
    screen: [
      { label: t('Share Screen'), checked: settings.sharing.on, set: (on) => actions.setSharing(on) }, // in the mode picked here
      { label: t('Extend'), checked: !!settings.sharing.on && displayMode() === 'extend', set: (on) => shareAs(on ? 'extend' : null) },
      { label: t('Mirror'), checked: !!settings.sharing.on && displayMode() === 'mirror', set: (on) => shareAs(on ? 'mirror' : null) },
      { sep: true },
      phone
        ? { label: t('Show Phone Screen'), checked: phoneView, set: (on) => actions.phoneScreen(on) }
        : { label: t('Receive Screen'), checked: svc && svc.pcView.isOpen, set: (on) => (on ? actions.showPcView() : actions.closePcView()) },
    ],
    clipboard: { checked: settings.clipboard.enabled, set: (on) => actions.setClipboard({ enabled: on }) },
    sound: { checked: settings.audio.send, set: (on) => actions.setAudio({ send: on }) },
    drag: { checked: settings.files.dragEdge !== false, set: (on) => actions.setFiles({ dragEdge: on }) },
    shortcuts: { label: t('Copy and Paste Files ({copy}, {paste})', { copy: CL.keysLabel(settings.files.copyKeys, 'mac'), paste: CL.keysLabel(settings.files.pasteKeys, 'mac') }), checked: settings.files.shortcuts !== false, set: (on) => actions.setFiles({ shortcuts: on }) },
    found: found.map((d) => ({ label: `${d.name} (${OS[d.os] || 'PC'})`, click: () => actions.pairWith(d.id) })),
    byAddress: () => { actions.setTab('overview'); showWindow(); },
    lookAgain: () => actions.refreshDiscovery(),
    again: again ? { label: t(g.status.busy ? 'Take Over {name}' : 'Connect to {name}', { name: g.hosts[0].name }), click: () => actions.connectAgain() } : null,
    disconnect: c ? { label: phone ? t('Disconnect Phone') : t('Disconnect {name}', { name }), click: () => actions.disconnect() } : null,
    update: updates && updates.status.available ? { label: t('TwinDesk {version} available…', { version: updates.status.latest }), click: showUpdateWindow } : null,
    rezume: rezumeItems(),
    open: showWindow,
    quit: () => app.quit(),
  };
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu.template(model)));
  Menu.setApplicationMenu(Menu.buildFromTemplate(trayMenu.appMenu(model))); // the same items in the menu bar
}

// The first session, either way, waits for the helper's input lane (kvm.laneReady), so it's native
// from the start: about 0.3 s at launch, at most LANE_WAIT_MS when the helper doesn't answer.
const LANE_WAIT_MS = 1500;
let laneGo;
const laneGate = new Promise((r) => (laneGo = r));
const afterLane = () => Promise.race([laneGate, new Promise((r) => setTimeout(r, LANE_WAIT_MS))]);

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  // Dev runs show Electron's icon otherwise; the built app has it in its bundle.
  if (app.dock && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'shared', 'icon', 'teindesk-dark-mac.png'));
  store.init(app.getPath('userData'));
  settings = store.loadSettings();
  require('../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  id = identity.load(settings);
  Object.assign(state, { macName: id.macName, macId: id.macId, fp: id.fp, version: app.getVersion(), about: aboutInfo(app) });
  console.log(`[main] ${id.macName} (${id.macId}) fp ${id.fp}`);

  server = new Server(id, { hold: true }); // listens once the helper's input lane is settled (afterLane below)
  server.on('listening', () => console.log(`[server] listening on 0.0.0.0:${server.port}`));
  server.on('listenError', (err) => {
    state.serverError = `Cannot listen on port ${P.PORT}: ${err.code || err.message}`;
    console.error(`[server] ${state.serverError}`);
    pushState();
  });
  server.on('client', (ctx) => {
    console.log(`[server] ${ctx.name} connected from ${ctx.address}`);
  });
  server.on('closed', (ctx) => {
    if (ctx.authed) console.log(`[server] ${ctx.name} disconnected`);
    pushState();
  });
  server.on('rtt', (ctx) => {
    if (process.env.MACSHARE_DEBUG_STATS) console.log(`[server] rtt ${ctx.rttMs} ms`);
    pushState();
  });

  discovery = new Discovery(id, server.port);
  discovery.on('change', pushState);
  discovery.start();
  link = new Link(id, {
    canConnect: () => !server.current && !(pairing && pairing.pending) && !server.phoneHolds(),
    resolve: (hostId) => { const d = discovery.get(hostId); return d && !d.ble ? d : null; }, // a Mac host: on the network only
  });
  link.on('change', pushState);
  link.on('request', showWindow);
  // Take over on a Mac we're a guest of: back to it, taking the session over (a device connected
  // to us goes first, as Take over here does).
  discovery.on('invite', (d) => {
    if (!d || !link.hosts.some((h) => h.id === d.id)) return;
    if (server.current) {
      server.release();
      setTimeout(() => link.connect(true), 800);
    } else link.connect(true);
  });
  pairing = new Pairing(server, id, { busy: () => !!link.ctx, yieldTo: () => link.stop() });
  server.on('phoneFree', () => { link.poke(); pushState(); });
  pairing.on('change', pushState);
  pairing.on('request', showWindow);
  peer = new Peer(server, link);
  peer.setPlain(settings.files.plain === true); // Files › Encrypt file transfers
  peer.on('client', (ctx) => {
    console.log(`[peer] session with ${ctx.name} (${ctx.os}, ${ctx.role === 'host' ? 'we are its guest' : 'it is our guest'})`);
    peer.send(ctx, { t: P.T.STREAM_INPUT, on: settings.streamInput !== false });
    screenStateKey = ''; // a new connection (one replacing the same device's too) hears screen.state: its Extend/Mirror
    pushState();
  });
  peer.on('closed', pushState);
  peer.on('rtt', pushState);

  svc = startServices({ server: peer, getSettings: () => settings, pushState, onHelperReady: refreshPermissions });
  svc.kvm.laneReady.then(laneGo);
  // Apps › Move windows: a window grabbed with the move key crossed with the pointer. A
  // copy of the other computer’s window goes home there (pcapps.js); one of this Mac’s goes over
  // window by window, shared on its own (appsend.js, movewin.js), apart from how apps open.
  svc.kvm.onMoveWindow = (m) => {
    const wid = Number(m.moving);
    if (!wid || svc.pcApps.returnWindow(wid)) return;
    if (settings.apps.moveWindows) svc.appSend.moveOut(wid, Number(m.movingPid));
  };
  afterLane().then(() => {
    server.listen();
    link.start();
  });
  if (settings.app.openAtLogin !== login.isOn()) login.apply(settings.app.openAtLogin);

  svc.phone = new Phone({ server: peer, raw: server, discovery, pairing });
  svc.phone.on('change', pushState);
  // The phone's Keyboard page names this Mac's hotkey (double-tap = everything back here).
  peer.on('client', (ctx) => ctx.os === P.OS.ANDROID && peer.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_MAC) }));
  // The phone's screen, input, clipboard and app windows, through wireless debugging.
  svc.phone.bridge = new PhoneBridge({ server: peer, phone: svc.phone, getSettings: () => settings, clipboard: svc.clipboard });
  svc.phone.bridge.on('change', pushState);
  svc.phone.bridge.on('save', () => store.saveSettings(settings));
  // A phone on a USB cable: pairing, the session, screen and sound through it (no Wi-Fi needed).
  svc.wired = new Wired({ adb: svc.phone.bridge.adb, raw: server, peer, getId: () => id.macId, getName: () => id.macName });
  pairing.isWired = (nonce) => svc.wired.knows(nonce) || qrKnows(nonce); // the cable, or Connection's QR code (Allow only)
  pairing.isQr = qrKnows;
  // Overview's controls of the other device, and this Mac's for it (shared/devctl.js): the session
  // is peer.js here, its 'client' the start.
  const { DevCtl } = require('../shared/devctl.js');
  const { DevLocal } = require('../shared/devlocal.js');
  svc.devctl = new DevCtl({
    link: {
      on: (ev, fn) => (ev === 'welcome' ? peer.on('client', fn) : ev === 'closed' ? peer.on('closed', fn) : peer.on('t:' + ev, fn)),
      send: (m) => peer.sendToClient(m),
      get current() { return peer.current; },
    },
    local: new DevLocal(),
    version: app.getVersion(),
    adb: () => {
      const br = svc.phone && svc.phone.bridge;
      return br && br.state === 'ready' && br.serial ? { adb: br.adb, serial: br.serial } : null;
    },
  });
  svc.devctl.on('change', pushState);
  // ReZume off here (not loaded): still answer the other side's policy, so it shows ReZume as off
  // here, not missing, and offers nothing.
  peer.on(`t:${P.T.RZ_POLICY}`, () => { if (!svc.rz && peer.current) peer.sendToClient({ t: P.T.RZ_POLICY, on: false, web: false, docs: false, apps: false, push: false }); });
  // The other side runs an older TwinDesk (shared/appinfo.js): say so once.
  svc.devctl.on('outdated', (o) => {
    const { FEATURES } = require('../shared/appinfo.js');
    const title = o.version ? t('{name} has an older TwinDesk ({version})', { name: o.name || t('The other device'), version: o.version })
      : t('{name} has an older TwinDesk', { name: o.name || t('The other device') });
    const body = o.missing.length ? t('Update it there for: {features}', { features: o.missing.map((k) => t(FEATURES[k])).join(', ') })
      : t('Update it there: some features need the same version on both');
    try { new Notification({ title, body }).show(); } catch {}
  });
  // Messages' chat apps from a phone, kept per phone (shared/chats.js).
  const { Chats } = require('../shared/chats.js');
  svc.chats = new Chats({ link: {
      on: (ev, fn) => (ev === 'welcome' ? peer.on('client', fn) : ev === 'closed' ? peer.on('closed', fn) : peer.on('t:' + ev, fn)),
      send: (m) => peer.sendToClient(m),
      get current() { return peer.current; },
    }, dir: app.getPath('userData'), want: () => settings.ui.chats === true, onChange: pushState });
  // Connection › Pair a phone with a QR code (shared/ui-qrpair.js), and wireless debugging's (shared/adbqr.js).
  svc.qrPair = () => {
    if (!qrPair || Date.now() > qrPair.until) qrPair = { nonce: require('crypto').randomBytes(8).toString('hex'), until: Date.now() + 10 * 60000 };
    const addrs = (state.addresses || []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)).slice(0, 4);
    if (!addrs.length) return { url: '', why: 'No network' };
    const q = new URLSearchParams({ id: id.macId, n: id.macName, a: addrs.join(','), p: String(server.port), k: qrPair.nonce });
    return { url: 'twindesk://pair?' + q.toString(), until: qrPair.until };
  };
  svc.adbQr = (on) => {
    if (adbQr) { adbQr.stop(); adbQr = null; }
    state.adbQr = null;
    const br = svc.phone && svc.phone.bridge;
    if (on && br && br.adb.available) {
      adbQr = require('../shared/adbqr.js').startAdbQr({
        adb: br.adb,
        onPaired: () => br.pairedNow(),
        onEnd: (why) => { adbQr = null; state.adbQr = { done: why }; pushState(); },
      });
      state.adbQr = { text: adbQr.text };
    }
    pushState();
  };
  svc.wired.on('change', pushState);
  svc.phone.bridge.wired = svc.wired;
  svc.phone.wired = svc.wired;
  svc.phoneViews = new PhoneViews({ bridge: svc.phone.bridge, phone: svc.phone, getSettings: () => settings, server: peer, fileSend: svc.fileSend });
  // What plays on the phone, for the Overview's media controls (shared/nowplaying.js). Its sound as
  // this Mac's Bluetooth speaker isn't here: macOS can't be one.
  // Loaded only while Audio › Media controls is on: made when it's first turned on; returns it (or
  // null), for ipc, whose ctx is a copy of svc.
  svc.loadNowPlaying = () => {
    if (svc.nowPlaying || settings.audio.phoneMedia === false) return svc.nowPlaying || null;
    const { NowPlaying } = require('../shared/nowplaying.js');
    svc.nowPlaying = new NowPlaying({ server: peer, cfg: () => settings.audio });
    svc.nowPlaying.on('change', pushState);
    return svc.nowPlaying;
  };
  svc.loadNowPlaying();
  // Audio › Microphone (shared/mic.js): loaded the first time one of its switches is on.
  svc.loadMic = () => {
    if (svc.mic || !(settings.audio.micSend || settings.audio.micReceive)) return svc.mic || null;
    const { Mic } = require('../shared/mic.js');
    const askMic = () => (systemPreferences.getMediaAccessStatus('microphone') === 'granted' ? Promise.resolve(true) : systemPreferences.askForMediaAccess('microphone'));
    svc.mic = new Mic({ server: peer, cfg: () => settings.audio, onChange: pushState, platform: 'mac', askMic });
    return svc.mic;
  };
  svc.loadMic();
  // Camera tab: the cameras of the two computers (shared/camshare.js; a phone's is phoneViews.openCamera),
  // loaded only while Camera is on. ipc reaches them through svc.cam() (its ctx is a copy of svc).
  svc.loadCamera = () => {
    if (svc.camShare || settings.camera.on === false) return svc.camShare || null;
    const { CamShare } = require('../shared/camshare.js');
    const { VirtualCam } = require('../shared/vcam.js');
    const computer = () => !!peer.current && peer.current.os !== P.OS.ANDROID;
    // Camera › Virtual camera (shared/vcam.js, vcam.js): the running camera's picture also goes to a
    // camera apps can pick.
    svc.vcam = new VirtualCam({
      driver: require('./vcam'),
      cfg: () => settings.camera,
      save: () => store.saveSettings(settings),
      onChange: pushState,
      onReady: () => svc.phone.bridge._tellPhone(), // the phone's Camera page says so
      ui: () => win,
    });
    svc.phoneViews.vcam = svc.vcam;
    svc.camShare = new CamShare({
      getLanguage: () => i18n.locale,
      link: {
        on: (t, fn) => (t === 'welcome' ? peer.on('client', (ctx) => ctx.os !== P.OS.ANDROID && fn()) : peer.on(`t:${t}`, (m) => fn(m))),
        send: (m) => peer.sendToClient(m),
        connected: computer,
        ble: () => !!(peer.current && peer.current.transport === 'ble'),
        closed: (fn) => peer.on('closed', fn),
      },
      cfg: () => settings.camera,
      save: () => store.saveSettings(settings),
      popup: (kind, text, presentation) => hud && hud.show(kind, presentation || text),
      peerName: () => (peer.current && peer.current.name) || 'the other computer',
      onChange: pushState,
    });
    svc.vcam.check();
    svc.camShare.sendPolicy(); // connected already: the other computer hears whether it's shared
    return svc.camShare;
  };
  svc.cam = () => ({ camShare: svc.camShare || null, vcam: svc.vcam || null });
  // Camera's switch: on loads it; off, whatever runs stops (the phone's camera too) and nothing is shared.
  svc.setCamera = (on) => {
    settings.camera.on = !!on;
    store.saveSettings(settings);
    if (on) svc.loadCamera();
    else {
      if (svc.camShare) {
        svc.camShare.closeView();
        svc.camShare.stopSending();
        svc.camShare.sendPolicy();
      }
      for (const v of svc.phoneViews.list()) if (v.kind === 'camera') svc.phoneViews.close(v.id);
    }
    svc.phone.bridge._tellPhone();
    pushState();
  };
  svc.loadCamera();
  svc.phoneViews.on('change', pushState);
  // A phone notification clicked here: its app in a window.
  svc.notifs.on('click', (m) => peer.current && peer.current.os === P.OS.ANDROID && svc.phoneViews.openNotified(m.app, m.appName));
  // The phone in Finder, through adb (the cable, else wireless debugging): only when Mount is clicked.
  svc.phoneDrive = new PhoneDrive({ adb: svc.phone.bridge.adb, bridge: svc.phone.bridge, phone: svc.phone });
  svc.phoneDrive.on('change', pushState);
  setupNet();
  setupHub();
  svc.kvm.local = svc.phone.bridge;
  // The phone's Remote page: touchpad, keyboard and gamepad here, taken only with the mouse at home.
  // No Real gamepad: a virtual controller on macOS needs a DriverKit driver, which needs Apple's paid signing.
  // Loaded only while Remote is on (off, its page hears so); ipc reaches it through svc.remote().
  svc.loadRemote = () => {
    if (svc.phoneRemote || settings.remote.allow === false) return svc.phoneRemote || null;
    const { PhoneRemote } = require('../shared/phone-remote.js');
    svc.phoneRemote = new PhoneRemote({ server: peer, helper: svc.helper, getSettings: () => settings, atHome: () => svc.kvm.mode === 'home', onChange: pushState,
      padNote: 'Real gamepad isn’t on the Mac. To use {name} as a gamepad, turn on Remote › As a Bluetooth gamepad on {name}, then pair it with this Mac in System Settings › Bluetooth' });
    svc.phoneRemote.refresh(); // its page may be open already
    return svc.phoneRemote;
  };
  svc.remote = () => svc.phoneRemote || null;
  peer.on(`t:${P.T.REMOTE_HELLO}`, () => !svc.phoneRemote && peer.current && peer.current.os === P.OS.ANDROID
    && peer.sendToClient({ t: P.T.REMOTE_STATE, allowed: false, off: true, why: 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there' }));
  svc.loadRemote();
  // ReZume: what's in use here goes on on the other device, and theirs here (shared/rezume.js), its
  // offers in the Dock (a Dock icon of their app, dockstub.js), the menu bar and a notification.
  // Loaded the first time it's turned on: until then nothing is looked at; ipc reaches it through svc.rezume().
  svc.loadRezume = () => {
    if (svc.rz || !settings.rezume.on) return svc.rz || null;
    const { shell } = require('electron');
    const { ReZume } = require('../shared/rezume.js');
    const { ReZumeShelf } = require('../shared/rezume-shelf.js');
    const { DockStub } = require('./dockstub');
    svc.rzAct = require('./activity').create({ cfg: () => settings.rezume });
    const name = () => (peer.current && peer.current.name) || 'the other device';
    svc.rz = new ReZume({
      link: {
        on: (t, fn) => peer.on(`t:${t}`, (m) => fn(m)),
        send: (m) => peer.sendToClient(m),
        peer: () => (peer.current ? { os: peer.current.os, name: name() } : null),
        welcome: (fn) => peer.on('client', () => fn()),
        closed: (fn) => peer.on('closed', () => fn()),
      },
      cfg: () => settings.rezume,
      detect: () => svc.rzAct.detect(),
      appIcon: (a) => svc.rzAct.appIcon(a),
      open: { url: (u) => shell.openExternal(u), file: (p) => shell.openPath(p), phoneApp: (pkg) => openPhoneApp(pkg) },
      sendFile: (p, batch) => !!svc.fileSend.sendBatch([p], 'rezume', batch),
      expectFile: (batch, dir) => svc.drop.expectBatch(batch, dir || '', true),
      // Documents opened in place (shared/rzlive.js), the chooser (shared/rzpick.js), and where copies go.
      cacheDir: path.join(app.getPath('temp'), 'TwinDesk ReZume'),
      live: (() => {
        const { LiveShare } = require('../shared/rzlive.js');
        const ls = new LiveShare({ tls: () => server && server.tls, mounter: require('./phonedrive').mounter });
        return {
          share: (p) => ls.share(p),
          mount: async (info) => {
            if (svc.net && !(await svc.net.need('folder'))) throw new Error('The other computer could not be reached over Wi-Fi');
            return ls.mount(info);
          },
          stop: () => ls.stop(),
          shutdown: () => ls.shutdown(),
        };
      })(),
      pick: (o, ways) => require('../shared/rzpick.js').pick(o, ways, { peer: name(), language: i18n.locale }),
      adb: () => phoneAdb(svc.phone && svc.phone.bridge),
      phoneApps: () => (svc.phone && svc.phone.apps) || [],
      save: () => store.saveSettings(settings),
      // An app's window between two computers: ours streamed window by window (appsend.js), theirs
      // shown here as the PC apps are (pcapps.js).
      window: {
        canSend: () => true,
        // The way this Mac's apps go there: to a Mac window by window (appsend.js), to a PC through
        // the shared display (apps.js), exactly as its Apps tab opens them.
        send: (app) => (peer.current && peer.current.os === P.OS.MAC ? svc.appSend.adopt(app) : svc.apps.adopt(app)),
        accept: async (on) => {
          if (on && svc.net && !(await svc.net.need('apps'))) return false;
          svc.pcApps.acceptReZume(on);
          return true;
        },
        stop: (app) => { svc.appSend.unadopt(app); svc.apps.unadopt(app); },
      },
    });
    svc.rz.on('change', pushState);
    svc.rz.on('opened', (o) => hud && hud.show('home', { key: o.how === 'sent' ? 'Sent to {name}: {title}' : 'From {name}: {title}', vars: { name: peer.current ? peer.current.name : { key: 'the other computer' }, title: o.title } }));
    let stub = null;
    const dock = {
      show(o, take, dismiss) {
        if (stub) stub.stop();
        stub = new DockStub({ id: 'rezume:' + (o.app || o.kind), name: (o.appName || 'ReZume') + ' (ReZume)', icon: o.icon }, (ev) => (ev === 'quit' ? dismiss() : take()));
        stub.menu([o.title || o.name || o.appName || '']);
      },
      hide() { if (stub) { stub.stop(); stub = null; } },
    };
    svc.rzShelf = new ReZumeShelf({ rezume: svc.rz, cfg: () => settings.rezume, peerName: name, dock, badge: path.join(__dirname, 'assets', 'sidebar-icon@4x.png') });
    svc.rz.apply();
    return svc.rz;
  };
  svc.rezume = () => svc.rz || null;
  svc.loadRezume();
  svc.kvm.on('where', () => svc.phoneRemote && svc.phoneRemote.refresh());
  const blockEdge = svc.kvm.blockEdge;
  svc.kvm.blockEdge = () => blockEdge() || svc.phoneViews.focused; // moving inside the phone window never crosses
  svc.apps.setSharing = (on, by) => actions.setSharing(on, by);
  peer.on(`t:${P.T.SCREEN_CTL}`, (m) => onScreenCtl(m));
  // Two-way switches shared with the other computer, per pair (pairsync.js).
  const SYNC_ACTIONS = {
    clipboard: (dir, on) => actions.setClipboard({ [dir === 'out' ? 'send' : 'receive']: on }),
    notifs: (dir, on) => actions.setNotifs({ [dir === 'out' ? 'send' : 'receive']: on }),
    apps: (dir, on) => (dir === 'out' ? actions.setApps({ offer: on }) : actions.setPcApps({ on })),
    audio: (dir, on) => actions.setAudio({ [dir === 'out' ? 'send' : 'receive']: on }),
    cursor: (dir, on) => actions.setKvm({ [dir === 'out' ? 'driveOther' : 'beDriven']: on }),
    rezume: (dir, on) => actions.setRezume({ [dir === 'out' ? 'send' : 'receive']: on }),
    remote: (dir, on) => actions.setRemote({ allow: on }),
    terminal: (dir, on) => { actions.setTerminal({ [dir === 'out' ? 'allowPc' : 'connectPc']: on }); if (dir === 'in') svc.sshClient.applySettings(); }, // already set: setTerminal sees no change
    files: (dir, on) => actions.setFiles({ acceptDrops: on }),
  };
  pairSync = new PairSync({ server: peer, getSettings: () => settings, saveSettings: () => store.saveSettings(settings),
    apply: (f, dir, on) => (f !== 'value' ? SYNC_ACTIONS[f](dir, on)
      : dir === 'rezume' ? actions.setRezume({ on })
        : ['gestures', 'ble', 'keyboard', 'speed', 'reverseScroll', 'syncPads'].includes(dir) ? actions.setKvm({ [dir]: on }) : actions.setSharingOpts({ [dir]: on })) });
  // New releases on GitHub: a notification once per version, the menu bar item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'mac', getSettings: () => settings, getLanguage: () => i18n.locale,
    save: () => store.saveSettings(settings), onChange: pushState,
    onShowModal: showUpdateWindow,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', onClick);
      n.show();
    },
  });
  updates.start();
  Look.applyTheme(nativeTheme, settings.ui.theme);
  nativeTheme.on('updated', () => pushState());
  // The system accent colour changed (General › Appearance › System follows it).
  try { systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () => pushState()); } catch {}
  function applyWeb() {
    const w = settings.web || {};
    if (!w.enabled || !w.portal) {
      if (tdweb) { tdweb.stop(); tdweb = null; }
      pushState();
      return;
    }
    if (!tdweb) {
      tdweb = new TdWebServer({
        getSettings: () => settings,
        getIdentity: () => ({ name: id.macName || os.hostname() }),
        getClipboard: () => {
          try { const { clipboard } = require('electron'); return clipboard.readText(); } catch (_) { return ''; }
        },
        setClipboard: (text) => {
          try { const { clipboard } = require('electron'); clipboard.writeText(text); } catch (_) {}
        },
        getDownloadsDir: () => app.getPath('downloads'),
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
      tdweb.start({ port: w.port || 47802, credentials: { key: id.keyPem, cert: id.certPem } });
    }
    pushState();
  }

  actions = setupIpc({ state, settings, pushState, onLanguage: changeLanguage, onLook: () => Look.applyTheme(nativeTheme, settings.ui.theme), t, server: peer, pairing, discovery, link, ...svc, hub: loadHub, login, refreshPermissions, updates, applyWeb, get tdweb() { return tdweb; } });
  applyWeb();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))); // "Template": macOS tints it
  hud = new Hud(() => settings);
  svc.kvm.on('where', (mode) => {
    svc.pcApps.setDriven(mode === 'driven'); // a moved window's copy shows this Mac's pointer then
    const name = peer.current ? peer.current.name : { key: 'the other computer' };
    if (mode === 'driving') hud.show('away', { key: settings.kvm.mouse ? 'Using {name}' : 'Typing on {name}', vars: { name } });
    else if (mode === 'driven') hud.show('driven', { key: '{name} is using {me}', vars: { name, me: id.macName } });
    else hud.show('home', { key: 'Back on {me}', vars: { me: id.macName } });
  });
  // Cursor lock: the popup goes where the pointer is (the other computer shows its own while we drive it).
  svc.kvm.on('lock', (on, mode) => {
    if (mode === 'driving' && !(svc.kvm.local && svc.kvm.local.drives())) return;
    const where = mode === 'driving' ? (peer.current ? peer.current.name : { key: 'the other computer' }) : id.macName;
    hud.show('lock', { key: on ? 'Cursor locked on {name}' : 'Cursor unlocked', vars: { name: where } });
  });
  // The lock key at home: a global shortcut, held while connected (pushState syncs it).
  lockKey = new CL.GlobalLockKey(globalShortcut, () => svc.kvm.toggleLock());

  svc.fileClip.on('popup', (kind, text) => hud.show(kind, text));
  svc.clipboard.on('popup', (kind, text) => hud.show(kind, text)); // a picture from the other side
  svc.pcApps.on('popup', (kind, text) => hud.show(kind, text));
  svc.phone.bridge.on('popup', (kind, text) => hud.show(kind, text));
  if (app.isPackaged) app.setAsDefaultProtocolClient('macshare');
  for (const url of linkQueue.splice(0)) handleLink(url);
  // The hotkey's double-tap: the big card "Cursor sharing on/off" (also when the other side switched it).
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  svc.kvm.on('linked', (on, here, ble) => {
    const name = peer.current ? peer.current.name : '';
    const key = P.hotkeyName(settings.keys.hotkey);
    const sub = !here && name ? { key: on ? 'Turned on on {name}' : 'Turned off on {name}', vars: { name } }
      : on ? { key: name ? 'With {name}. Double-tap {key} to turn it off' : 'Double-tap {key} to turn it off', vars: { name, key } }
        : { key: ble ? 'It comes back on Wi-Fi. Double-tap {key} to turn it on' : 'Double-tap {key} to turn it on', vars: { key } };
    hud.show(on ? 'linkOn' : 'linkOff', { key: on ? 'Cursor sharing on' : ble ? 'Cursor sharing off over Bluetooth' : 'Cursor sharing off' }, sub);
  });
  // Files on their way, live (as on the PC): the popup with the percentage while a batch takes more
  // than a moment, and a notification for it, replaced by how it ended (macOS notifications can't
  // show a bar, so it isn't re-posted for every step).
  const peerLabel = () => (peer.current ? peer.current.name : t('the other computer'));
  const liveNote = { recv: null, send: null };
  const liveShow = (tag, title, body) => {
    if (liveNote[tag] || !Notification.isSupported()) return;
    try {
      liveNote[tag] = new Notification({ title, body, silent: true });
      liveNote[tag].show();
    } catch { liveNote[tag] = null; }
  };
  const liveDone = (tag, title, body) => {
    const n = liveNote[tag];
    if (!n) return;
    liveNote[tag] = null;
    try { n.close(); new Notification({ title, body, silent: true }).show(); } catch {}
  };
  svc.fileSend.on('batchDone', (b) => {
    const label = b.items > 1 ? t('{count} items', { count: b.items }) : b.name;
    liveDone('send', b.ok ? t('Sent {file}', { file: label }) : t('Not everything arrived'), t(b.ok ? 'On {name}' : 'On {name}: some files didn’t make it', { name: peerLabel() }));
  });
  peer.on('closed', () => {
    liveDone('recv', t('Files stopped'), t('{name} disconnected', { name: peerLabel() }));
    liveDone('send', t('Files stopped'), t('{name} disconnected', { name: peerLabel() }));
  });
  svc.drop.on('batch', (b) => {
    liveDone('recv', b.files ? t(b.files === 1 ? 'Received {count} file' : 'Received {count} files', { count: b.files }) : t('Nothing arrived'), b.files ? t('From {name}', { name: peerLabel() }) : '');
    if (svc.rz && svc.rz.received(b)) return; // a document taken here: it opens
    if (b.kind === 'send') hud.show('driven', { key: b.files === 1 ? 'Received {count} file from {name}' : 'Received {count} files from {name}', vars: { count: b.files, name: peer.current ? peer.current.name : { key: 'the other computer' } } });
  });
  // Files on their way, live: the percentage beside the menu bar icon, ↓ coming in, ↑ going out
  // (macOS notifications have no progress bar, and TwinDesk has no Dock icon to put one on).
  let trayPct = '';
  setInterval(() => {
    const dv = svc.drop.view;
    const sv = svc.fileSend.view;
    const sum = (list, k) => list.reduce((a, f) => [a[0] + (f[k] || 0), a[1] + (f.size || 0)], [0, 0]);
    const [got, gotOf] = dv.inBatches.reduce((a, b) => (b.bytes ? [a[0] + b.got, a[1] + b.bytes] : a), sum(dv.receiving, 'got'));
    const [sent, sentOf] = sv.outBatches.reduce((a, b) => [a[0] + b.sent, a[1] + b.bytes], sum(sv.sending, 'sent'));
    const pct = (n, of) => Math.min(99, Math.floor((100 * n) / Math.max(1, of)));
    // The popup and the notification: batches that have taken more than a moment.
    const now = Date.now();
    const rb = dv.inBatches.find((b) => now - b.at >= 400);
    if (rb) {
      const key = rb.kind === 'paste'
        ? rb.count === 1 ? 'Pasting {count} file from {name}' : 'Pasting {count} files from {name}'
        : rb.count === 1 ? 'Receiving {count} file from {name}' : 'Receiving {count} files from {name}';
      const vars = { count: rb.count, name: peerLabel(), percent: rb.bytes ? pct(rb.got, rb.bytes) : pct(rb.done, rb.count) };
      hud.show('driven', { key: `${key} · {percent} %`, vars });
      liveShow('recv', t(key, vars), t('From {name}', { name: peerLabel() }));
    }
    const sb = sv.outBatches.find((b) => now - b.at >= 400 && b.bytes > 5 * 1024 * 1024);
    if (sb && !rb) {
      const file = sb.items > 1 ? { key: '{count} items', vars: { count: sb.items } } : sb.name;
      hud.show('away', { key: 'Sending {file} to {name} · {percent} %', vars: { file, name: peerLabel(), percent: pct(sb.sent, sb.bytes) } });
    }
    if (sb) liveShow('send', t('Sending {file}', { file: sb.items > 1 ? t('{count} items', { count: sb.items }) : sb.name }), t('To {name}', { name: peerLabel() }));
    const title = (gotOf ? ` ↓${pct(got, gotOf)}%` : '') + (sentOf ? ` ↑${pct(sent, sentOf)}%` : '');
    if (title === trayPct || !tray) return;
    trayPct = title;
    tray.setTitle(title, { fontType: 'monospacedDigit' });
  }, 500).unref();
  // Started at login: in the menu bar only; the window is made when it's first opened.
  if (startHidden) startHidden = false;
  else createWindow();
  refreshPermissions();
  if (process.env.MACSHARE_DEV_TEST) require('./dev/m2m')({ role: process.env.MACSHARE_DEV_TEST, svc, actions, link, pairing, peer });
  readDefaultIf();
  setInterval(() => {
    readDefaultIf();
    pushState();
  }, 5000); // addresses change when the network does
  // While Setup shows something missing, notice the grant without waiting for a window focus.
  setInterval(() => {
    const p = state.permissions;
    const missing = p.screen !== 'granted' || !p.accessibility || p.inputMonitoring === false;
    if (missing && win && !win.isDestroyed() && win.isVisible()) refreshPermissions();
  }, 3000);
});

// Not on one network: the session through Bluetooth (this Mac advertises; phones and PCs connect),
// and Wi-Fi for files and screens (netlink.js): this Mac joins the other side's Wi-Fi Direct group or
// access point for a while, or, for a phone's screen, its hotspot (the banner asks for it).
let bleOff = false; // General's Turn off Bluetooth on Wi-Fi connections, in effect (bleQuiet)
const bleQuiet = wifiQuiet();

function setupNet() {
  const { safeStorage } = require('electron');
  svc.ble = new BleHost({
    helper: svc.helper, server,
    info: () => ({ id: id.macId, name: id.macName.slice(0, 40), os: P.OS.MAC, port: server.port, fp: id.fp }),
    enabled: () => !bleOff && (settings.net.ble !== false || settings.net.blePc === true),
    accept: (g) => (g.os === P.OS.ANDROID ? settings.net.ble !== false : settings.net.blePc === true), // General's two Bluetooth switches
  });
  svc.ble.on('change', pushState);
  // PCs nearby that aren't on this network (not paired yet: they haven't connected to say hello).
  // Looked for only while there's no session; Invite asks one to connect.
  svc.bleLook = new BleLook({ helper: svc.helper, self: () => ({ id: id.macId, name: id.macName.slice(0, 40), os: P.OS.MAC }) });
  svc.bleLook.on('change', pushState);
  setInterval(() => {
    // The session on the same Wi-Fi a while (General's Turn off Bluetooth on Wi-Fi connections,
    // blepolicy.js wifiQuiet): no advertising, its pipes and the session's Bluetooth fallback closed;
    // back as it was when the session ends.
    const off = bleQuiet({ on: settings.net.bleWifiOff !== false, current: () => peer.current, onGroup: () => !!svc.net && svc.net.onGroup });
    if (off !== bleOff) {
      bleOff = off;
      console.log(`[ble] ${off ? 'off: the session is on the same Wi-Fi' : 'on again'}`);
      svc.ble.apply();
      pushState();
    }
    svc.bleLook.look(settings.net.blePc === true && !peer.current);
  }, 3000).unref();
  discovery.extra = {
    list: () => {
      const out = svc.ble.list();
      for (const d of svc.bleLook.list()) if (d.os !== P.OS.MAC && !out.some((x) => x.id === d.id)) out.push(d); // a Mac can't come through Bluetooth to a Mac
      return out;
    },
    invite: (devId) => svc.ble.invite(devId) || svc.bleLook.invite(devId),
  };
  const wifi = (cmd, args, ms) => svc.helper.request(cmd, args, ms);
  svc.net = new NetLink({
    os: P.OS.MAC,
    send: (m) => peer.sendNow(m),
    current: () => {
      const c = peer.current;
      return c && { deviceId: c.deviceId, os: c.os, role: c.role, transport: c.transport === 'ble' ? 'ble' : 'ip', address: c.address };
    },
    host: null, // a Mac can't host a network others join while it stays on its own
    join: {
      can: () => true,
      start: async (ssid, password) => {
        await wifi('wifiLocation').catch(() => {}); // macOS shows scans only to apps with Location
        await wifi('wifiJoin', { ssid, password }, 90000);
      },
      stop: () => wifi('wifiLeave', {}, 30000),
    },
    // A phone's screen goes through adb: on the phone's hotspot the Mac keeps the internet.
    // 'user': Connect with Wi-Fi Direct; 'hotspot': Connect with hotspot.
    hotspot: (why, peerOs) => peerOs === P.OS.ANDROID && why !== 'files' && why !== 'user',
    cable: () => {
      const c = peer.current;
      return !!c && c.os === P.OS.ANDROID && !!svc.wired && svc.wired.toCable(c.deviceId);
    },
  });
  svc.net.on('change', () => {
    if (svc.net.state === 'hotspot') showWindow();
    pushState();
  });
  svc.net.on('dropped', () => settings.sharing.on && actions.setSharing(false)); // Bluetooth can't carry the screen
  peer.hold = (m) => svc.net.holdOut(m, (x) => peer.sendNow(x));
  peer.tap = (m) => svc.net.onMessage(m);
  peer.on('client', () => svc.net.started());
  peer.on('closed', () => svc.net.ended());
  peer.on('transport', () => {
    pushState();
    if (!svc.smb.onBle) svc.smb.mountPc(); // on Wi-Fi now: the PC's folder too
  });
  svc.smb.wifi = (on) => (on ? svc.net.need('smb') : Promise.resolve(svc.net.release('smb')));
  // The phone's screen or an app window asked for while on Bluetooth: its hotspot, then the window.
  let pendingView = null;
  svc.phoneViews.onNoAdb = (v) => {
    const c = peer.current;
    if (!c || c.transport !== 'ble' || c.os !== P.OS.ANDROID) return false;
    pendingView = v;
    svc.net.need('phone').then((ok) => !ok && (pendingView = null));
    return true;
  };
  svc.phone.bridge.on('change', () => {
    if (!pendingView || !svc.phone.bridge.serial) return;
    const v = pendingView;
    pendingView = null;
    if (v.kind === 'app') svc.phoneViews.openApp(v.app, v.title);
    else svc.phoneViews.openScreen();
  });
  svc.phoneViews.on('change', () => {
    if (!svc.phoneViews.list().length && !pendingView) svc.net.release('phone');
  });
  svc.pcView.on('change', () => !svc.pcView.isOpen && svc.net.release('view'));
  const openPcApp = svc.pcApps.open.bind(svc.pcApps);
  svc.pcApps.open = (id) => svc.net.need('apps').then((ok) => ok && openPcApp(id));
  svc.pcApps.on('change', () => {
    const v = svc.pcApps.view;
    if (!(v.windows || []).length) svc.net.release('apps');
  });
  svc.netSecret = {
    seal: (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : `plain:${s}`),
    open: (s) => {
      if (!s) return '';
      if (s.startsWith('plain:')) return s.slice(6);
      try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
    },
  };
}

// Calls, Messages, Photos and Files from a phone (shared/phonehub.js): loaded when a phone connects with
// one of them on, or the first time a page uses it. Before that none of it exists: no module, no
// listener, nothing sent to the phone. The call window (shared/callwin.js) only with a call.
function setupHub() {
  const anyOn = () => settings.hub.calls || settings.hub.messages || settings.hub.media || settings.hub.files || settings.hub.shareServe;
  peer.on('client', (ctx) => ctx.os === P.OS.ANDROID && !phoneHub && anyOn() && loadHub());
  // The phone shares a folder: loaded for it (its listener comes with it, so this one passes it on).
  peer.on(`t:${P.T.SHARE_OFFER}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !phoneHub && loadHub().share && phoneHub.share.onOffer(m));
  peer.on(`t:${P.T.SHARE_SET}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !phoneHub && loadHub().share && phoneHub.share.act('serve', { on: !!m.serve }));
}

let callwin = null;
function loadHub() {
  if (phoneHub) return phoneHub;
  const { PhoneHub } = require('../shared/phonehub.js');
  const hub = new PhoneHub({
    server: peer, getSettings: () => settings, save: () => store.saveSettings(settings),
    // No calls' sound on the Mac: macOS refuses an app the hands-free voice link (SCO, kIOReturnUnsupported
    // on Apple silicon), so the Calls page has no Sound or Bluetooth setup here and the sound stays on the
    // phone (answer, end, mute, hold and the keypad still work). mac/callaudio.js is kept, unused.
    send: (paths, batch) => !!(svc.fileSend && svc.fileSend.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
    choose: () => dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openFile', 'openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths)),
    share: { // shared folders with the phone (shared/foldershare.js)
      mounter: require('./phonedrive').mounter, adb: svc && svc.phone.bridge.adb, serialOf: (id) => svc && svc.wired && svc.wired.serialOf(id),
      chooseFolder: () => dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openDirectory', 'createDirectory'] }).then((r) => (r.canceled ? '' : r.filePaths[0])),
      defaultFolder: path.join(require('os').homedir(), 'MacShare'),
      tls: () => server && server.tls, // served with the session's certificate, which the phone pinned
      wifi: (on) => (!svc.net ? Promise.resolve(false) : on ? svc.net.need('folder') : Promise.resolve(svc.net.release('folder'))), // through Bluetooth
    },
  });
  phoneHub = hub;
  hub.on('change', pushState);
  hub.on('data', (m) => win && !win.isDestroyed() && win.webContents.send('hub', m));
  const popup = () => {
    if (!callwin && !hub.call) return;
    callwin = callwin || require('../shared/callwin.js');
    callwin.update(hub, { corner: 'top', open: goTab, getLanguage: () => i18n.locale });
  };
  hub.on('call', popup);
  hub.on('change', popup);
  if (peer.current && peer.current.os === P.OS.ANDROID) hub.started();
  return hub;
}

// The window on one page (the call window's name opens Calls).
function goTab(tab) {
  if (TABS.includes(tab)) settings.ui.tab = tab; // a window made now opens there
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('go', tab);
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => {}); // keep running in the menu bar
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
app.on('before-quit', () => {
  if (svc && svc.mic) svc.mic.shutdown();
  if (svc && svc.rzShelf) svc.rzShelf.shutdown();
  if (svc && svc.rz) svc.rz.shutdown();
  quitting = true;
  if (svc && svc.phoneViews) svc.phoneViews.shutdown();
  if (svc && svc.phoneDrive) svc.phoneDrive.shutdown();
  if (phoneHub && phoneHub.audio) phoneHub.audio.stop(); // the phone's calls go back to it
  if (phoneHub && phoneHub.share) phoneHub.share.stop();
  if (callwin) callwin.close();
  if (svc && svc.wired) svc.wired.stop();
  if (svc) svc.shutdown(); // KVM home first, so the helper releases input
  if (discovery) discovery.stop();
  if (link) link.stop();
  if (server) server.close();
});
