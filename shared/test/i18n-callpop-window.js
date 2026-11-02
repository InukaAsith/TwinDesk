// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. Fake call state only; no phone or native call operations.
'use strict';
if (!process.versions.electron) {
  console.log('i18n-callpop-window: run with Electron');
  return;
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I18n = require('../i18n');
const ROOT = path.resolve(__dirname, '../..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-callpop-i18n-')));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const name = 'Answer {name} $& <script>raw</script>', number = '+86 {number} $& 123', phone = 'Phone {phone} $&';
let state;
ipcMain.handle('callpop:state', () => state);
const watchdog = setTimeout(() => { console.error('Call popup translation test timed out'); app.exit(1); }, 30000);

async function run(language) {
  state = { call: { name, number, state: 'ringing' }, phone, audio: { state: 'ready', here: true }, muted: false };
  const win = new BrowserWindow({ show: false, frame: false, width: 360, height: 124, webPreferences: { preload: path.join(ROOT, 'shared/preload-callpop.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  const actions = [], errors = [], extras = [];
  const capture = (event, value) => { if (event.sender === win.webContents) actions.push(value); };
  const close = (event) => { if (event.sender === win.webContents) extras.push('close'); };
  const open = (event) => { if (event.sender === win.webContents) extras.push('open'); };
  ipcMain.on('callpop:act', capture); ipcMain.on('callpop:close', close); ipcMain.on('callpop:open', open);
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const read = (code) => win.webContents.executeJavaScript(code);
  const text = (id) => read(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const update = async (value) => { state = value; win.webContents.send('callpop:state', state); await delay(25); };
  const click = async (id) => { await read(`document.getElementById(${JSON.stringify(id)}).click()`); await delay(25); };
  try {
    await win.loadFile(path.join(ROOT, 'shared/callpop.html'), language ? { query: { language } } : {});
    await delay(60);
    assert.equal(await read('document.documentElement.lang'), language || 'en', 'popup initial locale');
    assert.equal(await text('who'), name, 'initial state is loaded through the sandbox bridge');
    assert.equal(await text('sub'), I18n.create(language || 'en').t('Incoming · {number}', { number }), 'initial ringing state is translated');
    for (const locale of [language || 'en', language === 'zh-CN' ? 'en' : 'zh-CN', language || 'en']) {
      win.webContents.send('ui-language', locale); await delay(25);
      const t = I18n.create(locale).t;
      assert.equal(await read('document.documentElement.lang'), locale, 'live popup locale');
      assert.equal(await read('document.title'), t('call.windowTitle'));
      for (const [id, key] of [['answer', 'Answer'], ['decline', 'Decline'], ['end', 'End'], ['close', 'Hide']]) {
        assert.equal(await read(`document.getElementById('${id}').title`), t(key));
        assert.equal(await read(`document.getElementById('${id}').getAttribute('aria-label')`), t(key));
      }
      await update({ ...state, phone, call: { name, number, state: 'ringing' }, ended: null, muted: false });
      assert.equal(await text('who'), name, 'contact names stay literal');
      assert.equal(await text('sub'), t('Incoming · {number}', { number }));
      if (locale === 'zh-CN') assert.match(await text('sub'), /[\u3400-\u9fff]/, 'ringing status has a Chinese translation');
      const other = locale === 'en' ? 'zh-CN' : 'en';
      win.webContents.send('ui-language', other); await delay(25);
      assert.equal(await text('who'), name, 'live translation retains contact name');
      assert.equal(await text('sub'), I18n.create(other).t('Incoming · {number}', { number }), 'ringing status switches without a new state event');
      win.webContents.send('ui-language', locale); await delay(25);
      await click('answer'); await click('decline');
      await update({ ...state, call: { number, state: 'ringing' } });
      assert.equal(await text('who'), number, 'phone numbers stay literal');
      assert.equal(await text('sub'), t('Incoming call on {phone}', { phone }));
      await update({ ...state, phone: '', call: { state: 'ringing' } });
      assert.equal(await text('who'), t('Unknown number'));
      assert.equal(await text('sub'), t('Incoming call'));
      assert.equal(await read(`Array.from(document.querySelectorAll('button:not([hidden])')).every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })`), true, 'call buttons fit the real popup size');
      if (process.env.TWINDESK_I18N_SCREENSHOTS) {
        await delay(100);
        fs.mkdirSync(process.env.TWINDESK_I18N_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(path.join(process.env.TWINDESK_I18N_SCREENSHOTS, 'call-popup-' + locale + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      for (const dir of ['in', 'out']) {
        await update({ ...state, call: { name, number, state: 'active', dir, since: Date.now() }, audio: { state: 'ready', here: true } });
        assert.equal(await text('sub'), t(dir === 'out' ? 'Calling · {time}' : 'On a call · {time}', { time: '0:00' }));
        assert.equal(await read('document.getElementById("mute").title'), t('Mute'));
        assert.equal(await read('document.getElementById("where").title'), t('Move the sound to the phone'));
      }
      await click('mute'); await click('where'); await click('end');
      await update({ ...state, muted: true, audio: { state: 'ready', here: false } });
      assert.equal(await read('document.getElementById("mute").title'), t('Unmute'));
      assert.equal(await read('document.getElementById("where").title'), t('Move the sound here'));
      win.webContents.send('ui-language', other); await delay(25);
      assert.equal(await text('sub'), I18n.create(other).t('Calling · {time}', { time: '0:00' }));
      assert.equal(await read('document.getElementById("mute").title'), I18n.create(other).t('Unmute'), 'muted tooltip survives static retranslation');
      assert.equal(await read('document.getElementById("where").title'), I18n.create(other).t('Move the sound here'));
      assert.equal(await text('who'), name);
      win.webContents.send('ui-language', locale); await delay(25);
      await click('mute'); await click('where');
      for (const missed of [true, false]) {
        await update({ ...state, call: null, ended: { name, number, missed } });
        assert.equal(await text('who'), name);
        assert.equal(await text('sub'), t(missed ? 'Missed call' : 'Call ended'));
        assert.equal(await read('document.getElementById("answer").hidden && document.getElementById("end").hidden'), true);
        win.webContents.send('ui-language', other); await delay(25);
        assert.equal(await text('sub'), I18n.create(other).t(missed ? 'Missed call' : 'Call ended'), 'ended state switches without a new state event');
        win.webContents.send('ui-language', locale); await delay(25);
      }
      await read('document.querySelector(".cp-text").click()'); await click('close');
      assert.deepStrictEqual(actions.splice(0), [
        { do: 'call', a: 'answer' }, { do: 'call', a: 'end' }, { do: 'call', a: 'mute', on: true },
        { do: 'audio', a: 'phone' }, { do: 'call', a: 'end' }, { do: 'call', a: 'mute', on: false }, { do: 'audio', a: 'here' },
      ], 'translated buttons preserve exact call and audio commands');
      assert.deepStrictEqual(extras.splice(0), ['open', 'close']);
    }
    assert.deepStrictEqual(errors, [], 'no popup JavaScript errors');
  } finally {
    ipcMain.removeListener('callpop:act', capture); ipcMain.removeListener('callpop:close', close); ipcMain.removeListener('callpop:open', open);
    win.destroy();
  }
}

app.whenReady().then(async () => {
  for (const language of ['zh-CN', 'en', undefined]) await run(language);
  clearTimeout(watchdog);
  console.log('i18n-callpop-window: sandboxed popup, initial/live EN/ZH, all call states, literal data and unchanged commands passed');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
