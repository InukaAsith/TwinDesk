// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const I18n = require('../i18n');
const literal = 'Notes {me} {name} $& <b>raw</b>';
for (const platform of ['windows', 'mac']) {
  const nodes = new Map();
  let languageChange, message;
  const node = (id) => nodes.get(id) || nodes.set(id, { textContent: '', className: '', offsetWidth: 0, classList: { add() {}, remove() {}, toggle() {} } }).get(id);
  const context = { document: { getElementById: node, body: node('body') }, window: { hud: { on: (fn) => { message = fn; } }, PlayerI18n: { t: I18n.create('zh-CN').t, onChange: (fn) => { languageChange = fn; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../', platform, 'hud-renderer.js'), 'utf8'), context);
  const key = 'Using {name}';
  message({ kind: 'away', text: { key, vars: { name: literal } } });
  assert.equal(node('text').textContent, I18n.create('zh-CN').t(key, { name: literal }), platform + ' translates message metadata');
  context.window.PlayerI18n.t = I18n.create('en').t;
  languageChange();
  assert.equal(node('text').textContent, 'Using ' + literal, 'live language keeps variable literal');
  message({ kind: 'home', text: 'Not connected' });
  assert.equal(node('text').textContent, 'Not connected', 'raw/native strings are literal even when matching catalog');
  context.window.PlayerI18n.t = I18n.create('zh-CN').t;
  languageChange();
  assert.equal(node('text').textContent, 'Not connected');
  message({ kind: 'linkOn', text: { key: 'Cursor sharing on' }, sub: { key: 'With {name}. Double-tap {key} to turn it off', vars: { name: literal, key: 'Ctrl' } } });
  assert.equal(node('card-sub').textContent, I18n.create('zh-CN').t('With {name}. Double-tap {key} to turn it off', { name: literal, key: 'Ctrl' }));
  message({ kind: 'home', text: { key: '{result}: they’re on the clipboard, paste them with {keys}', vars: { result: { key: 'Pasted {count} files', vars: { count: 2 } }, keys: 'Ctrl+V' } } });
  assert.equal(node('text').textContent, I18n.create('zh-CN').t('{result}: they’re on the clipboard, paste them with {keys}', { result: I18n.create('zh-CN').t('Pasted {count} files', { count: 2 }), keys: 'Ctrl+V' }));
}
for (const platform of ['windows', 'mac']) for (const preference of ['', 'en', 'zh-CN']) {
  const file = path.join(__dirname, '../../', platform, 'hud.js');
  let loaded;
  class FakeWindow {
    isDestroyed() { return false; }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    loadFile(file, options) { loaded = options; return Promise.resolve(); }
  }
  const module = { exports: {} };
  const customRequire = (name) => name === 'electron' ? { app: { getLocale: () => 'zh_CN' }, BrowserWindow: FakeWindow } : name.includes('i18n') ? I18n : require(name);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: customRequire, module, __dirname: path.dirname(file), setTimeout, clearTimeout });
  const Hud = platform === 'windows' ? module.exports : module.exports.Hud;
  new Hud(() => ({ ui: { language: preference }, app: {} }))._ensure();
  assert.equal(loaded.query.language, preference || 'zh-CN', 'HUD startup resolves system/saved preference');
}
// Test real producer callbacks in isolation: no native helper, files, or network is started.
for (const platform of ['windows', 'mac']) {
  const file = path.join(__dirname, '../../', platform, 'fclip.js');
  const source = fs.readFileSync(file, 'utf8');
  const captures = [];
  const stub = { app: {}, globalShortcut: {}, clipboard: {} };
  const customRequire = (name) => name === 'electron' ? stub : name.includes('pastefiles') ? {} : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  const module = { exports: {} };
  vm.runInNewContext(source, { require: customRequire, module, process, console, Buffer, setTimeout, clearTimeout });
  const FileClip = platform === 'windows' ? module.exports : module.exports.FileClip;
  if (platform === 'windows') {
    FileClip.prototype.pasted.call({ pasting: { id: 'b' }, popup: (kind, text) => captures.push(text), onChange() {} }, { batch: 'b', ok: true, files: 2, count: 2 }); // #117: only the batch being pasted
    assert.deepEqual(JSON.parse(JSON.stringify(captures[0])), { key: 'Pasted {count} files', vars: { count: 2 } }, 'file completion carries local metadata');
  } else {
    const server = new EventEmitter();
    const drop = new EventEmitter();
    const clip = new FileClip({ server, helper: {}, fileSend: {}, drop, getSettings: () => ({ files: { shortcuts: false } }) });
    clip.on('popup', (kind, text) => captures.push(text));
    drop.emit('batch', { kind: 'paste', ok: false, files: 1, count: 2 });
    assert.deepEqual(JSON.parse(JSON.stringify(captures[0])), { key: 'Pasted {count} of {total} files', vars: { count: 1, total: 2 } });
  }
}
for (const platform of ['windows', 'mac']) for (const mesh of [false, true]) {
  const file = path.join(__dirname, '../../', platform, mesh ? 'mesh/main.js' : 'main.js');
  const source = fs.readFileSync(file, 'utf8');
  const captured = [];
  const callbacks = {};
  const context = { hud: { show: (...args) => captured.push(args) }, settings: { kvm: { mouse: true }, keys: { hotkey: 'Ctrl' } }, id: { macName: literal }, device: { name: literal }, peerName: () => literal, peer: { current: { name: literal } }, phoneRemote: null, svc: { kvm: { on: (event, fn) => { callbacks[event] = fn; } }, pcApps: { setDriven() {} } }, kvm: { keyboardOnly: false }, P: {} };
  if (platform === 'windows') {
    const start = source.indexOf('  kvm.onWhere = ');
    vm.runInNewContext(source.slice(start, source.indexOf('\n  };', start) + 5), context);
    for (const mode of ['driving', 'driven', 'home']) context.kvm.onWhere(mode);
    assert.ok(!source.includes('hudShow(kind, fillNames('), 'HUD variables bypass legacy replacement');
  } else {
    const start = source.indexOf("  svc.kvm.on('where', (mode) => {");
    vm.runInNewContext(source.slice(start, source.indexOf('\n  });', start) + 6), context);
    for (const mode of ['driving', 'driven', 'home']) callbacks.where(mode);
  }
  const messages = JSON.parse(JSON.stringify(captured));
  assert.deepEqual(messages[0], ['away', { key: 'Using {name}', vars: { name: literal } }]);
  assert.deepEqual(messages[1], ['driven', { key: '{name} is using {me}', vars: { name: literal, me: literal } }]);
  assert.deepEqual(messages[2], ['home', { key: 'Back on {me}', vars: { me: literal } }]);
}
console.log('i18n-hud: ok');
