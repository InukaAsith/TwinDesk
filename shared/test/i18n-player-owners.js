// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const I18n = require('../i18n.js');
const ROOT = path.resolve(__dirname, '../..');

function fixture(file, language, system = 'en-US') {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options = {}) {
      super(); this.options = options; this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    loadFile(file, options = {}) { this.loaded = { file, ...options }; }
    isDestroyed() { return false; }
    setTitle(value) { this.title = value; }
    setMenu() {}
    getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
    getContentBounds() { return this.getBounds(); }
    getSize() { return [800, 600]; }
    getContentSize() { return [800, 600]; }
    setMaximumSize() {}
  }
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1080 } };
  const electron = {
    app: { on() {}, getLocale: () => system }, BrowserWindow: Window, ipcMain: { on() {} },
    screen: { on() {}, getPrimaryDisplay: () => display, getDisplayMatching: () => display },
  };
  const filename = path.join(ROOT, file), localRequire = createRequire(filename), mod = { exports: {} };
  const settings = { ui: { language }, windows: { monitor: {} }, monitor: {}, receive: {}, phone: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './viewer-keys') return { attachKeys: () => ({ release() {} }) };
      if (name === './dockstub') return {};
      if (name === './scrcpy') return {};
      if (name === './android-keys') return { KeyState: class {}, ANDROID: {} };
      return localRequire(name);
    },
    module: mod, __dirname: path.dirname(filename), console, process, setTimeout, clearTimeout, setImmediate,
  }, { filename });
  return { windows, exported: mod.exports, settings, electron };
}

for (const [preference, system, expected] of [['zh-CN', 'en-US', 'zh-CN'], ['en', 'zh-CN', 'en'], ['', 'zh-SG', 'zh-CN']]) {
  for (const [file, name, method] of [
    ['windows/screen.js', '', '_create'],
    ['windows/peerapps.js', '', '_create'], ['windows/peerapps.js', '', '_createPopup'],
    ['mac/pcview.js', 'PcView', '_open'],
    ['mac/pcapps.js', 'PcApps', '_create'], ['mac/pcapps.js', 'PcApps', '_createPopup'],
    ['windows/phoneview.js', 'PhoneViews', '_open'], ['mac/phoneview.js', 'PhoneViews', '_open'],
  ]) {
    const f = fixture(file, preference, system), Class = name ? f.exported[name] : f.exported;
    const owner = Object.create(Class.prototype);
    Object.assign(owner, {
      settings: f.settings, getSettings: () => f.settings, state: { width: 0, height: 0 }, test: true,
      server: { current: { name: 'Remote {name} $&' } }, link: { snapshot: () => ({ link: {} }) },
      wins: new Map([[1, { win: new f.electron.BrowserWindow() }]]), views: new Map(), list: [], apps: file === 'windows/screen.js' ? null : [],
      bridge: { serial: 'test' }, _dress() {}, _limit() {}, _title: () => 'Remote {name} $&', _popupBounds: () => ({}),
      _send() {}, _opts: () => ({}), _start: async () => {}, emit() {}, onChange() {},
    });
    owner[method]({ wid: 2, owner: 1, id: 'app', w: 640, h: 480, scale: 1, kind: 'screen', title: 'Remote {name} $&', width: 640, height: 480 });
    const loaded = f.windows.at(-1).loaded;
    assert.strictEqual(loaded.query && loaded.query.language, expected, `${file} ${method} resolves local preference/system language`);
    if (file === 'windows/screen.js') assert.strictEqual(loaded.query.test, '1', 'monitor test mode is preserved');
    if (file.includes('peerapps') || file.includes('pcapps') || file.includes('pcview')) {
      assert.strictEqual(loaded.query.title, 'Remote {name} $&', `${file} preserves its native literal title in the renderer`);
      assert.strictEqual(loaded.query.titleKey, '', 'remote titles never become translation keys');
    }
    if (file === 'mac/pcview.js') {
      owner.win = null; owner.server.current = null;
      owner._open();
      assert.strictEqual(f.windows.at(-1).loaded.query.titleKey, 'PC');
    }
    if (file.includes('phoneview')) {
      assert.strictEqual(loaded.query.title, 'Remote {name} $&', 'remote title is literal');
      assert.strictEqual(loaded.query.kind, 'screen');
      if (file.startsWith('windows/')) assert.strictEqual(loaded.query.controls, 'top');
    }
  }
}

for (const [file, exported, fallback] of [['windows/peerapps.js', '', 'App'], ['mac/pcapps.js', 'PcApps', 'PC app']]) {
  const f = fixture(file, 'zh-CN'), Class = exported ? f.exported[exported] : f.exported;
  const owner = Object.create(Class.prototype);
  Object.assign(owner, {
    settings: f.settings, getSettings: () => f.settings, list: [], apps: [], wins: new Map(),
    _dress() {}, _limit() {}, onChange() {}, emit() {},
  });
  const info = { wid: 2, id: 'app', title: '', w: 640, h: 480, scale: 1 };
  owner._create(info);
  const w = owner.wins.get(info.wid);
  assert.strictEqual(w.win.loaded.query.titleKey, fallback);
  f.settings.ui.language = 'en';
  let prevented = false;
  w.win.emit('page-title-updated', { preventDefault() { prevented = true; } });
  assert.ok(prevented, 'native title is controlled by its current owner');
  assert.strictEqual(w.win.title, fallback, 'native fallback changes language with its page');
  const title = 'Ready {name} $&';
  owner._update(w, { ...info, title });
  assert.strictEqual(w.win.title, title);
  assert.strictEqual(w.queue.at(-1).t, 'title');
  assert.strictEqual(w.queue.at(-1).title, title);
  assert.strictEqual(w.queue.at(-1).titleKey, '', 'a remote rename replaces the previous fallback binding');
  f.settings.ui.language = 'zh-CN';
  w.win.emit('page-title-updated', { preventDefault() {} });
  assert.strictEqual(w.win.title, title, 'language changes cannot overwrite a newer remote title');
  owner._update(w, info);
  assert.strictEqual(w.queue.at(-1).titleKey, fallback, 'missing remote titles restore the retained fallback key');
}

for (const file of ['windows/phoneview.js', 'mac/phoneview.js']) {
  const f = fixture(file, 'zh-CN'), owner = Object.create(f.exported.PhoneViews.prototype);
  let opened;
  Object.assign(owner, {
    getSettings: () => f.settings, server: { current: null }, phone: {}, views: new Map(),
    bridge: { sessionOpts: () => ({}) }, emit() {}, _open: (opts) => { opened = opts; return {}; },
  });
  owner.openScreen();
  assert.strictEqual(opened.titleKey, 'Phone', `${file} fallback title retains its key`);
  owner.openCamera({});
  assert.strictEqual(opened.titleKey, 'Phone Camera');
  const remote = 'Phone {name} $&';
  owner.server.current = { name: remote };
  owner.openScreen();
  assert.strictEqual(opened.title, remote);
  assert.strictEqual(opened.titleKey, '');
  owner.openCamera({});
  assert.strictEqual(opened.titleKey, '{name} Camera');
  assert.strictEqual(opened.titleName, remote);
}

{
  const f = fixture('mac/pcview.js', 'zh-CN'), server = new EventEmitter(), messages = [];
  server.current = { name: 'PC {name} $&' };
  const owner = new f.exported.PcView({ server, getSettings: () => f.settings });
  owner._toWin = (m) => messages.push(m);
  server.emit(`t:${require('../protocol.js').T.RTC2_STOP}`, {});
  assert.strictEqual(messages[0].why, 'PC {name} $& stopped sharing', 'legacy reason stays compatible');
  assert.strictEqual(messages[0].whyKey, '{name} stopped sharing');
  assert.strictEqual(messages[0].whyVars.name, server.current.name);
  server.current = null;
  server.emit('closed');
  assert.strictEqual(messages[1].whyKey, 'Waiting for the other computer…');
}

// Both camera windows opt in locally; existing callers (including Linux) default to English.
for (const language of [undefined, 'en', 'zh-CN']) {
  const f = fixture('shared/camshare.js', ''), CamShare = f.exported.CamShare;
  const owner = new CamShare({
    link: { on() {}, closed() {}, connected: () => true, send() {} },
    cfg: () => ({}), peerName: () => 'Camera {name} $&', onChange() {},
    ...(language ? { getLanguage: () => language } : {}),
  });
  owner._ask = () => {};
  owner.view(); owner._toSender({ t: 'devices' }, true);
  for (const win of f.windows) assert.strictEqual(win.loaded.query.language, language || 'en');
  assert.strictEqual(f.windows[0].loaded.query.name, 'Camera {name} $&');
}

// A new language restarts TwinDesk (windows load only their language's catalog): the real handler
// bodies relaunch and quit cleanly (never exit, which would skip before-quit), and message no window.
for (const file of ['windows/main.js', 'windows/mesh/main.js', 'linux/main.js', 'linux/mesh/main.js', 'mac/main.js', 'mac/mesh/main.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = source.indexOf('function changeLanguage() {');
  let depth = 0, end = start;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const calls = [], messages = [], context = {
    process: { argv: ['electron', '.', '--hidden', '--x'] },
    app: { relaunch: (o) => calls.push(['relaunch', o]), quit: () => calls.push(['quit']), exit: () => calls.push(['exit']) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } }] },
  };
  vm.runInNewContext(source.slice(start, end) + '\nchangeLanguage();', context, { filename: file });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['relaunch', 'quit'], `${file} restarts TwinDesk`);
  if (calls[0][1]) assert.ok(!calls[0][1].args.includes('--hidden'), `${file} shows the window again`);
  assert.deepStrictEqual(messages, [], `${file} messages no window`);
}

for (const file of ['windows/main.js', 'windows/mesh/main.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const callback = source.match(/onProgress: (\(v\) => \{[^\r\n]+ \}) \}\);/)[1];
  let sent, pushes = 0;
  const update = vm.runInNewContext('(' + callback + ')', {
    screen: { sendDropProgress: (value) => { sent = value; } }, peerName: () => 'Peer {name} $&',
    pushState: () => { pushes++; }, fillAll: () => { throw new Error('player data must stay literal'); },
  });
  const value = { current: { name: 'File {name} $&' }, last: { text: 'Native {me} error' } };
  update(value);
  assert.strictEqual(sent.current, value.current);
  assert.strictEqual(sent.last, value.last);
  assert.strictEqual(sent.peerName, 'Peer {name} $&');
  assert.strictEqual(pushes, 1);
}
console.log('player owner language forwarding and live broadcasts OK');
