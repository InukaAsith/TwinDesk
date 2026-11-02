// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Actual sandboxed standalone players with fake media events; no devices or native helpers.
'use strict';
if (!process.versions.electron) {
  console.log('i18n-player-window: run with Electron');
  return;
}
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I18n = require('../i18n');
const ROOT = path.resolve(__dirname, '../..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-player-i18n-')));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const literal = 'Mirror {name} $& <script>raw</script>';
const cases = [
  { file: 'windows/monitor.html', preload: 'windows/preload-monitor.js', status: '#overlay', initial: 'Waiting for the other computer…', button: '#b-full', label: 'Full screen', channel: 'rtc', offer: { t: 'rtc.offer', session: 7, sdp: 'test' } },
  { file: 'windows/appview.html', preload: 'windows/preload-appview.js', status: '#overlay', initial: 'Connecting…', channel: 'appview', offer: { t: 'offer', session: 7, sdp: 'test' } },
  { file: 'mac/pcview.html', preload: 'mac/preload-pcview.js', status: '#overlay', initial: 'Connecting to the PC…', button: '#b-full', label: 'Full screen', channel: 'pcview', offer: { t: 'offer', session: 7, sdp: 'test', volume: 1 } },
  { file: 'windows/phoneview.html', preload: 'windows/preload-phoneview.js', status: '#status', initial: 'Connecting to the phone…', phone: true },
  { file: 'mac/phoneview.html', preload: 'mac/preload-phoneview.js', status: '#status', initial: 'Connecting to the phone…', phone: true },
  { file: 'shared/camera-view.html', preload: 'shared/preload-camera.js', status: '#status', initial: 'Asking for the camera…', button: '#again', label: 'Try again', channel: 'cam:in', offer: { t: 'offer', sdp: 'test' } },
];
const watchdog = setTimeout(() => { console.error('Player translation test timed out'); app.exit(1); }, 60000);

async function run(c, locale) {
  const errors = [];
  const controls = [];
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, c.preload), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  const controlChannel = c.phone ? 'phoneview:in' : c.file.includes('camera-view') ? 'cam:out' : c.file.includes('pcview') ? 'pcview:ctl' : 'monitor-ctl';
  const capture = (event, message) => { if (event.sender === win.webContents) controls.push(message); };
  ipcMain.on(controlChannel, capture);
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const read = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(c.file + ': ' + code.slice(0, 100) + ': ' + error.message + '\n' + errors.join('\n')); });
  const text = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const t = I18n.create(locale).t;
  const checkMarkers = async (language) => {
    const markers = await read(`Array.from(document.querySelectorAll('[data-i18n-title], [data-i18n-label], [data-i18n-placeholder]')).flatMap(el => [['title','data-i18n-title'],['aria-label','data-i18n-label'],['placeholder','data-i18n-placeholder']].filter(([,marker])=>el.hasAttribute(marker)).map(([attr,marker])=>({key:el.getAttribute(marker),value:el.getAttribute(attr)})))`);
    for (const marker of markers) assert.equal(marker.value, I18n.create(language).t(marker.key), 'translated tooltip/accessibility text');
    assert.ok(markers.length || c.file.includes('appview'), 'player controls were checked');
  };
  const query = { language: locale };
  if (c.phone) Object.assign(query, { kind: 'screen', title: literal });
  if (['mac/pcview.html', 'windows/appview.html'].includes(c.file)) query.title = literal;
  if (c.file.includes('camera-view')) query.name = literal;
  try {
    await win.loadFile(path.join(ROOT, c.file), { query });
    await delay(80);
    assert.equal(await read('document.documentElement.lang'), locale, c.file + ' startup locale');
    assert.equal(await text(c.status), t(c.initial), c.file + ' initial status');
    if (locale === 'zh-CN') assert.match(await text(c.status), /[\u3400-\u9fff]/, 'status must have a Chinese translation');
    if (c.button) assert.equal(await text(c.button), t(c.label));
    await checkMarkers(locale);
    if (['mac/pcview.html', 'windows/appview.html'].includes(c.file)) assert.equal(await read('document.title'), literal, 'remote window title is literal');
    if (c.file.includes('camera-view')) assert.equal(await read('document.title'), t('{name}’s camera', { name: literal }), 'camera title retains device name');
    if (c.phone) {
      assert.equal(await text('#title'), literal, 'phone/app names are literal');
      win.webContents.send('phoneview:status', { error: literal });
      await delay(40);
      assert.equal(await text('#status'), literal, 'native phone error is literal');
      win.webContents.send('phoneview:status', { via: 'usb' });
      await delay(20);
      assert.equal(await read('document.querySelector("#via").title'), t('Through the USB cable'));
    }
    await read(`window.__testPeers = []; window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; this.localDescription = { sdp: 'answer' }; this.closed = 0; window.__testPeers.push(this); }
      close() { this.closed++; }
      async setRemoteDescription() { if (window.__testOfferError) throw new Error(window.__testOfferError); }
      async setLocalDescription() {}
      async createAnswer() { return { sdp: 'answer' }; }
      async addIceCandidate() {}
      getReceivers() { return []; }
      getTransceivers() { return []; }
      async getStats() { return new Map([['video', { id:'video', type:'inbound-rtp', kind:'video', frameWidth:1920, frameHeight:1080, framesPerSecond:30, codecId:'codec', decoderImplementation:'literal-decoder', powerEfficientDecoder:true }], ['codec',{id:'codec',mimeType:'video/H264'}]]); }
    }; undefined;`);
    if (c.offer) { win.webContents.send(c.channel, c.offer); await delay(60); }
    const count = await read('window.__testPeers.length');
    if (c.file === 'windows/monitor.html') { win.webContents.send('toggle-stats'); await delay(30); assert.ok((await text('#stats')).includes('1920×1080')); }
    const other = locale === 'en' ? 'zh-CN' : 'en';
    win.webContents.send('ui-language', other);
    await delay(60);
    assert.equal(await read('document.documentElement.lang'), other, 'live locale');
    assert.equal(await read('window.__testPeers.length'), count, 'language switch does not recreate media');
    assert.equal(await read('window.__testPeers.reduce((n, p) => n + p.closed, 0)'), 0, 'language switch does not close media');
    if (c.button) assert.equal(await text(c.button), I18n.create(other).t(c.label));
    await checkMarkers(other);
    if (['mac/pcview.html', 'windows/appview.html'].includes(c.file)) assert.equal(await read('document.title'), literal, 'remote title survives language change');
    if (c.file.includes('camera-view')) assert.equal(await read('document.title'), I18n.create(other).t('{name}’s camera', { name: literal }), 'camera title updates without changing device name');
    if (c.phone) {
      assert.equal(await text('#status'), literal);
      assert.equal(await text('#title'), literal);
      const errorKey = 'Couldn’t prepare the screen helper ({error})';
      win.webContents.send('phoneview:status', { error: 'legacy error', errorKey, errorVars: { error: literal } });
      await delay(20);
      assert.equal(await text('#status'), I18n.create(other).t(errorKey, { error: literal }));
      win.webContents.send('phoneview:status', { closed: 'the connection closed', closedKey: 'the connection closed' });
      await delay(20);
      for (const language of [locale, other]) {
        win.webContents.send('ui-language', language); await delay(20);
        const current = I18n.create(language);
        assert.equal(await text('#status'), current.t('The phone stopped sharing ({reason}).', { reason: current.t('the connection closed') }));
      }
      win.webContents.send('phoneview:status', { closed: literal }); await delay(20);
      assert.equal(await text('#status'), I18n.create(other).t('The phone stopped sharing ({reason}).', { reason: literal }));
      win.webContents.send('phoneview:opts', { controls: 'none' });
      win.webContents.send('ui-language', locale); await delay(20);
      win.webContents.send('phoneview:opts', { controls: 'side' }); await delay(20);
      await checkMarkers(locale);
      await read(`Array.from(document.querySelectorAll('[data-i18n-title]')).find(el => el.dataset.i18nTitle.startsWith('Back')).click()`);
      await delay(20);
      assert.deepEqual(controls.at(-1), { t: 'nav', key: 'back' }, 'translated phone control retains command');
      win.webContents.send('ui-language', other); await delay(20);
      win.webContents.send('phoneview:status', { ready: true });
      await delay(40);
      assert.equal(await text('#status'), I18n.create(other).t('Waiting for the picture…'));
    }
    if (c.file === 'windows/monitor.html') {
      assert.ok((await text('#stats')).includes('literal-decoder'), 'stats retain cached decoder information');
      const drop = { peerName: literal, last: { name: literal, ok: false, messageKey: 'Not connected to {name}', messageVars: {} } };
      win.webContents.send('drop-progress', drop); await delay(20);
      assert.equal(await text('#drop-status'), literal + ': ' + I18n.create(other).t(drop.last.messageKey, { name: literal }));
      win.webContents.send('ui-language', locale); await delay(20);
      assert.equal(await text('#drop-status'), literal + ': ' + t(drop.last.messageKey, { name: literal }));
      win.webContents.send('ui-language', other); await delay(20);
      drop.last.itemCount = 2;
      win.webContents.send('drop-progress', drop); await delay(20);
      for (const language of [locale, other]) {
        win.webContents.send('ui-language', language); await delay(20);
        const current = I18n.create(language);
        assert.equal(await text('#drop-status'), current.t('{count} items', { count: 2 }) + ': ' + current.t(drop.last.messageKey, { name: literal }));
      }
      win.webContents.send('rtc', { t: 'stream.stop' });
      await delay(40);
      assert.equal(await text('#overlay'), I18n.create(other).t('The other computer stopped sharing')); // no stream name sent here (#81: not "Mac")
    }
    if (c.file === 'windows/appview.html' || c.file === 'mac/pcview.html') {
      const fallback = c.file.includes('appview') ? 'App' : 'PC app';
      for (const titleMessage of [{ t: 'title', title: literal, titleKey: fallback }, { t: 'title', title: literal }]) {
        win.webContents.send(c.channel, titleMessage); await delay(20);
        for (const language of [locale, other]) {
          win.webContents.send('ui-language', language); await delay(20);
          assert.equal(await read('document.title'), titleMessage.titleKey ? I18n.create(language).t(fallback) : literal, 'updated native title binding');
        }
      }
      win.webContents.send(c.channel, { t: 'stop', why: literal });
      await delay(40);
      assert.equal(await text('#overlay'), literal, 'unstructured remote reason is literal');
    }
    if (c.offer) {
      await read(`window.__testOfferError = ${JSON.stringify(literal)}`);
      win.webContents.send(c.channel, c.offer);
      await delay(60);
      assert.ok((await text(c.status)).includes(literal), 'native diagnostics preserved inside localized failure');
      if (other === 'zh-CN') assert.match(await text(c.status), /[\u3400-\u9fff]/);
    }
    if (c.file.includes('camera-view')) {
      const messages = { starting: 'Asking {name} for its camera…', refused: '{name} doesn’t share its camera: turn on Camera › “Let this computer see the camera” there.', failed: '{name}’s camera didn’t start: {error}', ended: '{name} stopped its camera.' };
      for (const [status, key] of Object.entries(messages)) {
        win.webContents.send('cam:in', { t: 'status', status, name: literal, error: literal }); await delay(20);
        assert.equal(await text('#status'), I18n.create(other).t(key, { name: literal, error: literal }));
      }
      await read('document.querySelector("#again").click()'); await delay(20);
      assert.deepEqual(controls.at(-1), { t: 'again' }, 'translated retry retains command');
    }
    if (process.env.TWINDESK_I18N_SCREENSHOTS) {
      fs.mkdirSync(process.env.TWINDESK_I18N_SCREENSHOTS, { recursive: true });
      await delay(100);
      fs.writeFileSync(path.join(process.env.TWINDESK_I18N_SCREENSHOTS, c.file.replace(/[\\/]/g, '-') + '-' + other + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors.filter((message) => !/offer failed/.test(message)), [], 'no player JavaScript errors');
  } catch (error) {
    error.message = c.file + ' (' + locale + '): ' + error.message;
    throw error;
  } finally { ipcMain.removeListener(controlChannel, capture); if (!win.isDestroyed()) win.destroy(); }
}

async function fallbackTitles() {
  const configurations = [
    { file: 'windows/appview.html', preload: 'windows/preload-appview.js', key: 'App', query: { titleKey: 'App' } },
    { file: 'mac/pcview.html', preload: 'mac/preload-pcview.js', key: 'PC', query: {} },
    { file: 'mac/pcview.html', preload: 'mac/preload-pcview.js', key: 'PC app', query: { titleKey: 'PC app' } },
    { file: 'shared/camera-view.html', preload: 'shared/preload-camera.js', key: 'Camera', query: {} },
    { file: 'windows/phoneview.html', preload: 'windows/preload-phoneview.js', key: '{name} Camera', query: { kind: 'camera', titleKey: '{name} Camera', titleName: literal } },
    { file: 'mac/phoneview.html', preload: 'mac/preload-phoneview.js', key: 'Phone sound', query: { kind: 'audio', titleKey: 'Phone sound' } },
  ];
  for (const c of configurations) {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, c.preload), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      // No language query: shared pages used by Linux keep their original English default.
      await win.loadFile(path.join(ROOT, c.file), { query: c.query });
      for (const language of ['en', 'zh-CN']) {
        if (language !== 'en') win.webContents.send('ui-language', language);
        await delay(30);
        assert.equal(await win.webContents.executeJavaScript('document.title'), I18n.create(language).t(c.key, { name: literal }), c.file + ' fallback title');
      }
      if (c.file.includes('camera-view')) {
        win.webContents.send('cam:in', { t: 'status', status: 'failed' }); await delay(30);
        const t = I18n.create('zh-CN').t;
        assert.equal(await win.webContents.executeJavaScript('document.querySelector("#status").textContent'), t('{name}’s camera didn’t start: {error}', { name: t('the other computer'), error: t('unknown') }));
      }
    } finally { win.destroy(); }
  }
}

app.whenReady().then(async () => {
  for (const c of cases) for (const locale of ['zh-CN', 'en']) await run(c, locale);
  await fallbackTitles();
  clearTimeout(watchdog);
  console.log('i18n-player-window: six sandboxed players, both languages, live updates, literal data and retained media sessions passed');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
