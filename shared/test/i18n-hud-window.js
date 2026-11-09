// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
if (!process.versions.electron) { console.log('i18n-hud-window: run with Electron'); return; }
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I18n = require('../i18n');
const root = path.resolve(__dirname, '../..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-hud-i18n-')));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('HUD test timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  for (const platform of ['windows', 'mac']) for (const locale of ['zh-CN', 'en']) {
    const errors = [];
    const win = new BrowserWindow({ show: false, frame: false, width: platform === 'windows' ? 380 : 360, height: 64, webPreferences: { preload: path.join(root, platform, 'preload-hud.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const read = (code) => win.webContents.executeJavaScript(code);
    await win.loadFile(path.join(root, platform, 'hud.html'), { query: { language: locale } });
    // English and the page's own language only (shared/lang/pick.js, written in under the page's CSP).
    assert.deepEqual(await read('Object.keys(TwinDeskLanguages).sort()'), [...new Set(['en', locale])].sort(), 'the HUD loads one language');
    const literal = '{me} {name} $& <b>raw</b>';
    for (const [kind, key, vars] of [['away', 'Using {name}', { name: literal }], ['driven', '{name} is using {me}', { name: literal, me: literal }], ['home', 'Back on {me}', { me: literal }], ['lock', 'Cursor locked on {name}', { name: literal }], ['lock', 'Cursor unlocked', {}], ['linkOn', 'Cursor sharing on', {}], ['linkOff', 'Cursor sharing off over Bluetooth', {}], ['driven', 'Receiving {count} files from {name} · {percent} %', { count: 2, name: literal, percent: 50 }], ['away', 'Sending {file} to {name} · {percent} %', { file: literal, name: literal, percent: 75 }], ['away', 'Sent {file} to {name}', { file: literal, name: literal }], ['home', 'Opening it when the phone is ready…', {}]]) {
      const big = kind.startsWith('link');
      win.setContentSize(big ? 460 : platform === 'windows' ? 380 : 360, big ? 230 : 64);
      const sub = { key: 'With {name}. Double-tap {key} to turn it off', vars: { name: literal, key: 'Ctrl' } };
      win.webContents.send('hud', { kind, text: { key, vars }, sub }); await delay(30);
      const selector = big ? 'card-text' : 'text';
      assert.equal(await read(`document.getElementById('${selector}').textContent`), I18n.create(locale).t(key, vars));
      if (locale === 'zh-CN') assert.match(await read(`document.getElementById('${selector}').textContent`), /[\u3400-\u9fff]/, 'HUD source messages have Chinese translations');
    }
    win.setContentSize(460, 230);
    const longName = 'StudioMacBookPro'.repeat(4);
    win.webContents.send('hud', { kind: 'linkOn', text: { key: 'Cursor sharing on' }, sub: { key: 'With {name}. Double-tap {key} to turn it off', vars: { name: longName, key: 'Ctrl' } } });
    await delay(450);
    const bounds = await read(`(() => { const card = document.querySelector('#card').getBoundingClientRect(), sub = document.querySelector('#card-sub').getBoundingClientRect(); return { card: { left:card.left,right:card.right,bottom:card.bottom }, sub: { left:sub.left,right:sub.right,bottom:sub.bottom } }; })()`);
    assert.ok(bounds.sub.left >= bounds.card.left && bounds.sub.right <= bounds.card.right && bounds.sub.bottom <= bounds.card.bottom, 'long literal device names reflow inside the actual sharing card');
    if (process.env.TWINDESK_I18N_SCREENSHOTS) {
      fs.mkdirSync(process.env.TWINDESK_I18N_SCREENSHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TWINDESK_I18N_SCREENSHOTS, platform + '-hud-' + locale + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.webContents.send('hud', { kind: 'home', text: literal }); await delay(20);
    assert.equal(await read("document.getElementById('text').textContent"), literal, 'raw native/user text remains literal');
    win.webContents.send('hud', { kind: 'home', text: 'Not connected' }); await delay(20);
    assert.equal(await read("document.getElementById('text').textContent"), 'Not connected', 'raw/native strings are not translated by catalog coincidence');
    win.webContents.send('hud', { kind: 'hide' }); await delay(20);
    assert.equal(await read("document.getElementById('pill').classList.contains('on')"), false, 'a dismissed HUD stays hidden');
    assert.deepEqual(errors, [], platform + ' preload/renderer errors');
    win.destroy();
  }
  clearTimeout(watchdog); console.log('i18n-hud-window: ok'); app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
