// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. No application is launched or pinned.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const I18n = require('../i18n');
const { T } = require('../protocol');
const electron = process.versions.electron ? require('electron') : null;
const filename = path.resolve(__dirname, '../../windows/apps.js');
const localRequire = createRequire(filename);
const name = 'App <b>raw</b> <script>window.bad=1</script> & {app} $& "quoted"';
const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function run() {
  for (const [language, system, locale] of [['zh-CN', 'en-US', 'zh-CN'], ['en', 'zh-CN', 'en'], [undefined, 'zh-SG', 'zh-CN'], [undefined, 'en-US', 'en']]) {
    const windows = [], timers = [];
    class Window extends EventEmitter {
      constructor(options) {
        super(); this.options = options; this.progress = null; this.minimized = false;
        if (electron) {
          this.native = new electron.BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
          this.native.on('closed', () => this.emit('closed'));
        }
        windows.push(this);
      }
      setMenu(value) { assert.equal(value, null); }
      loadURL(url) { this.url = url; this.loaded = this.native ? this.native.loadURL(url) : Promise.resolve(); }
      setProgressBar(value, options) { this.progress = { value, ...options }; }
      minimize() { this.minimized = true; }
      isDestroyed() { return this.native ? this.native.isDestroyed() : this.destroyed; }
      destroy() { this.destroyed = true; if (this.native) this.native.destroy(); else this.emit('closed'); }
    }
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: mod, process, console, __dirname: path.dirname(filename),
      require: (request) => request === 'electron' ? { app: { getLocale: () => system }, BrowserWindow: Window } : localRequire(request),
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    }, { filename });
    const owner = Object.create(mod.exports.prototype);
    let details, watches = 0;
    Object.assign(owner, { opening: new Map(), onWatch: () => { watches++; }, _details: (win, id, app) => { details = { win, id, app }; }, ...(language ? { getLanguage: () => language } : {}) });
    for (const appName of [name, 'the app', '']) {
      const id = 'fixture-' + windows.length, app = { name: appName };
      owner._placeholder(id, appName, app);
      const win = windows.at(-1);
      const displayName = appName || I18n.create(locale).t('the app');
      const expected = locale === 'zh-CN' ? `正在打开 ${displayName}…` : `Opening ${displayName}…`;
      try {
        assert.equal(win.options.title, expected, 'placeholder native title follows the preference/system locale');
        assert.equal(win.options.webPreferences.sandbox, true);
        assert.equal(win.options.webPreferences.nodeIntegration, false);
        assert.equal(win.options.show, false);
        const html = decodeURIComponent(win.url.slice(win.url.indexOf(',') + 1));
        assert.ok(html.includes('>' + escape(expected) + '</body>'), 'data document encodes literal app names without deleting characters');
        assert.deepStrictEqual(win.progress, { value: 2, mode: 'indeterminate' });
        assert.equal(win.minimized, true, 'placeholder remains a taskbar-only progress window');
        assert.strictEqual(details.win, win); assert.equal(details.id, id); assert.strictEqual(details.app, app);
        assert.equal(timers.at(-1).ms, 30000, 'placeholder lifetime stays unchanged');
        owner._placeholder(id, appName, app);
        assert.equal(windows.at(-1), win, 'repeated launch keeps the existing placeholder');
        if (electron) {
          await win.loaded;
          assert.equal(win.native.getTitle(), expected, 'native title remains translated after the data document loads');
          assert.equal(await win.native.webContents.executeJavaScript('document.body.textContent'), expected, 'actual sandboxed renderer preserves app names');
          assert.equal(await win.native.webContents.executeJavaScript('document.querySelectorAll("b,script").length'), 0, 'app names do not become markup');
          assert.equal(await win.native.webContents.executeJavaScript('typeof require'), 'undefined');
        }
        const before = watches;
        timers.at(-1).fn();
        assert.equal(owner.opening.has(id), false, 'same timeout closes only its placeholder');
        assert.equal(watches, before + 1);
      } finally { if (!win.isDestroyed()) win.destroy(); }
    }
    const commands = [];
    Object.assign(owner, {
      list: [], windows: [], allowed: () => true, _shortcutName: () => '', onChange() {},
      popup() {}, peerName: () => 'Peer {name} $&',
      link: { send: (message) => { commands.push(message); return true; } },
    });
    owner.launch('launch-fixture');
    const win = windows.at(-1);
    try {
      assert.equal(JSON.stringify(commands), JSON.stringify([{ t: T.APP_LAUNCH, id: 'launch-fixture' }]), 'launch protocol stays unchanged');
      assert.equal(win.options.title, I18n.create(locale).t('Opening {app}…', { app: I18n.create(locale).t('the app') }), 'launch supplies a localizable missing-app fallback');
      await win.loaded;
    } finally { win.destroy(); }
  }
  console.log('i18n-app-placeholder: preference/system EN/ZH, escaped literal names, sandbox, taskbar behavior and lifetime passed' + (electron ? ' in Electron' : ''));
}

if (electron) {
  electron.app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'twindesk-placeholder-i18n-')));
  electron.app.commandLine.appendSwitch('disable-gpu');
  electron.app.on('window-all-closed', () => {});
  const watchdog = setTimeout(() => { console.error('Placeholder test timed out'); electron.app.exit(1); }, 30000);
  electron.app.whenReady().then(run).then(() => { clearTimeout(watchdog); electron.app.exit(0); }).catch((error) => { console.error(error); electron.app.exit(1); });
} else run().catch((error) => { console.error(error); process.exitCode = 1; });
