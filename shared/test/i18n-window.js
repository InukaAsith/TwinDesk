// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Real sandboxed Electron pages, isolated from native helpers and network/device discovery.
// Run: windows/node_modules/electron/dist/electron.exe shared/test/i18n-window.js
// Linux's pages (the same renderer code, run here): TWINDESK_PLATFORM=linux before it.
'use strict';
if (!process.versions.electron) {
  console.log('i18n-window: run with Electron to verify the actual Windows pages');
  return;
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const I18n = require('../i18n.js');
const ROOT = path.resolve(__dirname, '../..');
const PLATFORM = process.env.TWINDESK_PLATFORM === 'linux' ? 'linux' : 'windows';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-i18n-window-'));
app.setPath('userData', temp);
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {}); // keep the test process alive between the two modes
const screenshotDir = process.env.TWINDESK_I18N_SCREENSHOTS;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const watchdog = setTimeout(() => { console.error('Windows renderer test timed out'); app.exit(1); }, 45000);

async function testMode(mode) {
  const inspected = new Set();
  const introductions = new Set();
  const dir = path.join(ROOT, mode);
  const model = require(path.join(dir, 'settings.js'));
  let settings = model.normalize({ ui: { tab: 'general' }, setup: { done: true } });
  let state = {
    ...settings, device: { id: 'local', name: '测试 PC <safe>' }, peer: null,
    link: { state: 'idle' }, paired: null, guests: [], found: [], addresses: ['192.0.2.10'],
    discovery: { on: true }, stream: {}, wake: { peers: {} }, input: 'home', kvmState: { helper: '' },
    clipboard: { ...settings.clipboard, history: [] }, camera: { on: false }, vcam: {},
    pcScreen: { ...settings.pcScreen, mode: 'off', monitors: [], extendPx: [1920, 1080], mac: { accept: false }, vdd: { checked: true, installed: true } }, pcApps: {}, apps: { list: [] },
    terminal: { ...settings.terminal, server: {} },
    files: { ...settings.files, received: 'C:\\Downloads', smb: {}, incoming: [], drag: {}, clip: {} },
    notifs: { ...settings.notifs, history: [], apps: [] }, phone: { nearby: [], assets: 0, settings: settings.phone },
    setup: { missing: [], show: false }, net: { ...settings.net, radio: 'on' },
    hub: { ...settings.hub, connected: false }, about: { app: { name: 'TwinDesk', version: '2.5.0-beta.1' }, pc: {} }, updates: {}, mesh: {}, peers: [],
  };
  const win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: {
    preload: path.join(dir, 'preload-app.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', ({ message }) => {
    if (/Uncaught|render .*:/.test(message)) errors.push(`${mode}: ${message}`);
  });
  win.webContents.on('preload-error', (_e, _p, error) => errors.push(String(error)));
  const push = () => win.webContents.send('state', { ...state, ui: settings.ui });
  const mainSource = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const reloadCode = mainSource.slice(mainSource.indexOf('function changeLanguage()'), mainSource.indexOf('function saveBounds()'));
  // A new language restarts TwinDesk: the real handler relaunches and quits; the "restarted" app
  // opens the settings window in the saved language, as startup does.
  const reload = vm.createContext({ process: { argv: ['TwinDesk.exe'] }, app: { relaunch() {}, quit: () => win.loadFile(path.join(dir, 'app.html'), { query: { language: settings.ui.language } }) } });
  const ctx = {
    settings,
    buildState: () => ({ ...state, ui: settings.ui }),
    save: () => fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify(settings)),
    push,
    onLanguage: () => vm.runInContext(reloadCode + '\nchangeLanguage();', reload),
    phone: { assetsView: () => ({ wallpaper: '', apps: [] }) },
    link: { peerOs: 'win' }, peerApps: { refresh() {} }, apps: { refresh() {} },
    hub: () => ({ act() {} }), phoneHub: () => ({ act() {} }),
  };
  require(path.join(dir, 'ipc.js'))(ctx);
  const load = async (locale) => {
    await win.loadFile(path.join(dir, 'app.html'), { query: { language: locale } });
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('!!UI.state')) return;
      await delay(30);
    }
    throw new Error(`${mode}: state was not rendered`);
  };
  const read = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    if (!screenshotDir) return;
    await delay(250); // allow CSS transitions and compositor frames to settle
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const inspectPages = async (kind) => {
    const ids = await read('UI.tabs.filter(d => !d.hidden || !d.hidden(UI.state)).map(d => d.id)');
    for (const id of ids) {
      win.webContents.send('go', id); await delay(40);
      const result = await read(`(() => {
        const page = document.getElementById(${JSON.stringify('page-')} + ${JSON.stringify(id)});
        if (!page || page.hidden) return { skipped: true };
        const intro = page.querySelector('.feature-art:not([hidden])');
        const caption = intro && intro.querySelector('p');
        const introText = caption ? caption.textContent : '';
        if (intro) intro.querySelector('button').click();
        return { introText, bodyVisible: !page.querySelector('.page-body').hidden };
      })()`);
      if (result.skipped) continue;
      inspected.add(id);
      if (result.introText) {
        introductions.add(id);
        assert.match(result.introText, /[\u4e00-\u9fff]/, `${mode} ${id} introduction is Chinese`);
      }
      assert.ok(result.bodyVisible, `${mode} ${id} body is visible after Dismiss`);
      const english = await read(`(() => {
        const page = document.getElementById(${JSON.stringify('page-')} + ${JSON.stringify(id)});
        const w = document.createTreeWalker(page.querySelector('.page-body'), NodeFilter.SHOW_TEXT), texts = [];
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const e = n.parentElement, text = n.nodeValue.trim();
          if (e && e.getClientRects().length && !e.closest('svg,kbd,code,pre') && text) texts.push(text);
        }
        return [...new Set(texts.filter(text => TwinDeskLanguages.en[text] && TwinDeskLanguages['zh-CN'][text] !== text))];
      })()`);
      assert.deepStrictEqual(english, [], `${mode} ${kind} ${id} has no untranslated application labels`);
    }
  };
  await win.webContents.session.clearStorageData({ storages: ['localstorage'] });
  try {
    await load(I18n.resolveLanguage(settings.ui.language, 'zh-CN'));
    assert.strictEqual(await read('document.documentElement.lang'), 'zh-CN');
    assert.strictEqual(await read('document.querySelector("#page-general h1").textContent'), I18n.create('zh-CN').t('General'));
    assert.ok(await read('document.querySelector("#page-general").textContent.includes("简体中文")'));
    const networkName = '以太网 $& {name} <tag>';
    const winFirewall = PLATFORM === 'windows'; // the Windows firewall's networks and categories
    const firewallHint = `网络“${networkName}”被设为“公用”，因此 Windows 会阻止 另一台电脑 的广播。`;
    if (winFirewall) {
      state.firewall = require('../../windows/firewall').interpret({ rules: [], networks: [
        { alias: networkName, index: 9, category: 'Public', ipv4: 'Internet' },
      ] });
      push(); await delay(60);
      assert.ok(await read(`document.querySelector('#page-general').textContent.includes(${JSON.stringify(firewallHint)})`), `${mode}: firewall hint is translated without replacing braces in network names`);
    }
    await shot(mode.replace('/', '-') + '-general-zh-CN');

    // Trigger the real selector -> sandboxed preload -> actual IPC -> settings-window reload.
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await read('document.querySelector("#page-general select").value = "en"; document.querySelector("#page-general select").dispatchEvent(new Event("change"))');
    await loaded;
    await delay(150);
    assert.strictEqual(await read('document.documentElement.lang'), 'en');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'), 'utf8')).ui.language, 'en');
    assert.strictEqual(settings.ui.tab, 'general');
    assert.strictEqual(await read('document.querySelector("#page-general h1").textContent'), 'General');
    assert.strictEqual(await read('document.querySelector("#page-general").hidden'), false);

    const back = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await read('document.querySelector("#page-general select").value = "zh-CN"; document.querySelector("#page-general select").dispatchEvent(new Event("change"))');
    await back; await delay(100);
    assert.strictEqual(settings.ui.language, 'zh-CN');
    assert.strictEqual(await read('document.documentElement.lang'), 'zh-CN');

    state.found = [{ id: 'found', name: 'Work {me} $&', os: 'win', address: '192.0.2.11', port: 47800 }];
    settings.ui.tab = 'connection';
    for (const locale of ['en', 'zh-CN']) {
      await load(locale);
      assert.strictEqual(await read('document.querySelector("#page-connection").hidden'), false);
      assert.ok(await read('document.querySelector("#page-connection").textContent.includes("Work {me} $&")'));
      assert.strictEqual(await read('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
    }
    await shot(mode.replace('/', '-') + '-connection-zh-CN');
    state.setup = { missing: ['firewall'], show: true };
    state.firewall = { checking: true };
    push(); await delay(60);
    assert.ok(await read('document.querySelector(".setup-page").textContent.includes("设置 TwinDesk")'));
    if (winFirewall) {
      state.firewall = require('../../windows/firewall').interpret({ rules: [], networks: [
        { alias: networkName, index: 9, category: 'Public', ipv4: 'Internet' },
      ] });
      push(); await delay(60);
      assert.ok(await read(`document.querySelector('.setup-page').textContent.includes(${JSON.stringify(firewallHint)})`), `${mode}: setup preserves the translated firewall hint too`);
    }
    await shot(mode.replace('/', '-') + '-setup-zh-CN');
    state.setup = { missing: [], show: false };
    state.pairing = { phase: 'code', role: 'guest', macName: '<b>手机 & PC</b>', code: '123456' };
    push(); await delay(60);
    assert.ok((await read('document.getElementById("pair-title").textContent')).includes('<b>手机 & PC</b>'));
    assert.strictEqual(await read('document.querySelectorAll("#banner b").length'), 0, 'peer names are plain text');
    assert.ok((await read('document.getElementById("pair-hint").textContent')).includes('配对码'));
    assert.strictEqual(await read('document.querySelector(".pair-pop .btn:not(.primary)").textContent'), I18n.create('zh-CN').t('Later'));

    if (mode === 'windows') { // QR pairing over the network (Windows' host pairing)
      state.pairing = { phase: 'request', role: 'host', macName: '<b>QR $& {name}</b>', code: '123456', wired: true, qr: true };
      push(); await delay(60);
      assert.strictEqual(await read('document.getElementById("pair-hint").textContent'), state.pairing.macName + ' 已扫描二维码。点击“允许”进行配对。', 'QR pairing keeps its network-specific Chinese instructions');
      assert.strictEqual(await read('document.querySelectorAll("#pair-hint b").length'), 0, 'QR device names remain literal');
      state.pairing.qr = false; push(); await delay(60);
      assert.ok((await read('document.getElementById("pair-hint").textContent')).includes('USB'), 'USB pairing retains its separate instructions');
    }
    state.pairing = null;
    state.link = { state: 'connected', macName: '另一台 PC', rtt: 3 };
    state.peer = { id: 'other', name: '另一台 PC', os: 'win' };
    state.peers = [{ ...state.peer, connected: true, selected: true }];
    state.mesh = { selectedId: 'other' };
    state.ui = settings.ui = { ...settings.ui, tab: 'overview' };
    push(); await delay(60);
    win.webContents.send('go', 'overview'); await delay(60);
    assert.strictEqual(await read('document.querySelector("#page-overview").hidden'), false);
    assert.ok(await read('document.querySelector("#page-overview").textContent.includes("另一台 PC")'));
    await shot(mode.replace('/', '-') + '-overview-zh-CN');

    // Feature text must be translated both before and after the introduction is dismissed.
    state.stream = { state: 'off', remote: { on: false, remote: true, modes: ['mirror', 'extend'] } };
    push(); await delay(50);
    win.webContents.send('go', 'mac-pc'); await delay(60);
    assert.strictEqual(await read('document.querySelector("#page-mac-pc .feature-art h2").textContent'), '远程屏幕');
    assert.strictEqual(await read('document.querySelector("#page-mac-pc .feature-art button").textContent'), '查看设置');
    await shot(mode.replace('/', '-') + '-receive-intro-zh-CN');
    await read('document.querySelector("#page-mac-pc .feature-art button").click()');
    assert.ok(await read('document.querySelector("#page-mac-pc .page-body").textContent.includes("屏幕窗口")'));
    assert.ok(await read('document.querySelector("#page-mac-pc .page-body").textContent.includes("补帧")'));
    assert.ok(await read('!document.querySelector("#page-mac-pc .page-body").textContent.includes("Screen window")'));
    await shot(mode.replace('/', '-') + '-receive-settings-zh-CN');
    state.kvm = { ...state.kvm, mouse: false, keyboard: false };
    state.clipboard.enabled = false;
    state.notifs.send = state.notifs.receive = false;
    state.audio.send = false;
    state.macApps.allow = false;
    push(); await delay(40);
    await inspectPages('computer');
    win.webContents.send('go', 'overview'); await delay(60);

    state.peer = { id: 'phone', name: 'Work {me} $&', os: 'android' };
    state.session = { ...state.peer, role: 'guest' };
    state.peers = [{ ...state.peer, connected: true, selected: true }];
    state.mesh = { selectedId: 'phone' };
    state.phone = { ...state.phone, connected: { ...state.peer, rttMs: 4 }, bridge: { state: 'ready' },
      info: { battery: 65, model: 'Phone model' }, qs: { wifi: true }, top: [] };
    state.notifs = { ...state.notifs, receive: true, history: [{ id: 'n', at: 1, appName: 'App {me}', title: 'User title', body: 'literal {name} 123456' }] };
    state.clipboard = { ...state.clipboard, enabled: true, history: [{ at: 1, dir: 'in', text: 'literal {me}' }] };
    push(); await delay(80);
    // A phone's own Overview (shared/ui-device-android.js), in Overview's place.
    assert.ok(await read('document.querySelector("#page-android-overview").textContent.includes("literal {name} 123456")'));
    assert.ok(await read('document.querySelector("#page-android-overview").textContent.includes("literal {me}")'));
    assert.ok(await read('document.querySelector("#page-android-overview h1").textContent.includes("Work {me} $&")'));
    await inspectPages('phone');
    assert.deepStrictEqual(errors, [], 'actual renderer must not throw');
    assert.ok(introductions.size >= (mode === 'linux/mesh' ? 7 : 8), 'the test inspects feature introductions as well as settings'); // Linux's Multi-device has fewer pages
    console.log(`i18n-window ${mode}: ${inspected.size} pages, ${introductions.size} introductions, computer/phone settings inspected`);
  } finally {
    win.destroy();
    ipcMain.removeAllListeners();
    // Every channel registered by these IPC modules is an invoke handler.
    for (const channel of [...fs.readFileSync(path.join(dir, 'ipc.js'), 'utf8').matchAll(/(?:handle|phone)\('([^']+)'/g)]) ipcMain.removeHandler(channel[1]);
  }
}

app.whenReady().then(async () => {
  try {
    await testMode(PLATFORM);
    await testMode(PLATFORM + '/mesh');
    console.log('i18n-window: ordinary/Mesh actual pages, startup locale, language switch, persistence, setup, pairing and Overview passed');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
