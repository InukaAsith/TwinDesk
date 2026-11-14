// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Main process with Multi-device on (docs/multi-device.md): ../main.js starts this file instead of its
// own code when multi.json says so. Lifecycle, windows, tray, IPC, and the state pushed to the control
// window, as ../main.js, over the mesh (hub.js) instead of one peer. When a fix in ../main.js applies
// here too, make it in both.
//
// State object sent to the control window ('state' channel) on every change:
// {
//   macName, macId, fp,                       // this Mac's identity (fp = cert SHA-256 hex)
//   addresses: ['192.168.1.5', ...],           // this Mac's IPv4 addresses (the server listens on P.PORT)
//   discovery: { on, error, localNetwork },      // discovery.js status
//   found: [{ id, name, os, address, port, invited }],   // other TwinDesk computers nearby
//   guest: { status: {state, message}, pairing: null|{phase, name, address, code, error}, hosts: [...] },  // links.js
//   peers: [{id, name, os, state, rtt, role, selected, connected, direct}],   // hub.js: every device of the mesh
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

const { lanType } = require('../../shared/lantype.js'); // Wi-Fi or Ethernet for Overview (#140)
const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, systemPreferences, Notification, dialog, globalShortcut } = require('electron');

// ../main.js has set the command-line switches (WebRTC, autoplay) and the user data folder before handing over.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const P = require('../../shared/protocol.js');
const CL = require('../../shared/cursorlock.js');
const trayMenu = require('../../shared/traymenu.js');
const I18n = require('../../shared/i18n.js');
const Look = require('../../shared/look.js');
let i18n = I18n.create('en');
const t = (...args) => i18n.t(...args);
let qrPair = null; // Connection's phone pairing QR code: {nonce, until}
let adbQr = null; // wireless debugging's pairing QR code while shown (shared/adbqr.js)
const qrKnows = (nonce) => !!qrPair && typeof nonce === 'string' && nonce === qrPair.nonce && Date.now() < qrPair.until;
const store = require('./store');
const identity = require('../identity');
const { Discovery, interfaces } = require('../discovery');
const { LinkManager } = require('./links');
const { Hub } = require('./hub');
const { AutoJoin } = require('./autojoin');
const { Peer } = require('./peer');
const { Server } = require('./server');
const { Pairing } = require('./pairing');
const { Mesh } = require('../../shared/mesh.js');
const LayoutSync = require('./layout-sync'); // the mesh's shared layout (docs/mesh.md)
const { startServices } = require('./services');
const { setupIpc, TABS } = require('./ipc');
const login = require('../login');
const { Hud } = require('../hud');
const { PairSync } = require('../pairsync');
const { Phone } = require('../phone');
const { PhoneBridge } = require('./phone-bridge');
const { PhoneSet, PhoneDir } = require('./phones');
const { Adb } = require('../adb');
const { Wired } = require('./wired');
const { PhoneViews } = require('../phoneview');
const { PhoneDrive } = require('../phonedrive');
const { Updates } = require('../../shared/updates.js');
const { BleHost, BleLook } = require('../../shared/blepipe.js');
const { wifiQuiet } = require('../../shared/blepolicy.js');
const { NetLink } = require('../../shared/netlink.js');
const { aboutInfo } = require('../../shared/about.js');

let win = null;
let tray = null;
let lockKey = null; // the cursor lock key at home (shared/cursorlock.js)
let hud = null;
let modulesAtStart = []; // General › Modules: the ones off at start aren't loaded
let quitting = false;
let startHidden = process.argv.includes('--hidden');
// server: this Mac's server (many clients); links: the hosts we dial; hub: the mesh (hub.js);
// peer: the SELECTED device for the one-to-one features; phonePeer: the phone, wherever it is selected.
let autoJoin, settings, id, server, pairing, discovery, links, hub, mesh, layoutSync, peer, phonePeer, svc, actions, pairSync, updates;
let web = null; // TwinDesk Web (shared/web/webwire.js), beside the mesh as in the one-to-one app
let phoneHub = null; // Calls, Messages and Photos (loadHub); svc.hub is not used: the mesh's hub is `hub`
let devctl = null; // Overview's controls of the selected device (shared/devctl.js)
let chats = null; // Messages' chat apps from a phone, kept per phone (shared/chats.js)

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
  peers: [], // every device of the mesh (hub.peers()): name, os, state, selected, direct links
  layout: null, // the shared layout (layout-sync.js): { rev, by, cells, grid } for the Cursor tab
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
    // A throw here must not leave the window on the old state (it froze once): log it and go on.
    try {
      publishState();
    } catch (e) {
      console.error('[main] state push failed:', (e && e.stack) || e);
    }
  });
}

function publishState() {
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
    if (links) state.guest = links.view();
    state.peers = hub ? hub.peers() : [];
    state.layout = layoutSync ? layoutSync.state() : null; // the shared layout: { rev, by, cells (this Mac's view), grid, targets }
    const c = peer && peer.current;
    state.client = c ? { id: c.deviceId, name: c.name, os: c.os, role: c.role, address: c.address, rttMs: c.rttMs } : null;
    const { helper, displays, stream, clipboard: clip, kvm } = svc || {};
    state.helper.running = !!(helper && helper.running);
    if (displays) {
      const target = displays.target();
      state.sharing = {
        on: !!settings.sharing.on,
        audio: !!settings.sharing.audio,
        pace: settings.sharing.pace || 'fast',
        fps: settings.sharing.fps || 0, // Frame rate (stream.js)
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
    state.ui = settings.ui;
    state.look = Look.view(settings.ui, systemPreferences); // General › Appearance
    state.mesh = settings.mesh;
    state.app = settings.app;
    if (kvm) state.input = kvm.view;
    if (kvm && lockKey) {
      lockKey.sync(kvm.hub.bus.connectedIds().length > 0 ? settings.keys.lockKeys : '');
      state.input.lockError = lockKey.error;
    }
    if (kvm && svc) svc.fileClip.syncConnected(kvm.hub.bus.connectedIds().length > 0); // the file shortcuts too
    if (svc) state.terminal = { ...settings.terminal, ...svc.terminal.view, toPc: svc.sshClient.view };
    if (svc) state.files = { ...settings.files, ...svc.drop.view, ...svc.fileSend.view, clip: svc.fileClip.view };
    if (svc) state.notifs = { ...settings.notifs, ...svc.notifs.view };
    state.phoneMedia = svc && svc.nowPlaying ? svc.nowPlaying.view : null; // the active phone's (shared/perphone.js)
    state.history = svc && svc.history ? svc.history.view() : null; // Keep history (shared/histkeeper.js)
    state.iosSign = svc && svc.iosSign ? svc.iosSign.view : null; // TwinDesk iPhone
    if (settings) state.modules = require('../../shared/modules.js').view(settings.modules, modulesAtStart); // General › Modules
    state.deck = svc && svc.deck ? svc.deck.view() : null; // the Deck page: shown while a device has a Deck
    state.remote = svc && svc.remotes && svc.remotes.view ? svc.remotes.view // Remote tab: the active phone's
      : svc ? { allow: false, why: '', opened: false, using: false, pad: { on: false, supported: false, live: false, busy: '', message: '', name: '' } } : null;
    state.camera = svc && svc.camShare ? { ...svc.camShare.state, on: settings.camera.on !== false } : svc ? { on: false } : null; // Camera tab
    state.vcam = svc && svc.vcam ? svc.vcam.view() : svc ? { checked: true, supported: true, on: false } : null;
    // ReZume tab; mesh: why it isn't here (only with one phone, shared/rezume-solo.js)
    state.rezume = svc ? { ...(svc.rz ? svc.rz.view : { ...settings.rezume, connected: false }), mesh: svc.rzSolo ? svc.rzSolo.blocked() : '' } : null;
    state.web = web ? web.view() : { cfg: { ...settings.web }, devices: [] }; // TwinDesk Web
    state.chats = chats ? chats.view() : null; // Messages' WhatsApp, Instagram… conversations
    if (svc) {
      const { secret, ...smb } = settings.smb; // never send the share password to the window
      state.smb = { ...smb, ...svc.smb.view };
      state.apps = { ...settings.apps, ...svc.apps.view };
      state.receive = { ...settings.receive, ...svc.pcView.view };
      state.papps = { ...settings.papps, ...svc.pcApps.view };
    }
    if (svc) state.wake = svc.wake.view;
    const ctlView = devctl ? devctl.view : null;
    const onPhone = !!(state.client && (state.client.os === 'android' || state.client.os === 'ios'));
    if (svc && svc.phone) state.phone = { ...svc.phone.view, settings: settings.phone, ctl: onPhone ? ctlView : null, qs: onPhone && ctlView ? ctlView.qs || null : null, top: onPhone && ctlView ? ctlView.top || [] : [] };
    state.peerCtl = !onPhone ? ctlView : null; // a computer's controls on Overview
    if (svc && svc.net) {
      const c = peer && peer.current;
      const hs = c && settings.net.hotspots[c.deviceId];
      state.net = { ...svc.net.view, ble: settings.net.ble !== false, blePc: settings.net.blePc === true, bleWifiOff: settings.net.bleWifiOff !== false, bleOff, radio: svc.ble.state, hotspotSsid: hs ? hs.ssid : '', hotspotSaved: !!(hs && hs.pass), lan: lanType(c && c.address), tailscale: settings.net.tailscale !== false, tailnet: require('../../shared/tailnet.js').mine(), bleInput: settings.net.bleInput === true };
    }
    // General › Advanced › Engines in use (shared/engines.js): the selected device's session.
    const sel = hub && hub.facade.session;
    state.engines = peer && sel && sel.connected ? require('../../shared/engines.js').snapshot({
      current: peer.current, il: sel.il, lane: sel.lane(), fx: peer.fx, fx2: hub.sessions.fxShared.fx2 ? hub.sessions.fxShared.fx2.fx2 : null, net: svc && svc.net ? svc.net.view : null,
      lan: state.net ? state.net.lan : '', screen: stream && stream.active ? stream.view : null,
    }) : null;
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    state.hub = phoneHub ? phoneHub.view : { ...settings.hub, connected: false };
    if (svc && svc.phoneDrive) state.mount = { ...svc.phoneDrive.view, on: !!settings.mount.on };
    if (updates) state.updates = updates.view;
    if (pairSync) pairSync.check();
    sendScreenState();
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
    updateTray();
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
  if (m.mode === 'extend' || m.mode === 'mirror') {
    if (displayMode() !== m.mode) actions.setDisplayMode(m.mode);
  }
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
    const done = (resetErr) => {
      if (resetErr) return console.warn(`[permissions] reset skipped or failed: ${resetErr.message}`);
      settings.app.signature = m[1];
      store.saveSettings(settings);
      refreshPermissions();
    };
    if (services.length) console.log(`[permissions] new signature: resetting ${services.join(', ')}`);
    require('../permission-reset').resetMissing(bundle, services, require('child_process').execFile, done);
  });
}

// Setup shows once: when everything is allowed it's done for good (like Skip for now).
function setupSeen() {
  const p = state.permissions;
  if (settings.ui.setupDone || p.screen !== 'granted' || !p.accessibility || p.inputMonitoring !== true) return;
  settings.ui.setupDone = true;
  store.saveSettings(settings);
}

// A new language restarts TwinDesk: every window then loads English and that language only
// (shared/lang/pick.js), not every catalog. Settings are already saved (synchronously).
function changeLanguage() {
  app.relaunch();
  app.quit(); // as Quit does: before-quit gives everything back (KVM, calls, the helper)
}

// General › Appearance changed: the theme; the window's vibrancy only for Simple (Glass paints its
// gradient over the whole window, the sidebar a frosted pane on it, so a blur under it would show nothing).
function applyLook() {
  Look.applyTheme(nativeTheme, settings.ui.theme);
  if (win && !win.isDestroyed()) win.setVibrancy(Look.style(settings.ui.style) === 'glass' ? null : 'sidebar');
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
    vibrancy: Look.style(settings.ui.style) === 'glass' ? undefined : 'sidebar', // Simple's (applyLook)
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
  win.loadFile(path.join(__dirname, 'control.html'), { query: { language: i18n.locale, look: Look.style(settings.ui.style), off: modulesAtStart.join(',') } });
  win.once('ready-to-show', () => {
    if (startHidden) startHidden = false; // started at login: stay in the menu bar
    else showWindow();
  });
  // In the Dock and ⌘-Tab only while the window is open; menu bar only otherwise.
  win.on('show', dockIcon);
  win.on('hide', dockIcon);
  win.on('closed', dockIcon);
  win.on('focus', refreshPermissions);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
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

// Menu bar: the app mark as a template icon; its menu by kind (shared/traymenu.js), only connecting
// while nothing is connected.
function updateTray() {
  if (!tray) return;
  const c = state.client;
  const name = c ? c.name : t('the other computer');
  const k = settings.kvm;
  const where = state.input && state.input.where;
  tray.setToolTip(c ? `TwinDesk: ${c.name}` : 'TwinDesk');
  const found = (state.found || []).filter((d) => !c || d.id !== c.id);
  const other = c ? name : t('Other Computer');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu.template({
    t,
    connected: !!c,
    status: c ? t('Connected to {name}', { name: c.name }) + (c.rttMs != null ? ' · ' + t('{ms} ms', { ms: c.rttMs }) : '') : t('Not connected'),
    home: where === 'driving' || where === 'driven' ? () => svc.kvm.home() : null,
    shared: { checked: k.linked !== false, set: (on) => actions.setKvm({ linked: on }) },
    lock: c ? { label: t('Lock Cursor on {name} ({key})', { name: where === 'driving' ? name : id.macName, key: CL.keysLabel(settings.keys.lockKeys, 'mac') }), checked: svc && svc.kvm.locked, set: (on) => svc.kvm.setLocked(on) } : null,
    keyboard: { checked: k.keyboard, set: (on) => actions.setKvm({ keyboard: on }) },
    drive: { label: t('Use Mouse and Keyboard on {name}', { name: other }), checked: k.driveOther, set: (on) => actions.setKvm({ driveOther: on }) },
    driven: { label: t('Let {name} Control {me}', { name: other, me: id.macName }), checked: k.beDriven, set: (on) => actions.setKvm({ beDriven: on }) },
    popup: { checked: settings.app.hud !== false, set: (on) => actions.setApp({ hud: on }) },
    screen: [
      { label: t('Share Screen'), checked: settings.sharing.on, set: (on) => actions.setSharing(on) }, // in the mode picked here
      { label: t('Extend'), checked: !!settings.sharing.on && displayMode() === 'extend', set: (on) => shareAs(on ? 'extend' : null) },
      { label: t('Mirror'), checked: !!settings.sharing.on && displayMode() === 'mirror', set: (on) => shareAs(on ? 'mirror' : null) },
      { sep: true },
      { label: t('Receive Screen'), checked: svc && svc.pcView.isOpen, set: (on) => (on ? actions.showPcView() : actions.closePcView()) },
    ],
    clipboard: { checked: settings.clipboard.enabled, set: (on) => actions.setClipboard({ enabled: on }) },
    sound: { checked: settings.audio.send, set: (on) => actions.setAudio({ send: on }) },
    drag: { checked: settings.files.dragEdge !== false, set: (on) => actions.setFiles({ dragEdge: on }) },
    shortcuts: { label: t('Copy and Paste Files ({copy}, {paste})', { copy: CL.keysLabel(settings.files.copyKeys, 'mac'), paste: CL.keysLabel(settings.files.pasteKeys, 'mac') }), checked: settings.files.shortcuts !== false, set: (on) => actions.setFiles({ shortcuts: on }) },
    found: found.map((d) => ({ label: `${d.name} (${d.os === 'mac' ? 'Mac' : d.os === 'linux' ? 'Linux' : 'PC'})`, click: () => actions.pairWith(d.id) })),
    byAddress: () => { actions.setTab('connection'); showWindow(); },
    lookAgain: () => actions.refreshDiscovery(),
    update: updates && updates.status.available ? { label: t('TwinDesk {version} available…', { version: updates.status.latest }), click: showUpdateWindow } : null,
    open: showWindow,
    log: () => require('../../shared/applog.js').open(),
    quit: () => app.quit(),
  })));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  // Dev runs show Electron's icon otherwise; the built app has it in its bundle.
  if (app.dock && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', '..', 'shared', 'icon', 'teindesk-dark-mac.png'));
  store.init(app.getPath('userData'));
  settings = store.loadSettings();
  modulesAtStart = require('../../shared/modules.js').normalize(settings.modules).off.filter((id) => id !== 'multi'); // General › Modules: fixed for this run (the window's scripts are)
  require('../../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
  // Quiet links (#143): an idle session stops pinging every second; General › Advanced › Keep pinging.
  require('../../shared/quiet.js').use(() => !!(settings && settings.app && settings.app.keepPinging === true));
  require('../../shared/tailnet.js').use(() => !(settings && settings.net && settings.net.tailscale === false)); // General › Tailscale (#161)
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  id = identity.load(settings);
  Object.assign(state, { macName: id.macName, macId: id.macId, fp: id.fp, version: app.getVersion(), about: aboutInfo(app) });
  console.log(`[main] ${id.macName} (${id.macId}) fp ${id.fp}`);

  server = new Server(id);
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
  mesh = new Mesh({ selfId: id.macId });
  pairing = new Pairing(server, id);
  pairing.on('change', pushState);
  pairing.on('request', showWindow);
  server.on('phoneFree', () => { links.poke(); pushState(); });
  links = new LinkManager({
    device: { id: id.macId, name: id.macName },
    hostPairing: pairing,
    resolveAddress: (macId) => discovery.get(macId),
  });
  links.on('change', pushState);
  links.on('request', showWindow);
  hub = new Hub({ device: { id: id.macId, name: id.macName }, links, mesh, server, pairing });
  hub.on('change', pushState);
  // Joining everyone (autojoin.js, shared/intro.js): the devices a connected device knows are linked by themselves.
  autoJoin = new AutoJoin({
    hub, mesh, pairing, links, identity: id, server,
    enabled: () => settings.mesh.autoJoin !== false,
    onJoin: () => pushState(),
  });
  // The shared layout (docs/mesh.md, "Shared layout"): where every device sits. The cursor's edges come from it.
  // A Mac from before the layout: its one PC on pcSide becomes the layout once (legacyEdges).
  layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id.macId,
    storage: { get: () => settings.layout, set: (l) => { settings.layout = l; store.saveSettings(settings); } },
    knownIds: () => hub.peers().map((p) => p.id),
    canDrive: (pid) => { const s = hub.sessions.get(pid); return !!s && s.connected; }, // the Multi-device tab's reach
    endsChain: (pid) => { const s = hub.sessions.get(pid); return !!s && P.isPhoneOs(s.peerOs); },
    legacyEdges: () => {
      const k = settings.kvm || {};
      if (k.edges && Object.values(k.edges).some(Boolean)) return k.edges;
      const pcs = hub.peers().filter((p) => p.state !== 'via' && !P.isPhoneOs(p.os));
      return pcs.length === 1 && k.pcSide ? { [k.pcSide]: pcs[0].id } : null;
    },
    onChange: () => {
      if (svc) svc.kvm.layoutChanged();
      pushState();
    },
  });
  // One-to-one features follow the SELECTED device; the phone follows the phone (see hub.js).
  peer = new Peer(hub.facade, server);
  peer.on('client', (ctx) => {
    console.log(`[peer] session with ${ctx.name} (${ctx.os}, ${ctx.role === 'host' ? 'we are its guest' : 'it is our guest'})`);
    peer.send(ctx, { t: P.T.STREAM_INPUT, on: settings.streamInput !== false });
    pushState();
  });
  peer.on('closed', pushState);
  peer.on('rtt', pushState);
  // Overview's controls of the selected device, and this Mac's for it (shared/devctl.js).
  {
    const { DevCtl } = require('../../shared/devctl.js');
    const { DevLocal } = require('../../shared/devlocal.js');
    devctl = new DevCtl({
      link: {
        on: (ev, fn) => (ev === 'welcome' ? peer.on('client', fn) : ev === 'closed' ? peer.on('closed', fn) : peer.on('t:' + ev, fn)),
        send: (m) => peer.sendToClient(m),
        get current() { return peer.current; },
      },
      local: new DevLocal(),
      version: app.getVersion(),
      adb: () => {
        const br = svc && svc.phone && svc.phone.bridge;
        return br && br.state === 'ready' && br.serial ? { adb: br.adb, serial: br.serial } : null;
      },
    });
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
    chats = new Chats({ link: {
        on: (ev, fn) => (ev === 'welcome' ? peer.on('client', fn) : ev === 'closed' ? peer.on('closed', fn) : peer.on('t:' + ev, fn)),
        send: (m) => peer.sendToClient(m),
        get current() { return peer.current; },
      }, dir: app.getPath('userData'), want: () => settings.ui.chats === true, onChange: pushState });
  }
  hub.start();

  svc = startServices({ server: peer, getSettings: () => settings, pushState, onHelperReady: refreshPermissions,
    hub, mesh, layoutSync, selfName: () => id.macName });
  // Audio › Microphone (shared/mic.js): loaded the first time one of its switches is on.
  svc.loadMic = () => {
    if (svc.mic || !(settings.audio.micSend || settings.audio.micReceive)) return svc.mic || null;
    const { Mic } = require('../../shared/mic.js');
    const askMic = () => (systemPreferences.getMediaAccessStatus('microphone') === 'granted' ? Promise.resolve(true) : systemPreferences.askForMediaAccess('microphone'));
    svc.mic = new Mic({ server: svc.audioPeer || peer, cfg: () => settings.audio, onChange: pushState, platform: 'mac', askMic, meshHub: hub });
    return svc.mic;
  };
  svc.loadMic();
  // Apps › Move windows: a window grabbed with the move key crossed with the pointer. A
  // copy of the other computer's window goes home there (pcapps.js); one of this Mac's goes over (appsend.js).
  svc.kvm.onMoveWindow = (m, to) => {
    const wid = Number(m.moving);
    if (to && to !== hub.selectedId) return; // apps and windows go to the selected device only
    if (!wid || svc.pcApps.returnWindow(wid)) return;
    if (settings.apps.moveWindows) svc.appSend.moveOut(wid, Number(m.movingPid));
  };
  if (settings.app.openAtLogin !== login.isOn()) login.apply(settings.app.openAtLogin);

  // Every phone gets its own stack (phone.js, phone-bridge.js, phoneview.js) on a link bound to it (phones.js);
  // svc.phone is also the single-phone API for the active one. One adb for all of them.
  const adb = new Adb();
  const phoneDir = new PhoneDir(hub, server);
  svc.wired = new Wired({ adb, raw: server, peer: phoneDir, getId: () => id.macId, getName: () => id.macName,
    hasPhone: () => pairing.list().some((x) => P.isPhoneOs(x.os)) });
  pairing.isWired = (nonce) => svc.wired.knows(nonce) || qrKnows(nonce); // the cable, or Connection's QR code (Allow only)
  pairing.isQr = qrKnows;
  pairing.consumeQr = () => { qrPair = null; }; // a QR pairing that went through: the link is single-use
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
    const br = svc.phone && svc.phone.bridge; // the active phone's
    if (on && br && br.adb.available) {
      adbQr = require('../../shared/adbqr.js').startAdbQr({
        adb: br.adb,
        onPaired: () => br.pairedNow(),
        onEnd: (why) => { adbQr = null; state.adbQr = { done: why }; pushState(); },
      });
      state.adbQr = { text: adbQr.text };
    }
    pushState();
  };
  svc.wired.on('change', pushState);
  // An iPhone's or iPad's session through its USB cable (shared/iosnet.js: usbmuxd to the app's port):
  // this server and the WebRTC relay (wired.js), nothing else.
  svc.iosNet = new (require('../../shared/iosnet.js').IosNet)({
    getId: () => id.macId, getName: () => id.macName,
    allowed: (port) => port === server.port || port === svc.wired.turnPort,
  });
  svc.iosNet.on('change', () => { if (svc.iosNet.view.devices.some((d) => d.app)) svc.wired.relay(); pushState(); });
  // What plays on each phone, for the Overview's media controls (one shared/nowplaying.js per phone,
  // shared/perphone.js), while Audio › Media controls is on; the active phone's is shown.
  svc.nowPlaying = require('../../shared/perphone.js').phoneMedia({
    NowPlaying: require('../../shared/nowplaying.js').NowPlaying, cfg: () => settings.audio, onChange: pushState, phones: () => svc.phone,
  });
  svc.loadNowPlaying = () => svc.nowPlaying;
  // Each phone's Remote page drives this Mac (shared/phone-remote.js, one per phone), made once Remote
  // or Keyboard's voice typing is on; the Remote page shows the active phone's.
  svc.remotes = require('../../shared/perphone.js').phoneRemote({
    PhoneRemote: require('../../shared/phone-remote.js').PhoneRemote,
    opts: { helper: svc.helper, getSettings: () => settings, atHome: () => svc.kvm.mode === 'home', onChange: pushState,
      padNote: 'Real gamepad isn’t on the Mac. To use {name} as a gamepad, turn on Remote › As a Bluetooth gamepad on {name}, then pair it with this Mac in System Settings › Bluetooth' },
    wanted: () => !!(settings.remote.allow !== false || settings.kvm.keyboard),
    phones: () => svc.phone,
  });
  svc.loadRemote = () => (svc.remotes.load() ? svc.remotes : null);
  svc.remote = () => (svc.remotes.loaded ? svc.remotes : null);
  svc.kvm.on('where', () => svc.remotes.refresh()); // the phones' Remote is taken only with the mouse at home
  // TwinDesk iPhone (shared/iossign.js): TwinDesk for iPhone signed with the person's Apple ID, for
  // whichever iPhone connected or spoke last (shared/perphone.js anyPhone). Off in General › Modules: not loaded.
  svc.anyPhone = require('../../shared/perphone.js').anyPhone({ want: (c) => c.os === P.OS.IOS }); // TwinDesk iPhone: one iPhone at a time
  if (!modulesAtStart.includes('iossign')) svc.iosSign = require('../../shared/iossign-host.js').create({
    app, safeStorage: require('electron').safeStorage, link: svc.anyPhone.link,
    near: { list: () => (svc.ble ? svc.ble.list() : []), invite: (devId) => svc.ble && svc.ble.invite(devId) }, // iPhones linked over Bluetooth
    usbSerials: () => (svc.iosNet ? svc.iosNet.view.devices.filter((d) => d.app).map((d) => d.serial) : []),
    onChange: pushState,
  });
  // The Deck (shared/deck.js): each phone's buttons run here, one Deck per phone (deck.add), and a web
  // device's (deck.web). Not loaded at all while its module is off (General › Modules).
  if (!modulesAtStart.includes('deck')) {
    const { clipboard: cb } = require('electron');
    svc.deck = require('../../shared/deck.js').startDeck({
      platform: 'mac', helper: svc.helper, server: null, settings: () => settings, saveSettings: () => store.saveSettings(settings),
      readClipboard: () => cb.readText(), onChange: pushState,
    });
  }
  const { PcNow } = require('../../shared/pcnow.js');
  svc.phone = new PhoneSet({
    hub, link: phoneDir, raw: server, discovery, pairing, wired: svc.wired,
    make: (scoped) => {
      const ph = new Phone({ server: scoped, raw: server, discovery, pairing });
      const bridge = new PhoneBridge({ server: scoped, phone: ph, getSettings: () => settings, clipboard: svc.clipboard, adb });
      ph.bridge = bridge;
      ph.wired = svc.wired;
      bridge.wired = svc.wired;
      const views = new PhoneViews({ bridge, phone: ph, getSettings: () => settings, server: scoped, fileSend: svc.fileSend });
      return { phone: ph, bridge, views };
    },
    onUnit: (u) => {
      u.phone.on('change', pushState);
      // The phone's Keyboard page names this Mac's hotkey (double-tap = everything back here).
      u.link.on('client', () => u.link.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_MAC) }));
      u.bridge.on('change', pushState);
      u.views.on('change', pushState);
      if (svc.vcam) u.views.vcam = svc.vcam; // a phone's camera feeds the virtual camera too
      u.bridge.on('popup', (kind, text) => hud.show(kind, text));
      u.bridge.on('save', () => store.saveSettings(settings));
      svc.nowPlaying.unit(u);
      svc.remotes.unit(u);
      svc.anyPhone.unit(u);
      if (svc.deck) svc.deck.add(u.link); // that phone's Deck runs here
      // What plays on this Mac, for that phone's Media page and its media notification (shared/pcnow.js).
      new PcNow({ server: u.link, key: (code) => {
        svc.helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
        svc.helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
      } });
    },
  });
  svc.phone.on('change', pushState);
  svc.phoneViews = svc.phone.viewsProxy; // the windows of the active phone
  // ReZume (shared/rezume.js) between this Mac and a phone, while that phone is the only device
  // connected (shared/rezume-solo.js): between two computers it needs Multi-device off. Loaded the
  // first time it's turned on; its offers in the Dock (dockstub.js), the menu bar and a notification.
  const RzSolo = require('../../shared/rezume-solo.js');
  svc.rzSolo = RzSolo.soloLink({ bus: hub.bus, sessions: hub.sessions });
  hub.bus.on(P.T.RZ_POLICY, (m, from) => { if (!svc.rz && from && from === svc.rzSolo.id()) hub.bus.send(from, { t: P.T.RZ_POLICY, on: false, web: false, docs: false, apps: false, push: false }); }); // off here: the phone shows it off
  svc.loadRezume = () => {
    if (svc.rz || !settings.rezume.on) return svc.rz || null;
    const { shell } = require('electron');
    const { ReZume } = require('../../shared/rezume.js');
    const { ReZumeShelf } = require('../../shared/rezume-shelf.js');
    const { DockStub } = require('../dockstub');
    svc.rzAct = require('../activity').create({ cfg: () => settings.rezume });
    const solo = () => (svc.rzSolo.id() ? svc.phone.unit(svc.rzSolo.id()) : null);
    const name = () => { const p = svc.rzSolo.link.peer(); return p ? p.name : 'the phone'; };
    svc.rz = new ReZume({
      link: svc.rzSolo.link,
      cfg: () => settings.rezume,
      detect: () => svc.rzAct.detect(),
      // Looks only when the app or window in front changed (the helper's frontWatch).
      watch: (() => {
        let fn = null;
        const onEvent = (n) => n === 'front' && fn && fn();
        const arm = () => fn && svc.helper.request('frontWatch', { on: true }).catch(() => {});
        svc.helper.on('event', onEvent);
        svc.helper.on('ready', arm); // a restarted helper watches again
        return {
          start: (f) => { fn = f; return svc.helper.request('frontWatch', { on: true }).then((r) => !!r.ax); },
          stop: () => { fn = null; svc.helper.send('frontWatch', { on: false }); },
        };
      })(),
      appIcon: (a) => svc.rzAct.appIcon(a),
      open: { url: (u) => shell.openExternal(u), file: (p) => shell.openPath(p), phoneApp: (pkg, n) => { const u = solo(); if (u) u.views.openApp(pkg, n || (u.phone.apps.find((a) => a.id === pkg) || {}).name); } },
      cacheDir: path.join(app.getPath('temp'), 'TwinDesk ReZume'),
      pick: (o, ways) => require('../../shared/rzpick.js').pick(o, ways, { peer: name(), language: i18n.locale }),
      adb: () => { const u = solo(); return RzSolo.phoneAdb(u && u.bridge); },
      phoneApps: () => { const u = solo(); return (u && u.phone.apps) || []; },
      save: () => store.saveSettings(settings),
    });
    svc.rz.on('change', pushState);
    svc.rz.on('opened', (o) => hud && hud.show('home', { key: o.how === 'sent' ? 'Sent to {name}: {title}' : 'From {name}: {title}', vars: { name: name(), title: o.title } }));
    let stub = null;
    const dock = {
      show(o, take, dismiss) {
        if (stub) stub.stop();
        stub = new DockStub({ id: 'rezume:' + (o.app || o.kind), name: (o.appName || 'ReZume') + ' (ReZume)', icon: o.icon }, (ev) => (ev === 'quit' ? dismiss() : take()));
        stub.menu([o.title || o.name || o.appName || '']);
      },
      hide() { if (stub) { stub.stop(); stub = null; } },
    };
    svc.rzShelf = new ReZumeShelf({ rezume: svc.rz, cfg: () => settings.rezume, peerName: name, dock, badge: path.join(__dirname, '..', 'assets', 'sidebar-icon@4x.png') });
    svc.rz.apply();
    return svc.rz;
  };
  svc.rezume = () => svc.rz || null;
  try { svc.loadRezume(); } catch (e) { console.error('[rezume] couldn’t start: ' + (e && e.stack || e)); svc.rz = null; }
  // Camera tab: the selected computer's camera here and this Mac's there (shared/camshare.js, over
  // peer: the selected device), a phone's through its own stack (phoneview.js openCamera), loaded
  // only while Camera is on. Camera › Virtual camera (shared/vcam.js, ../vcam.js): the running
  // camera's picture also goes to a camera apps can pick.
  const tellPhones = () => { for (const u of svc.phone.all || []) u.bridge._tellPhone(); }; // each phone's Camera page says so
  svc.loadVcam = () => {
    if (svc.vcam) return svc.vcam;
    const { VirtualCam } = require('../../shared/vcam.js');
    svc.vcam = new VirtualCam({
      driver: require('../vcam'),
      cfg: () => settings.camera,
      save: () => store.saveSettings(settings),
      onChange: pushState,
      onReady: tellPhones,
      ui: () => win,
    });
    for (const u of svc.phone.all || []) u.views.vcam = svc.vcam;
    svc.vcam.check();
    return svc.vcam;
  };
  svc.loadCamera = () => {
    if (svc.camShare || settings.camera.on === false) return svc.camShare || null;
    const { CamShare } = require('../../shared/camshare.js');
    // A computer; a phone's camera goes through its own stack.
    const computer = () => !!peer.current && !P.isPhoneOs(peer.current.os);
    svc.loadVcam();
    svc.camShare = new CamShare({
      getLanguage: () => i18n.locale,
      link: {
        on: (t, fn) => (t === 'welcome' ? peer.on('client', (ctx) => !P.isPhoneOs(ctx.os) && fn()) : peer.on(`t:${t}`, (m) => fn(m))),
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
    svc.camShare.sendPolicy(); // connected already: the selected computer hears whether it's shared
    return svc.camShare;
  };
  svc.cam = () => ({ camShare: svc.camShare || null, vcam: svc.vcam || null });
  // Camera's switch: on loads it; off, whatever runs stops (every phone's camera too) and nothing is shared.
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
      for (const u of svc.phone.all || []) for (const v of u.views.list()) if (v.kind === 'camera') u.views.close(v.id);
    }
    tellPhones();
    pushState();
  };
  svc.loadCamera();
  // A phone notification clicked here: its app in a window (on the phone it came from).
  svc.clipboard.on('popup', (kind, text) => hud && hud.show(kind, text)); // a picture from another device
  svc.notifs.on('click', (m) => {
    const u = svc.phone.unit(m.originId);
    if (u && u.link.current) u.views.openNotified(m.app, m.appName);
  });
  // The phone in Finder, through adb (the cable, else wireless debugging): only when Mount is clicked.
  svc.phoneDrive = new PhoneDrive({ adb, bridge: svc.phone.bridgeProxy, phone: svc.phone });
  svc.phoneDrive.on('change', pushState);
  svc.kvm.attachLocal(svc.phone);
  setupNet();
  setupHub();
  const blockEdge = svc.kvm.blockEdge;
  svc.kvm.blockEdge = () => blockEdge() || svc.phone.focused; // moving inside the phone window never crosses
  svc.apps.setSharing = (on, by) => actions.setSharing(on, by);
  peer.on(`t:${P.T.SCREEN_CTL}`, (m) => onScreenCtl(m));
  // Two-way switches shared with the other computer, per pair (pairsync.js).
  const SYNC_ACTIONS = {
    clipboard: (dir, on) => actions.setClipboard({ [dir === 'out' ? 'send' : 'receive']: on }),
    notifs: (dir, on) => actions.setNotifs({ [dir === 'out' ? 'send' : 'receive']: on }),
    apps: (dir, on) => (dir === 'out' ? actions.setApps({ offer: on }) : actions.setPcApps({ on })),
    audio: (dir, on) => actions.setAudio({ [dir === 'out' ? 'send' : 'receive']: on }),
    cursor: (dir, on) => actions.setKvm({ [dir === 'out' ? 'driveOther' : 'beDriven']: on }),
    terminal: (dir, on) => { actions.setTerminal({ [dir === 'out' ? 'allowPc' : 'connectPc']: on }); if (dir === 'in') svc.sshClient.applySettings(); }, // already set: setTerminal sees no change
    files: (dir, on) => actions.setFiles({ acceptDrops: on }),
  };
  pairSync = new PairSync({ server: peer, bus: hub.bus,
    peerRole: (id) => { const s = hub.sessions.get(id); return s ? s.role : null; },
    peerOs: (id) => { const s = hub.sessions.get(id); return s ? s.peerOs : null; },
    getSettings: () => settings, saveSettings: () => store.saveSettings(settings), only: Object.keys(SYNC_ACTIONS), // no ReZume or Remote here
    apply: (f, dir, on) => (f !== 'value' ? SYNC_ACTIONS[f](dir, on)
      : ['gestures', 'keyboard', 'speed', 'reverseScroll', 'syncPads'].includes(dir) ? actions.setKvm({ [dir]: on }) : actions.setSharingOpts({ [dir]: on })) });
  // New releases on GitHub: a notification once per version, the menu bar item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'mac', getSettings: () => settings, getLanguage: () => i18n.locale,
    isBusy: () => !!(hub && hub.bus && hub.bus.connectedIds().length), // Install automatically waits until no device is connected
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
  setupWeb();
  actions = setupIpc({ devctl: () => devctl, chats: () => chats, state, settings, pushState, onLanguage: changeLanguage, onLook: applyLook, t, server: peer, pairing, discovery, link: links, ...svc, hub, layoutSync, autoJoin, phoneHub: loadHub, login, refreshPermissions, updates });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'))); // "Template": macOS tints it
  hud = new Hud(() => settings);
  svc.kvm.on('where', (mode) => {
    const name = peer.current ? peer.current.name : { key: 'the other computer' };
    if (mode === 'driving') hud.show('away', { key: settings.kvm.mouse ? 'Using {name}' : 'Typing on {name}', vars: { name } });
    else if (mode === 'driven') hud.show('driven', { key: '{name} is using {me}', vars: { name, me: id.macName } });
    else hud.show('home', { key: 'Back on {me}', vars: { me: id.macName } });
  });
  // Cursor lock: the popup goes where the pointer is (the other computer shows its own while we drive it).
  svc.kvm.on('lock', (on, mode) => {
    if (mode === 'driving' && !(svc.kvm.local && svc.kvm.local.drives(svc.kvm.partner))) return;
    const where = mode === 'driving' ? (peer.current ? peer.current.name : { key: 'the other computer' }) : id.macName;
    hud.show('lock', { key: on ? 'Cursor locked on {name}' : 'Cursor unlocked', vars: { name: where } });
  });
  // The lock key at home: a global shortcut, held while connected (pushState syncs it).
  lockKey = new CL.GlobalLockKey(globalShortcut, () => svc.kvm.toggleLock());

  svc.fileClip.on('popup', (kind, text) => hud.show(kind, text));
  svc.pcApps.on('popup', (kind, text) => hud.show(kind, text));
  if (app.isPackaged) app.setAsDefaultProtocolClient('macshare');
  for (const url of linkQueue.splice(0)) handleLink(url);
  // The hotkey's double-tap: the big card "Cursor sharing on/off" (also when the other side switched it).
  svc.kvm.on('linked', (on, here) => {
    const name = peer.current ? peer.current.name : '';
    const key = P.hotkeyName(settings.keys.hotkey);
    const sub = !here && name ? { key: on ? 'Turned on on {name}' : 'Turned off on {name}', vars: { name } }
      : on ? { key: name ? 'With {name}. Double-tap {key} to turn it off' : 'Double-tap {key} to turn it off', vars: { name, key } }
        : { key: 'Double-tap {key} to turn it on', vars: { key } };
    hud.show(on ? 'linkOn' : 'linkOff', { key: on ? 'Cursor sharing on' : 'Cursor sharing off' }, sub);
  });
  svc.drop.on('batch', (b) => {
    if (b.kind === 'send') hud.show('driven', { key: b.files === 1 ? 'Received {count} file from {name}' : 'Received {count} files from {name}', vars: { count: b.files, name: peer.current ? peer.current.name : { key: 'the other computer' } } });
  });
  createWindow();
  refreshPermissions();
  if (process.env.MACSHARE_DEV_TEST) require('../dev/m2m')({ role: process.env.MACSHARE_DEV_TEST, svc, actions, link: links, pairing, peer });
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

// iPhones and iPads in a session (their Bluetooth link is held through quiet: BleHost hold).
const iosSessions = () => (hub ? hub.sessions.list().filter((s) => s.connected && s.peerOs === P.OS.IOS) : []);
const iosNow = () => iosSessions().length > 0;

// An iPhone or iPad linked over Bluetooth but not in a session (it links only to computers it's
// paired with): invited now and then, which wakes TwinDesk there to come back (its Ble.swift).
let iosInvitedAt = 0;
function inviteIos() {
  if (!svc.ble || bleOff || Date.now() - iosInvitedAt < 20000) return;
  const on = new Set(iosSessions().map((s) => s.id));
  for (const g of svc.ble.list()) {
    if (g.os !== P.OS.IOS || on.has(g.id)) continue;
    iosInvitedAt = Date.now();
    svc.ble.invite(g.id);
  }
}
function setupNet() {
  const { safeStorage } = require('electron');
  svc.ble = new BleHost({
    helper: svc.helper, server,
    info: () => ({ id: id.macId, name: id.macName.slice(0, 40), os: P.OS.MAC, port: server.port, fp: id.fp }),
    enabled: () => !bleOff && (settings.net.ble !== false || settings.net.blePc === true),
    accept: (g) => (P.isPhoneOs(g.os) ? settings.net.ble !== false : settings.net.blePc === true), // General's two Bluetooth switches
    // Quiet on Wi-Fi with an iPhone or iPad in the session or linked: its link stays (idle, slow, no
    // advertising: the helper's bleHold), as it's what wakes TwinDesk there when iOS suspends it and
    // what the session falls back to. Advertising comes back only if that link drops.
    hold: () => settings.net.ble !== false && (iosNow() || svc.ble.list().some((g) => g.os === P.OS.IOS)),
    // …but advertising until every iPhone or iPad in a session has linked (another device's link
    // kept it silent: an iPhone paired over Wi-Fi never found it, and fell back to nothing).
    holdAds: () => iosSessions().some((s) => !svc.ble.list().some((g) => g.id === s.id)),
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
    else if (off) svc.ble.apply(); // an iPhone linked or gone while quiet: held or stopped (hold)
    svc.bleLook.look(settings.net.blePc === true && !peer.current);
    inviteIos();
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
  peer.fx.active = () => svc.net.touch('files'); // fast files on a link made for them keep it up, as file.chunk does
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
  peer.on('client', (ctx) => P.isPhoneOs(ctx.os) && !phoneHub && anyOn() && loadHub());
  // The phone shares a folder: loaded for it (its listener comes with it, so this one passes it on).
  peer.on(`t:${P.T.SHARE_OFFER}`, (m, ctx) => ctx && P.isPhoneOs(ctx.os) && !phoneHub && loadHub().share && phoneHub.share.onOffer(m));
  peer.on(`t:${P.T.SHARE_SET}`, (m, ctx) => ctx && P.isPhoneOs(ctx.os) && !phoneHub && loadHub().share && phoneHub.share.act('serve', { on: !!m.serve }));
}

let callwin = null;
function loadHub() {
  if (phoneHub) return phoneHub;
  const { PhoneHub } = require('../../shared/phonehub.js');
  const hub = new PhoneHub({
    server: peer, getSettings: () => settings, save: () => store.saveSettings(settings),
    audio: (opts) => require('../callaudio.js').create({ helper: svc.helper, ...opts }), // the calls' sound over Bluetooth
    send: (paths, batch) => !!(svc.fileSend && svc.fileSend.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
    shareSheet: (paths) => new (require('electron').ShareMenu)({ filePaths: paths }).popup(win && !win.isDestroyed() ? { browserWindow: win } : {}), // Photos › Share
    choose: () => dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openFile', 'openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths)),
    share: { // shared folders with the phone (shared/foldershare.js)
      mounter: require('../phonedrive').mounter, adb: svc && svc.phone.bridge.adb, serialOf: (id) => svc && svc.wired && svc.wired.serialOf(id),
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
    callwin = callwin || require('../../shared/callwin.js');
    callwin.update(hub, { corner: 'top', open: goTab, getLanguage: () => i18n.locale });
  };
  hub.on('call', popup);
  hub.on('change', popup);
  if (peer.current && P.isPhoneOs(peer.current.os)) hub.started();
  return hub;
}

// The window on one page (the call window's name opens Calls).
function goTab(tab) {
  if (TABS.includes(tab)) settings.ui.tab = tab; // a window made now opens there
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('go', tab);
}

app.on('second-instance', showWindow);
// TwinDesk Web in Multi-device: the same server, pairings and pages as the one-to-one app (one
// userData), with this Mac's screen mirrored (Extend stays the mesh's), its sound, input and the rest.
function setupWeb() {
  const { ipcMain, shell } = require('electron');
  const { startWeb } = require('../../shared/web/webwire.js');
  const { Input } = require('../input');
  const { PhoneRemote } = require('../../shared/phone-remote.js');
  const { DevLocal } = require('../../shared/devlocal.js');
  const apple = (c) => !!c && ['ios', 'ipados', 'mac'].includes(c.os);
  const save = () => store.saveSettings(settings);
  web = startWeb({
    dir: app.getPath('userData'), root: path.join(__dirname, '..', '..'), t,
    settings: () => settings, save, pushState,
    self: () => ({ id: id.macId, name: id.macName, os: 'mac', version: app.getVersion() }),
    receivedDir: () => settings.files.folder || app.getPath('downloads'),
    say: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      try {
        const n = new Notification({ title, body });
        if (onClick) n.on('click', onClick);
        n.show();
      } catch {}
    },
    reveal: (p) => shell.showItemInFolder(p),
    open: (p) => shell.openPath(p),
    capture: { audio: 'helper', hub: svc.hub, worklet: path.join(__dirname, '..', 'pcm-worklet.js') },
    extend: null,
    input: (bus, target) => new Input(bus, svc.helper, { target: () => target() }, {
      enabled: () => settings.web.control !== false && (!svc.kvm || svc.kvm.mode === 'home'),
      swapKeys: () => !apple(bus.current) && settings.keys.swapCtrlCmd !== false,
    }),
    remote: (bus, getSettings) => new PhoneRemote({ server: bus, helper: svc.helper, getSettings, atHome: () => !svc.kvm || svc.kvm.mode === 'home', onChange: pushState,
      padNote: 'Real gamepad isn’t on the Mac: the gamepad’s buttons work as keys' }),
    deck: svc.deck ? (bus) => svc.deck.web(bus) : null, // the Deck module off: TwinDesk Web shows none
    notifs: svc.notifs,
    devLocal: (devctl && devctl.local) || new DevLocal(),
    smbInfo: () => {
      const c = settings.smb;
      const pw = c.sharing && svc.smb.password ? svc.smb.password() : '';
      if (!pw) return { on: false };
      const host = web ? web.hub.host : require('os').hostname();
      return { on: true, host, share: 'MacShare', user: 'macshare', password: pw, path: c.folder || path.join(require('os').homedir(), 'MacShare'), url: `smb://${host}/MacShare` };
    },
    share: {
      view: () => {
        const v = svc.smb.view;
        return { on: !!settings.smb.sharing, busy: v.shareBusy ? 'setup' : '', error: v.shareError || '', folder: settings.smb.folder || v.defaultFolder, name: 'MacShare', user: 'macshare' };
      },
      set: (on) => (on ? svc.smb.startSharing() : svc.smb.stopSharing()),
      async choose(folder) {
        if (settings.smb.sharing) await svc.smb.stopSharing();
        settings.smb.folder = folder;
        save();
        svc.smb.startSharing(folder);
      },
    },
    key: (code) => {
      svc.helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
      svc.helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
    },
    fileClip: svc.fileClip && svc.fileClip.offerLocal ? svc.fileClip : null,
  });
  if (svc.smb.on) svc.smb.on('change', () => web.hub.running && web.hub._all(web.hub._mount()));
  for (const [name, fn] of Object.entries(web.actions)) ipcMain.on(name, (_e, arg) => fn(arg));
}

app.on('activate', showWindow);
app.on('window-all-closed', () => {}); // keep running in the menu bar
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
app.on('before-quit', () => {
  if (web) web.shutdown();
  if (svc && svc.mic) svc.mic.shutdown();
  quitting = true;
  if (svc && svc.phone) svc.phone.shutdown();
  if (svc && svc.phoneDrive) svc.phoneDrive.shutdown();
  if (svc && svc.wired) svc.wired.stop();
  if (svc) svc.shutdown(); // KVM home first, so the helper releases input
  if (discovery) discovery.stop();
  if (links) links.close();
  if (server) server.close();
});
