// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Each kind of device gets its own pages (shared/ui-kinds.js): the real Windows (or Linux) window,
// both modes, with another computer, an Android phone, an iPhone and an iPad in session. Checks the
// sidebar's pages for each, that Overview and Mirroring open the kind's own version (also when the
// device changes with the page open), what each Overview shows, which way Camera starts, and that
// no page throws.
// The Mac's window, both modes (shared/test/kinds-window.js: the PC's and Linux's).
// Run: mac/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron shared/test/kinds-mac-window.js
'use strict';
if (!process.versions.electron) {
  console.log('kinds-window: run with Electron to check the actual pages');
  return;
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
process.on('uncaughtException', (e) => { console.error(e); app.exit(1); });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kinds-mac-window-'));
app.setPath('userData', temp);
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const watchdog = setTimeout(() => { console.error('kinds-window timed out'); app.exit(1); }, 90000);

// What each kind must and must not have in the sidebar (ids of the PC's and Linux's pages).
const EXPECT = {
  computer: {
    has: ['overview', 'receive', 'share', 'cursor', 'keyboard', 'clipboard', 'files', 'audio'],
    not: ['android-overview', 'ios-overview', 'calls', 'messages', 'media', 'pfiles', 'remote', 'mirror', 'papps', 'ios-mirror', 'mount'],
  },
  android: {
    has: ['android-overview', 'calls', 'messages', 'media', 'pfiles', 'remote', 'mirror', 'papps', 'cursor', 'keyboard', 'clipboard', 'files'],
    not: ['overview', 'ios-overview', 'ios-mirror', 'receive', 'apps', 'terminal'],
  },
  ios: {
    has: ['ios-overview', 'ios-mirror', 'media', 'pfiles', 'remote', 'clipboard', 'files', 'share'],
    not: ['overview', 'android-overview', 'mirror', 'papps', 'calls', 'messages', 'cursor', 'keyboard', 'mount', 'receive', 'apps', 'terminal'],
  },
};

async function testMode(mode) {
  const dir = path.join(ROOT, mode);
  const store = require(path.join(dir, 'store'));
  store.init(path.join(temp, mode));
  const settings = store.loadSettings();
  settings.ui.tab = 'connection'; settings.ui.setupDone = true; settings.ui.language = 'en';
  const base = {
    ...settings, macName: 'This Mac', macId: 'local', fp: '', version: '2.5.0',
    addresses: ['192.0.2.10'], client: null, serverError: null, paired: [], found: [],
    input: { where: 'home', message: '' }, pairing: null,
    permissions: { screen: 'granted', accessibility: true, inputMonitoring: true }, helper: { running: true },
    discovery: { on: true, error: '', localNetwork: true }, connect: { busy: false, message: '', error: false },
    guest: { status: { state: 'idle', message: '' }, hosts: [], pairing: null },
    sharing: { ...settings.sharing, displays: [], virtual: { ...settings.virtual, active: false }, pace: 'fast', bitrateMbps: settings.bitrateMbps, streamMaxHeight: settings.streamMaxHeight },
    streamInput: true, displayMode: 'extend', stream: {},
    clipboard: { ...settings.clipboard, enabled: true, history: [{ at: 1, dir: 'in', text: 'copied' }] }, audio: { ...settings.audio },
    phone: { nearby: [], settings: settings.phone, connected: null, top: [], assets: 0, bridge: { state: 'idle' } },
    phoneMedia: null, camera: { on: false }, vcam: { checked: true, supported: true },
    papps: { ...settings.papps, apps: [], windows: [], launch: {} }, apps: { ...settings.apps, list: [], launched: [] },
    terminal: { ...settings.terminal, toPc: {} }, files: { ...settings.files, clip: {}, incoming: [], sending: [], receiving: [], recent: [], sent: [], defaultFolder: '/Users/test/Downloads' },
    notifs: { ...settings.notifs, receive: true, history: [{ id: 'n', at: 1, appName: 'App', title: 'Hello', body: 'code 123456' }], apps: [] }, smb: { ...settings.smb },
    about: { app: { name: 'TwinDesk', version: '2.5.0' }, pc: {} }, web: { cfg: { ...(settings.web || {}) }, devices: [] },
    hub: { ...settings.hub, connected: false }, updates: {}, net: { ...settings.net, radio: 'on' },
    mount: { ...settings.mount, state: 'idle' }, wake: { peers: {} }, mesh: {}, peers: [],
  };
  let state = base;
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload: path.join(dir, 'preload-control.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', ({ message }) => {
    if (/Uncaught|render .*:|build .*:/.test(message)) errors.push(`${mode}: ${message}`);
  });
  win.webContents.on('preload-error', (_e, _p, error) => errors.push(String(error)));
  const push = () => win.webContents.send('state', { ...state, ui: settings.ui });
  require(path.join(dir, 'ipc')).setupIpc({ settings, state: base, pushState: push, onLanguage() {},
    phone: { assetsView: () => ({ apps: [], wallpaper: '' }) },
    server: Object.assign(new (require('events').EventEmitter)(), { current: null, server: { current: null } }),
    hub: () => ({ act() {} }), phoneHub: () => ({ act() {} }),
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(dir, 'control.html'), { query: { language: 'en' } });
    for (let i = 0; i < 100 && !(await read('!!UI.state')); i++) await delay(30);
    const visible = () => read('UI.tabs.filter((d) => !d.navHidden && !d.web && !(d.hidden && d.hidden(UI.state))).map((d) => d.id)');
    const navShown = () => read('[...document.querySelectorAll("#nav .nav-item")].filter((b) => !b.parentElement.hidden).map((b) => b.getAttribute("aria-controls").slice(5))');
    const open = () => read('[...document.querySelectorAll("#pages > .page")].filter((p) => !p.hidden).map((p) => p.id.slice(5))');
    const text = (id) => read(`document.getElementById('page-${id}').textContent`);
    const shownBtns = (id) => read(`[...document.querySelectorAll('#page-${id} .dv-actions button')].filter((b) => !b.hidden).map((b) => b.textContent.trim())`);

    const session = (kind) => {
      const pad = kind === 'ipad';
      const peer = kind === 'computer' ? { id: 'pc2', name: 'Other PC', os: 'win' }
        : { id: 'ph', name: pad ? 'My iPad' : kind === 'ios' ? 'My iPhone' : 'Pixel', os: kind === 'android' ? 'android' : 'ios' };
      const s = { ...base, peers: [{ ...peer, connected: true, selected: true, state: 'connected' }], mesh: { selectedId: peer.id },
        client: { id: peer.id, name: peer.name, os: peer.os, role: 'guest', address: '192.0.2.20', rttMs: 3 } }; // the Mac's session
      if (kind === 'computer') {
        s.peerCtl = { can: { ring: true, lock: true, sleep: true, bluetooth: true, dnd: true, volume: true }, bluetooth: true, dnd: false, volume: 0.4 };
        return s;
      }
      const info = kind === 'android' ? { battery: 65, maker: 'Google', model: 'Pixel 8', release: '15' }
        : { battery: 80, charging: true, maker: 'Apple', model: pad ? 'iPad Air' : 'iPhone 15', release: '18.1', platform: pad ? 'ipados' : 'ios' };
      s.phone = { ...base.phone, nearby: [{ id: peer.id, name: peer.name, os: peer.os, connected: true }], connected: { ...peer, rttMs: 4 }, info,
        bridge: { state: kind === 'android' ? 'ready' : 'off', windows: [] },
        ctl: kind === 'android' ? { can: { ring: true, lock: true } } : { can: { ring: true, ringStop: true } },
        qs: kind === 'android' ? { wifi: true, bluetooth: false } : null, top: [] };
      return s;
    };
    const as = async (kind) => { state = session(kind); push(); await delay(120); };
    const go = async (id) => { win.webContents.send('go', id); await delay(80); };

    for (const kind of ['computer', 'android', 'ios']) {
      await as(kind);
      const v = await visible();
      const nav = await navShown();
      const loaded = await read('UI.tabs.map((d) => d.id)'); // Multi-device has fewer pages (no Remote, Camera, ReZume)
      for (const id of EXPECT[kind].has.filter((x) => loaded.includes(x))) assert.ok(v.includes(id) && nav.includes(id), `${mode} ${kind}: ${id} in the sidebar (${nav.join(' ')})`);
      for (const id of EXPECT[kind].not) assert.ok(!v.includes(id) && !nav.includes(id), `${mode} ${kind}: no ${id} (${nav.join(' ')})`);
      await go('overview'); // the tray's and the popups' name: the kind's own
      const ov = kind === 'computer' ? 'overview' : `${kind}-overview`;
      assert.deepStrictEqual(await open(), [ov], `${mode} ${kind}: Overview is ${ov}`);
      for (const id of v) { await go(id); assert.deepStrictEqual(await open(), [id], `${mode} ${kind}: ${id} opens`); }
    }

    // What each Overview shows.
    await as('computer'); await go('overview');
    assert.deepStrictEqual(await shownBtns('overview'), ['Ring', 'Lock', 'Sleep', 'Disconnect'], `${mode}: a computer's actions`);
    assert.ok((await text('overview')).includes('Controls'), `${mode}: a computer's controls`);
    assert.ok((await text('overview')).includes('Windows PC'));
    await as('android'); await go('overview');
    assert.deepStrictEqual(await shownBtns('android-overview'), ['Show screen', 'Ring', 'Lock', 'Disconnect'], `${mode}: an Android phone's actions`);
    const a = await text('android-overview');
    assert.ok(a.includes('Android 15') && a.includes('Quick actions') && a.includes('ADB · ready'), `${mode}: Android's own Overview`);
    assert.ok(a.includes('code 123456') && a.includes('copied') && a.includes('Drop files here'), `${mode}: notifications, clipboard and Send files`);
    await as('ios'); await go('overview');
    assert.deepStrictEqual(await shownBtns('ios-overview'), ['Show screen', 'Ring', 'Disconnect'], `${mode}: an iPhone's actions`);
    const i = await text('ios-overview');
    assert.ok(i.includes('Apple iPhone 15 · iOS 18.1'), `${mode}: iOS version`);
    assert.ok(!/Quick actions|ADB|Android|Wi-Fi Direct|hotspot/.test(i), `${mode}: nothing Android on an iPhone's Overview`);
    assert.ok(i.includes('code 123456') && i.includes('copied') && i.includes('Drop files here'), `${mode}: notifications, clipboard and Send files`);
    assert.strictEqual(await read('document.querySelector("#page-ios-overview .dv-actions .primary").disabled'), false, `${mode}: Show screen without ADB`);
    await as('ipad'); await go('overview');
    assert.ok((await text('ios-overview')).includes('iPad Air · iPadOS 18.1'), `${mode}: iPadOS`);

    // The page that's open follows the device: Android's Mirroring, then an iPad: the iPad's.
    await as('android'); await go('mirror');
    assert.deepStrictEqual(await open(), ['mirror']);
    await as('ipad');
    assert.deepStrictEqual(await open(), ['ios-mirror'], `${mode}: Mirroring follows the device`);
    const m = await text('ios-mirror');
    assert.ok(m.includes('Start Broadcast') && m.includes('AirPlay') && !/ADB|Full \(ADB\)|wireless debugging/.test(m), `${mode}: the iPad's Mirroring`);
    await as('android');
    assert.deepStrictEqual(await open(), ['mirror'], `${mode}: and back`);
    await go('cursor'); await as('ios');
    assert.deepStrictEqual(await open(), ['ios-overview'], `${mode}: a page the iPhone has no version of: its Overview`);

    // Camera: an iPhone shares its own (camshare.js, as a computer does); an Android phone's goes
    // through wireless debugging. The PC and Linux used to send an iPhone's through ADB.
    if ((await read('UI.tabs.map((d) => d.id)')).includes('camera')) {
      const spy = `(() => { window.__cam = []; UI.api = { ...UI.api, camera: (m) => { __cam.push(['camera', m.do]); return Promise.resolve(); }, phoneCamera: (on) => { __cam.push(['phoneCamera', on]); return Promise.resolve(); } }; return 1; })()`;
      const startBtn = `[...document.querySelectorAll('#page-camera button')].find((b) => b.textContent === 'Start')`;
      for (const kind of ['ios', 'ipad']) {
        state = session(kind);
        state.camera = { on: true, connected: true, peerShares: true };
        state.phone.bridge = { state: 'off', windows: [] }; // no wireless debugging: it isn't needed
        push(); await delay(120); await go('camera');
        const c = await text('camera');
        assert.ok(!/wireless debugging/i.test(c), `${mode} ${kind}: its camera needs no wireless debugging (${c.slice(0, 200)})`);
        assert.strictEqual(await read(`${startBtn}.disabled`), false, `${mode} ${kind}: Start can be pressed`);
        await read(spy);
        await read(`${startBtn}.click()`);
        assert.deepStrictEqual(await read('__cam'), [['camera', 'view']], `${mode} ${kind}: Start asks for its camera as a computer's, not through ADB`);
      }
      state = session('android');
      state.camera = { on: true, connected: false };
      state.phone.bridge = { state: 'off', windows: [] };
      push(); await delay(120); await go('camera');
      assert.ok(/wireless debugging/i.test(await text('camera')), `${mode}: an Android phone's camera still needs wireless debugging`);
      state.phone.bridge = { state: 'ready', windows: [] };
      push(); await delay(120);
      await read(spy);
      await read(`${startBtn}.click()`);
      assert.deepStrictEqual(await read('__cam'), [['phoneCamera', true]], `${mode}: an Android phone's camera starts through ADB`);
    }
    if (mode.endsWith('mesh')) { // the iPad's tile is a phone's, not a computer's
      await as('ipad');
      assert.strictEqual(await read('document.querySelector("#phones .phone-tile.computer") === null'), true, `${mode}: the iPad's tile is a phone's`);
    }
    assert.deepStrictEqual(errors, [], 'no page throws');
    console.log(`kinds-mac-window ${mode}: computer, Android, iPhone and iPad pages passed`);
  } finally {
    win.destroy();
    ipcMain.removeAllListeners();
    for (const channel of ['getState', 'phoneAssets', 'qrPair']) ipcMain.removeHandler(channel); // as i18n-mac-window.js
  }
}

app.whenReady().then(async () => {
  try {
    await testMode('mac');
    await testMode('mac/mesh');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
