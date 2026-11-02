// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. Only the window owner is run; calls and native windows are faked.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const filename = path.resolve(__dirname, '../callwin.js');
for (const language of [undefined, 'en', 'zh-CN']) {
  const windows = [], acts = [], handlers = {};
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = { send() {} }; windows.push(this); }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile(file, options) { this.loaded = { file, ...options }; }
    close() {}
  }
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, __dirname: path.dirname(filename), process, clearTimeout, setTimeout,
    require: (name) => name === 'electron' ? {
      BrowserWindow: Window, nativeTheme: {}, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      ipcMain: { on: (channel, fn) => { handlers[channel] = fn; }, handle() {} },
    } : require(name),
  });
  mod.exports.update({ view: { call: { state: 'ringing' } }, act: (r) => acts.push(r) }, { corner: 'top', open() {}, ...(language ? { getLanguage: () => language } : {}) });
  assert.equal(windows[0].loaded.query && windows[0].loaded.query.language, language || 'en', 'call popup opts into a language, with English as the Linux-compatible default');
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  const command = { do: 'call', a: 'answer' };
  handlers['callpop:act']({}, command);
  assert.strictEqual(acts[0], command, 'owner forwards the existing action object unchanged');
  mod.exports.close();
}
console.log('i18n-callpop-owner: language query/default, sandbox and unchanged actions passed');
