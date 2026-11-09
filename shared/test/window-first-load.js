// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Exercise the actual window factories without timing-dependent compositor events.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

for (const mode of ['windows', 'windows/mesh']) {
  const dir = path.resolve(__dirname, '../..', mode);
  const source = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const start = source.indexOf('function createMainWindow(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert(start >= 0 && end > start, 'found the actual window factory');
  const factory = source.slice(start, end);
  assert(factory.includes('new BrowserWindow'));
  for (const hidden of mode.endsWith('mesh') ? [false, true] : [false]) {
    for (const order of [['load', 'paint'], ['paint', 'load']]) {
      for (const destroyed of [false, true]) {
        let win;
        class Window extends EventEmitter {
          constructor() {
            super(); win = this; this.webContents = new EventEmitter();
            this.sent = []; this.shows = 0; this.focuses = 0; this.destroyed = false;
            this.webContents.send = (...args) => this.sent.push(args);
          }
          loadFile() {}
          isDestroyed() { return this.destroyed; }
          show() { this.shows++; }
          focus() { this.focuses++; }
        }
        const ctx = vm.createContext({ BrowserWindow: Window,
          path, __dirname: dir, nativeTheme: { shouldUseDarkColors: false }, i18n: { locale: 'zh-CN' }, Look: { style: () => 'default' }, settings: { windows: {}, ui: {} },
          mainWin: null, startHidden: hidden, quitting: false, saveBounds() {},
        });
        vm.runInContext(factory + '\ncreateMainWindow("general");', ctx);
        win.destroyed = destroyed;
        for (const event of order) {
          if (event === 'load') win.webContents.emit('did-finish-load'); else win.emit('ready-to-show');
          assert.strictEqual(win.shows, destroyed || hidden ? 0 : 1, `${mode}: ${event} must show once without waiting for the other event`);
        }
        assert.strictEqual(win.focuses, !destroyed && mode === 'windows' ? 1 : 0);
        if (!destroyed && mode === 'windows') assert.deepStrictEqual(win.sent, [['go', 'general']]);
        // A settings reload must not reopen a window the user has hidden to the tray.
        win.webContents.emit('did-finish-load'); win.emit('ready-to-show');
        assert.strictEqual(win.shows, destroyed || hidden ? 0 : 1);
      }
    }
  }
}
console.log('window-first-load: ordinary/Mesh load/paint ordering, single show, hidden startup and closed windows passed');
