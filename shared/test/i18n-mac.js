// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-i18n-mac-'));
try {
  for (const mode of ['mac', 'mac/mesh']) {
    const local = createRequire(path.join(ROOT, mode, 'ipc.js'));
    const store = local('./store');
    store.init(path.join(temp, mode));
    assert.strictEqual(store.loadSettings().ui.language, '', 'a new Mac follows the system language');
    store.saveSettings({ ui: { tab: 'general', language: '../invalid' } });
    assert.strictEqual(store.loadSettings().ui.language, '', 'unknown saved locales are rejected');
    const settings = store.loadSettings();
    let reloads = 0, pushes = 0;
    const events = new Map();
    let appMenu;
    const mod = { exports: {} };
    const filename = path.join(ROOT, mode, 'ipc.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: (name) => name === 'electron' ? { ipcMain: { on: (k, fn) => events.set(k, fn), handle() {} }, Menu: { buildFromTemplate(items) { appMenu = items; return { popup() {} }; } } } : local(name),
      module: mod, console, process,
    }, { filename });
    const connection = { connect: {} }, opened = [];
    const device = { id: 'peer', name: 'Work $& {me}', os: 'win', address: '192.0.2.11' };
    const actions = mod.exports.setupIpc({ settings, state: connection, pushState() { pushes++; }, onLanguage() { reloads++; },
      t: (...args) => require('../i18n').create('zh-CN').t(...args),
      discovery: { get: () => device, invite() {} }, pairing: { list: () => [], expect() {} },
      server: Object.assign(new (require('events').EventEmitter)(), { current: null, server: { current: null } }), link: { hosts: [] }, // #76's Connect by address
      phoneViews: { openApp: (...args) => opened.push(args), pin() {} },
    });
    assert.ok(events.has('setLanguage'), `${mode} exposes a validated language action`);
    const set = (v) => events.get('setLanguage')({}, v);
    for (const bad of [null, {}, 'fr', '../zh-CN', 'zh-cn']) set(bad);
    assert.strictEqual(reloads, 0);
    set('zh-CN');
    assert.strictEqual(store.loadSettings().ui.language, 'zh-CN');
    assert.strictEqual(settings.ui.tab, 'general');
    assert.strictEqual(reloads, 1);
    assert.strictEqual(pushes, 1);
    set('zh-CN'); assert.strictEqual(reloads, 1);
    set('en'); assert.strictEqual(store.loadSettings().ui.language, 'en');
    assert.strictEqual(reloads, 2);
    actions.pairWith('peer');
    assert.strictEqual(connection.connect.message, `Asked ${device.name} to connect. Confirm on ${device.name}.`);
    assert.strictEqual(connection.connect.messageKey, 'Asked {name} to connect. Confirm on {name}.');
    assert.strictEqual(connection.connect.messageVars.name, device.name);
    actions.phoneAppMenu({ id: 'org.example.app', name: device.name });
    assert.strictEqual(appMenu[0].label, '在窗口中打开');
    appMenu[0].click();
    assert.deepStrictEqual(opened[0], ['org.example.app', device.name]);

    const preload = { exports: {} }; let exposed;
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, mode, 'preload-control.js'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_k, api) => { exposed = api; } }, ipcRenderer: {}, webUtils: {} }),
      module: preload,
    });
    assert.strictEqual(typeof exposed.setLanguage, 'function');
    const html = fs.readFileSync(path.join(ROOT, mode, 'control.html'), 'utf8');
    for (const file of ['lang/en.js', 'lang/pick.js', 'i18n.js']) assert.ok(html.includes('../shared/' + file), `${mode} loads shared ${file}`);
  }
  const build = fs.readFileSync(path.join(ROOT, 'mac/build-app.sh'), 'utf8');
  assert.ok(build.includes('"$ROOT/shared/lang" "$STAGE/shared/"'), 'Mac packages include the shared catalogs');
  for (const lproj of ['zh-Hans', 'ru', 'tr', 'pt-BR']) {
    assert.ok(build.includes(`locales/${lproj}.lproj`), `Mac packages include ${lproj} system permission descriptions`);
    assert.ok(build.includes(`<string>${lproj}</string>`), `Mac bundle lists the ${lproj} localization`);
    const descriptions = fs.readFileSync(path.join(ROOT, `mac/locales/${lproj}.lproj/InfoPlist.strings`), 'utf8');
    for (const [, key] of build.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)) {
      // The system extension has its own bundle; the app's permission descriptions live here.
      if (key !== 'NSSystemExtensionUsageDescription') assert.ok(descriptions.includes('"' + key + '" = '), `${lproj} system description: ${key}`);
    }
  }
  for (const mode of ['mac', 'mac/mesh']) {
    const source = fs.readFileSync(path.join(ROOT, mode, 'main.js'), 'utf8');
    const code = source.slice(source.indexOf('function updateTray()'), source.indexOf('app.whenReady().then'));
    let menu;
    const settings = require(path.join(ROOT, mode, 'store')).loadSettings();
    const i18n = require('../i18n').create('zh-CN');
    const context = {
      state: { client: { name: 'Work $& {me}', os: 'win' }, input: { where: 'home' }, found: [] },
      settings, id: { macName: 'Mac $& {name}' }, svc: null, link: null, updates: null,
      tray: { setToolTip() {}, setContextMenu(value) { menu = value; } }, trayKey: '',
      Menu: { buildFromTemplate: (x) => x, setApplicationMenu() {} }, P: require('../protocol'),
      CL: require('../cursorlock'), trayMenu: require('../traymenu'),
      i18n, t: (...args) => i18n.t(...args), rezumeItems: () => [], displayMode: () => 'mirror', shareAs() {},
      actions: {}, showWindow() {}, showUpdateWindow() {}, app: {},
    };
    vm.runInNewContext(code + '\nupdateTray();', context);
    const labels = (items) => items.flatMap((x) => [x.label, ...(x.submenu ? labels(x.submenu) : [])]).filter(Boolean);
    const text = labels(menu).join('\n');
    assert.ok(text.includes('Work $& {me}'), 'menu device names remain literal');
    assert.ok(text.includes('Mac $& {name}'), 'local names remain literal');
    assert.ok(!/Use Mouse and Keyboard|Lock Cursor|Connected to/.test(text), `${mode} application menu captions are translated: ${text}`);
  }
  const kit = { MacShareProtocol: require('../protocol') };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'mac/control.js'), 'utf8'), {
    window: kit, I18n: require('../i18n').create('zh-CN'),
    document: { createElement: () => ({ dataset: {}, append() {}, setAttribute() {}, classList: { add() {} } }) },
  });
  kit.UI.state = { macName: 'Mac', client: { name: 'Peer', os: 'win' } };
  const row = kit.UI.row('To {name}', 'Folder {name} $&', [], { literalHint: true });
  assert.strictEqual(row.label.textContent, 'To Peer');
  assert.strictEqual(row.hint.textContent, 'Folder {name} $&');
  row.setHint('New {me}'); assert.strictEqual(row.hint.textContent, 'New {me}');
  assert.strictEqual(kit.UI.monitorLabel('Built-in display'), '内置显示器');
  assert.strictEqual(kit.UI.monitorLabel('Display 7'), '显示器 7');
  assert.strictEqual(kit.UI.monitorLabel('Studio $& {name}'), 'Studio $& {name}');
  for (const locale of [null, 'en', 'zh-CN']) {
    const UI = {}, language = locale ? require('../i18n').create(locale) : null;
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'shared/ui-adb.js'), 'utf8'), { UI, window: { I18n: language } });
    const error = 'native {me} $&';
    const text = `Pairing didn’t work (${error}). Try a new code.`;
    const expected = language ? language.t('Pairing didn’t work ({error}). Try a new code.', { error }) : text;
    assert.strictEqual(UI.adbMessage(text), expected);
    assert.strictEqual(UI.adbMessage(error), error);
    const device = 'Phone $& {name}';
    assert.strictEqual(UI.adbMessage(`Installing on ${device}…`, device), language ? language.t('Installing on {device}…', { device }) : `Installing on ${device}…`);
  }
  const mainSource = fs.readFileSync(path.join(ROOT, 'mac/main.js'), 'utf8');
  const rezumeCode = mainSource.slice(mainSource.indexOf('function rezumeItems()'), mainSource.indexOf('function phoneAdb('));
  const rz = { view: { connected: true, incoming: { title: 'Doc {name} $&' }, last: { title: 'Page {me}' }, send: true }, take() {}, push() {} };
  const t = (...args) => require('../i18n').create('zh-CN').t(...args);
  const items = vm.runInNewContext(rezumeCode + '\nrezumeItems();', {
    svc: { rz }, settings: { rezume: { tray: true } }, peer: { current: { name: 'Peer {me} $&' } }, t,
  });
  assert.strictEqual(items[0].label, '继续 Peer {me} $& 上的 Doc {name} $&');
  assert.strictEqual(items[1].label, t('Send {title} to {name}', { title: 'Page {me}', name: 'Peer {me} $&' }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('i18n-mac: normal/Mesh settings, IPC, preload and resource inclusion passed');
