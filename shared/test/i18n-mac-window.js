// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Real Mac renderer/preload/IPC with simulated devices, no native helpers or network discovery.
'use strict';
if (!process.versions.electron) {
  console.log('i18n-mac-window: run with Electron');
  return;
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const I18n = require('../i18n');
const ROOT = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-mac-window-'));
app.setPath('userData', temp);
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
process.on('uncaughtException', (e) => { console.error(e); app.exit(1); });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const screenshots = process.env.TWINDESK_I18N_SCREENSHOTS;
const watchdog = setTimeout(() => { console.error('Mac renderer test timed out'); app.exit(1); }, 45000);

async function testMode(mode) {
  const dir = path.join(ROOT, mode), errors = [], seen = new Set(), intros = new Set();
  const store = require(path.join(dir, 'store'));
  store.init(path.join(temp, mode));
  const settings = store.loadSettings();
  settings.ui.tab = 'general'; settings.ui.setupDone = true;
  const state = {
    ...settings, macName: 'Mac $& {name}', macId: 'local', fp: '', version: '2.5.0',
    addresses: ['192.0.2.10'], client: null, serverError: null, paired: [], found: [],
    input: { where: 'home', message: '' }, pairing: null,
    permissions: { screen: 'granted', accessibility: true, inputMonitoring: true }, helper: { running: true },
    discovery: { on: true, error: '', localNetwork: true }, connect: { busy: false, message: '', error: false },
    guest: { status: { state: 'idle', message: '' }, hosts: [], pairing: null },
    sharing: { ...settings.sharing, displays: [], virtual: { ...settings.virtual, active: false }, pace: 'fast', bitrateMbps: settings.bitrateMbps, streamMaxHeight: settings.streamMaxHeight },
    streamInput: true, displayMode: 'extend', stream: {},
    clipboard: { ...settings.clipboard, history: [] }, audio: { ...settings.audio },
    phone: { nearby: [], settings: settings.phone, connected: null, top: [], assets: 0, bridge: { state: 'idle' } },
    phoneMedia: null, camera: { on: false }, vcam: { checked: true, supported: true },
    papps: { ...settings.papps, apps: [], windows: [], launch: {} }, apps: { ...settings.apps, list: [], launched: [] },
    terminal: { ...settings.terminal, toPc: {} }, files: { ...settings.files, clip: {}, incoming: [], sending: [], receiving: [], recent: [], sent: [], defaultFolder: '/Users/test/Downloads' },
    notifs: { ...settings.notifs, history: [], apps: [] }, smb: { ...settings.smb },
    about: { app: { name: 'TwinDesk', version: '2.5.0-beta.1' }, pc: {} },
    hub: { ...settings.hub, connected: false }, updates: {}, net: { ...settings.net, radio: 'on' },
    mount: { ...settings.mount, state: 'idle' }, wake: { peers: {} }, mesh: {}, peers: [],
  };
  const win = new BrowserWindow({ show: false, width: 1080, height: 850, webPreferences: {
    preload: path.join(dir, 'preload-control.js'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', ({ message }) => {
    if (/Uncaught|(?:build|render) [\w-]+:/.test(message)) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, _p, e) => errors.push(String(e)));
  const push = () => win.webContents.send('state', state);
  const source = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const reloadCode = source.slice(source.indexOf('function changeLanguage()'), source.indexOf('function createWindow()'));
  // A new language restarts TwinDesk: the real handler relaunches and quits; the "restarted" app
  // opens the settings window in the saved language, as startup does.
  const reload = vm.createContext({ app: { relaunch() {}, quit: () => win.loadFile(path.join(dir, 'control.html'), { query: { language: settings.ui.language } }) } });
  require(path.join(dir, 'ipc')).setupIpc({ settings, state, pushState: push,
    onLanguage: () => vm.runInContext('"use strict";\n' + reloadCode + '\nchangeLanguage();', reload),
    phone: { assetsView: () => ({ apps: [], wallpaper: '' }) },
    server: Object.assign(new (require('events').EventEmitter)(), { current: null, server: { current: null } }), // #76's Connect by address
    hub: () => ({ act() {} }),
    phoneHub: () => ({ act() {} }),
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const load = async (locale) => {
    await win.loadFile(path.join(dir, 'control.html'), { query: { language: locale } });
    for (let i = 0; i < 100; i++) { if (await read('!!UI.state')) return; await delay(25); }
    throw new Error(`${mode} did not render initial state: ${errors.join('; ')}`);
  };
  const shot = async (name) => {
    if (!screenshots) return;
    await delay(200); fs.mkdirSync(screenshots, { recursive: true });
    const captured = await Promise.race([win.webContents.capturePage(), delay(5000).then(() => { throw new Error('Screenshot timed out: ' + name); })]);
    fs.writeFileSync(path.join(screenshots, mode.replace('/', '-') + '-' + name + '.png'), captured.toPNG());
  };
  const inspect = async (kind) => {
    const ids = await read('UI.tabs.filter(d => !d.hidden || !d.hidden(UI.state)).map(d => d.id)');
    for (const id of ids) {
      if (process.env.TWINDESK_I18N_DEBUG) console.log(mode, kind, id);
      win.webContents.send('go', id); await delay(45);
      const selector = '#page-' + id;
      if (!await read(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).hidden`)) continue;
      seen.add(id);
      if (await read(`!!document.querySelector(${JSON.stringify(selector + ' .feature-art:not([hidden]) button')})`)) {
        intros.add(id);
        await read(`document.querySelector(${JSON.stringify(selector + ' .feature-art button')}).click()`);
      }
      const english = await read(`(() => {
        const root = document.querySelector(${JSON.stringify(selector)}), texts = [];
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const e = n.parentElement, text = n.nodeValue.trim();
          if (e && e.getClientRects().length && !e.closest('svg,kbd,code,pre,[data-literal]') && text && TwinDeskLanguages.en[text] && TwinDeskLanguages['zh-CN'][text] !== text) texts.push(text);
        }
        return [...new Set(texts)];
      })()`);
      assert.deepStrictEqual(english, [], `${mode} ${kind}/${id} application labels are Chinese`);
      if (['general', 'receive', 'share', 'connection'].includes(id)) await shot(kind + '-' + id);
    }
  };
  try {
    await load('zh-CN');
    assert.strictEqual(await read('document.documentElement.lang'), 'zh-CN');
    assert.ok(await read('document.querySelector("#page-general").textContent.includes("屏幕录制")'));
    for (const locale of ['en', 'zh-CN']) {
      const loaded = new Promise((r) => win.webContents.once('did-finish-load', r));
      await read(`(() => { const el = document.querySelector('#page-general select'); el.value = ${JSON.stringify(locale)}; el.dispatchEvent(new Event('change')); })()`);
      await loaded; await delay(100);
      assert.strictEqual(await read('document.documentElement.lang'), locale);
      assert.strictEqual(store.loadSettings().ui.language, locale);
      assert.strictEqual(settings.ui.tab, 'general');
    }
    state.ui.setupDone = false;
    state.permissions = { screen: 'denied', accessibility: false, inputMonitoring: false };
    push(); await delay(50);
    assert.ok(await read('document.querySelector(".setup-page").textContent.includes("辅助功能")'));
    await shot('setup');
    state.ui.setupDone = true;
    state.permissions = { screen: 'granted', accessibility: true, inputMonitoring: true };
    if (mode === 'mac') {
      state.pairing = { name: '<b>QR $& {name}</b>', code: '123456', wired: true, qr: true };
      push(); await delay(60);
      assert.strictEqual(await read('document.getElementById("pair-hint").textContent'), state.pairing.name + ' 已扫描二维码。点击“允许”进行配对。', 'Mac QR pairing keeps its network-specific Chinese instructions');
      assert.strictEqual(await read('document.querySelectorAll("#pair-hint b").length'), 0, 'QR device names remain literal');
      state.pairing.qr = false; push(); await delay(60);
      assert.ok((await read('document.getElementById("pair-hint").textContent')).includes('USB'), 'Mac USB pairing retains its separate instructions');
      state.pairing = null; push(); await delay(60);
    }
    state.client = { id: 'peer', name: 'Work $& {me}', os: 'win', role: 'host', rttMs: 3 };
    state.peers = [{ ...state.client, connected: true, selected: true }];
    state.mesh = { selectedId: 'peer' };
    state.audio = { ...state.audio, send: true, peerAccepts: true, error: 'capture {me} $& failed' };
    state.files.folder = '/Users/test/{name}/Ready';
    state.notifs.apps = [{ app: 'literal-app', appName: 'Ready {me} $&' }];
    state.rezume = { ...state.rezume, on: true, connected: true, message: '{name}.pdf isn’t there any more' };
    push(); await delay(50);
    const lockHints = await read(`[false, true].map(locked => {
      const lock = UI.cursorLock();
      lock.update({ ...UI.state, input: { ...UI.state.input, where: 'driving', locked } });
      return lock.el.querySelector('.hint').textContent;
    })`);
    for (const hint of lockHints) {
      assert.ok(hint.includes(state.client.name), 'cursor lock preserves literal device name');
      assert.match(hint.split(' While ')[0], /光标/, 'both cursor-lock states have Chinese instructions');
      assert.ok(!/The pointer|Keeps the pointer/.test(hint), 'cursor lock does not fall back to English');
    }
    assert.ok((await read('UI.peer(UI.state).thereScreen')).endsWith('的屏幕'), 'remote screen name has a translated suffix');
    await inspect('computer');
    assert.ok(await read('document.querySelector("#page-audio").textContent.includes("capture {me} $& failed")'));
    assert.ok(await read('document.querySelector("#page-files").textContent.includes("{name}/Ready")'));
    assert.ok(await read('document.querySelector("#page-notifications").textContent.includes("Ready {me} $&")'));
    if (mode === 'mac') {
      assert.ok(await read('document.querySelector("#page-rezume").textContent.includes("{name}.pdf isn’t there any more")'), 'ReZume preserves literal filenames in diagnostics');
      state.rezume.message = 'ReZume is off on {name}';
      push(); win.webContents.send('go', 'rezume'); await delay(50);
      const hint = I18n.create('zh-CN').t(state.rezume.message, { name: state.client.name });
      assert.ok(await read(`document.querySelector('#page-rezume').textContent.includes(${JSON.stringify(hint)})`), 'known ReZume templates still interpolate once');
    }
    state.client = { id: 'phone', name: 'Phone $& {name}', os: 'android', role: 'host' };
    state.peers = [{ ...state.client, connected: true, selected: true }];
    state.mesh = { selectedId: 'phone' };
    state.phone = { ...state.phone, connected: { ...state.client, rttMs: 4 }, bridge: { state: 'needsPair', message: 'Pairing didn’t work (native {me} $&). Try a new code.' }, info: { battery: 60, model: 'Phone' }, qs: { wifi: true }, top: [] };
    state.notifs.history = [{ id: 'n', at: 1, appName: 'App {me}', title: 'User title', body: 'literal {name} 123456' }];
    state.clipboard.history = [{ at: 1, dir: 'in', text: 'literal {me}' }];
    push(); await delay(60);
    await inspect('phone');
    const pairingHint = I18n.create('zh-CN').t('Pairing didn’t work ({error}). Try a new code.', { error: 'native {me} $&' });
    assert.ok(await read(`document.querySelector('#page-connection').textContent.includes(${JSON.stringify(pairingHint)})`), 'Connection translates dynamic pairing instructions and preserves native details');
    assert.deepStrictEqual(errors, [], `${mode}: no renderer errors`);
    console.log(`i18n-mac-window ${mode}: ${seen.size} pages, ${intros.size} introductions, switching and permissions passed`);
  } finally {
    win.destroy(); ipcMain.removeAllListeners();
    for (const channel of ['getState', 'phoneAssets', 'qrPair']) ipcMain.removeHandler(channel);
  }
}
app.whenReady().then(async () => {
  try { await testMode('mac'); await testMode('mac/mesh'); clearTimeout(watchdog); app.exit(0); }
  catch (e) { console.error(e); app.exit(1); }
});
