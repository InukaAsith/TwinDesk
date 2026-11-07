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
    const onPhone = !!(state.client && state.client.os === 'android');
    if (svc && svc.phone) state.phone = { ...svc.phone.view, settings: settings.phone, ctl: onPhone ? ctlView : null, qs: onPhone && ctlView ? ctlView.qs || null : null, top: onPhone && ctlView ? ctlView.top || [] : [] };
    state.peerCtl = !onPhone ? ctlView : null; // a computer's controls on Overview
    if (svc && svc.net) {
      const c = peer && peer.current;
      const hs = c && settings.net.hotspots[c.deviceId];
      state.net = { ...svc.net.view, ble: settings.net.ble !== false, blePc: settings.net.blePc === true, bleWifiOff: settings.net.bleWifiOff !== false, bleOff, radio: svc.ble.state, hotspotSsid: hs ? hs.ssid : '', hotspotSaved: !!(hs && hs.pass), lan: lanType(c && c.address) };
    }
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

function changeLanguage() {
  i18n = I18n.create(I18n.resolveLanguage(settings.ui.language, app.getLocale()));
  for (const player of BrowserWindow.getAllWindows()) {
    if (!player.isDestroyed()) player.webContents.send('ui-language', i18n.locale);
  }
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
  require('../../shared/inputlane.js').setLaneProtocol(settings.app.inputProtocol); // General › Advanced, before any lane binds
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
    endsChain: (pid) => { const s = hub.sessions.get(pid); return !!s && s.peerOs === P.OS.ANDROID; },
    legacyEdges: () => {
      const k = settings.kvm || {};
      if (k.edges && Object.values(k.edges).some(Boolean)) return k.edges;
      const pcs = hub.peers().filter((p) => p.state !== 'via' && p.os !== P.OS.ANDROID);
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
    svc.mic = new Mic({ server: peer, cfg: () => settings.audio, onChange: pushState, platform: 'mac', askMic });
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
    hasPhone: () => pairing.list().some((x) => x.os === P.OS.ANDROID) });
  pairing.isWired = (nonce) => svc.wired.knows(nonce);
  svc.wired.on('change', pushState);
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
      u.bridge.on('popup', (kind, text) => hud.show(kind, text));
      u.bridge.on('save', () => store.saveSettings(settings));
    },
  });
  svc.phone.on('change', pushState);
  svc.phoneViews = svc.phone.viewsProxy; // the windows of the active phone
  // A phone notification clicked here: its app in a window (on the phone it came from).
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
  pairSync = new PairSync({ server: peer, getSettings: () => settings, saveSettings: () => store.saveSettings(settings), only: Object.keys(SYNC_ACTIONS), // no ReZume or Remote here
    apply: (f, dir, on) => (f !== 'value' ? SYNC_ACTIONS[f](dir, on)
      : ['gestures', 'keyboard', 'speed', 'reverseScroll', 'syncPads'].includes(dir) ? actions.setKvm({ [dir]: on }) : actions.setSharingOpts({ [dir]: on })) });
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
  setupWeb();
  actions = setupIpc({ devctl: () => devctl, chats: () => chats, state, settings, pushState, onLanguage: changeLanguage, onLook: () => Look.applyTheme(nativeTheme, settings.ui.theme), t, server: peer, pairing, discovery, link: links, ...svc, hub, layoutSync, autoJoin, phoneHub: loadHub, login, refreshPermissions, updates });
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
  const { PhoneHub } = require('../../shared/phonehub.js');
  const hub = new PhoneHub({
    server: peer, getSettings: () => settings, save: () => store.saveSettings(settings),
    audio: (opts) => require('../callaudio.js').create({ helper: svc.helper, ...opts }), // the calls' sound over Bluetooth
    send: (paths, batch) => !!(svc.fileSend && svc.fileSend.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
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
