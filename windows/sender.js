// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every `rtc2` video session this PC sends (its screen: one per app window)
// runs in one hidden window (sender.html). Session numbers come from one counter, since the Mac
// routes `rtc2.ice` / `rtc2.stop` by session. Answers and candidates from the Mac are routed here.
// Events: 'state' (session, {status, error}), 'stats' (session, stats).
const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const P = require('../shared/protocol.js');
const ScreenCodec = require('../shared/screencodec.js');
const NativeScreen = require('./native-screen');
const { interfaces, isIPv4, sameNet } = require('./discovery');

const T = P.T;

class Sender extends EventEmitter {
  constructor(link) {
    super();
    this.link = link;
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.counter = 0;
    this.live = new Set(); // sessions started and not stopped
    this.windows = new Set(); // the live sessions that are app windows (tagged win: 'send')
    this.options = new Map();
    this.native = new Map();
    this.nativeFailed = false;

    // `win: 'send'` is the other computer's own window sender talking to our viewer (peerapps.js).
    const ours = (m) => this.live.has(m.session) && m.win !== 'send';
    link.on(T.RTC2_ANSWER, (m) => ours(m) && typeof m.sdp === 'string' && this._toWin(m));
    link.on(T.RTC2_ICE, (m) => ours(m) && this._toWin(m));
    link.on('closed', () => { for (const s of [...this.live]) this.stop(s, false); });

    ipcMain.on('sender-out', (e, m) => {
      if (!this._fromWin(e) || !m || !this.live.has(m.session)) return;
      if (m.t === T.RTC2_OFFER || m.t === T.RTC2_ICE) this.link.send(this.windows.has(m.session) ? { ...m, win: 'send' } : m);
    });
    ipcMain.on('sender-state', (e, s) => {
      if (this._fromWin(e) && s && this.live.has(s.session)) this.emit('state', s.session, { status: String(s.status || ''), error: String(s.error || '') });
    });
    ipcMain.on('sender-stats', (e, s) => {
      if (!this._fromWin(e) || !s || !this.live.has(s.session)) return;
      // The network the picture goes over, once per session and when it changes (a cable and Wi-Fi).
      const path = typeof s.path === 'string' ? s.path.slice(0, 120) : '';
      if (path && (this.paths || (this.paths = new Map())).get(s.session) !== path) {
        this.paths.set(s.session, path);
        console.log('[sender] session ' + s.session + ' video over ' + path);
      }
      this.emit('stats', s.session, s);
    });
    ipcMain.on('sender-log', (e, text) => { if (this._fromWin(e)) console.warn('[sender] ' + String(text).slice(0, 300)); });
    ipcMain.on('sender-ready', (e) => {
      if (!this._fromWin(e)) return;
      this.ready = true;
      for (const m of this.queue.splice(0)) this.win.webContents.send('sender', m);
    });
    ipcMain.on('sender-native-start', async (e, session) => {
      if (!this._fromWin(e)) return;
      if (!this.live.has(session)) return e.sender.send('sender-native-ready', { session, available: false });
      const opts = this.options.get(session);
      if (this.nativeFailed && this.nativeFailed !== NativeScreen.mode()) { this.nativeFailed = false; this.nativeStops = 0; } // another Capture chosen: try it
      let size = null, error = '', available = !this.nativeFailed && NativeScreen.available() && !!opts.captureRect && !this.windows.has(session);
      if (available) {
        const capture = new NativeScreen(this.win.webContents.mainFrame, session, error => {
          // A WGC stop mid-share retries WGC on the next share; after 3, Chromium until the app restarts or Capture changes.
          this.nativeStops = (this.nativeStops || 0) + 1;
          if (this.nativeStops >= 3) this.nativeFailed = NativeScreen.mode();
          console.warn('[sender] Native screen capture stopped:', error.message);
          if (this.live.has(session)) this._toWin({ t: 'native-error', session, error: error.message });
        });
        if (this.native.has(session)) this.native.get(session).stop();
        this.native.set(session, capture);
        try { size = await capture.start(opts.captureRect, opts.fps || 60); }
        catch (e) {
          // A startup failure is about this monitor (its bounds, a cancel): the next share tries WGC again.
          error = e.message; available = false;
          if (this.native.get(session) === capture) this.native.delete(session);
          console.warn('[sender] Native screen capture unavailable:', error);
        }
      }
      available = available && this.live.has(session);
      if (this.live.has(session)) console.log('[sender-capture] ' + JSON.stringify({
        session, backend: available ? (size && size.backend) || 'wgc' : 'chromium',
        width: available && size ? size.width : opts.captureWidth, height: available && size ? size.height : opts.captureHeight,
        targetWidth: opts.width, targetHeight: opts.height, fps: opts.fps || 60, ...(error ? { error } : {}),
      }));
      if (this._fromWin(e))
        e.sender.send('sender-native-ready', { session, available, error, ...(available && size ? size : {}) });
    });
  }

  // opts: {sourceId, width, height, follow?, mbps, fps?, audio?, offer: {kind, wid?}} → session number
  start(opts) {
    const session = ++this.counter;
    this.live.add(session);
    this.options.set(session, opts);
    if (opts.offer && opts.offer.kind === 'window') this.windows.add(session);
    // codec: Share screen › Encoder (settings.pcScreen.codec, shared/screencodec.js), for every session.
    this._toWin({ ...opts, codec: ScreenCodec.mode(this.codec ? this.codec() : undefined), ice: this._ice(), net: this._net(), t: 'start', session });
    return session;
  }

  // The network the session is on, for the picture to stay on (sender-renderer.js): our adapter there
  // {address, netmask}, or null (Bluetooth, or a peer reached through a router or VPN: any path).
  // Without it WebRTC takes whichever network answers first, and moved between two (a cable and a
  // Remote Desktop adapter) mid-share: blocks of the picture a moment behind, the bitrate up and down.
  _net() {
    const c = this.link.current;
    const peer = c && c.transport !== 'ble' ? String(c.address || '').replace(/^::ffff:/, '') : '';
    const nic = isIPv4(peer) && interfaces().find((i) => sameNet(i, peer));
    return nic ? { address: nic.address, netmask: nic.netmask } : null;
  }

  // A phone on the USB cable: WebRTC through the relay (wired.js), else null.
  _ice() {
    const c = this.link.hosting && this.link.server && this.link.server.current;
    return (c && c.ice) || null;
  }

  stop(session, tellMac = true) {
    if (!this.live.delete(session)) return;
    this.options.delete(session);
    if (this.paths) this.paths.delete(session);
    const native = this.native.get(session);
    if (native) { this.native.delete(session); native.stop(); }
    const win = this.windows.delete(session);
    this.queue = this.queue.filter((m) => m.session !== session);
    this._toWin({ t: 'stop', session });
    if (tellMac && this.link.status.state === 'connected') this.link.send(win ? { t: T.RTC2_STOP, session, win: 'send' } : { t: T.RTC2_STOP, session });
  }

  _fromWin(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) {
      if (m.t !== 'start') return; // nothing to stop
      this._create();
    }
    if (this.ready) this.win.webContents.send('sender', m);
    else this.queue.push(m);
  }

  _create() {
    this.ready = false;
    this.queue = [];
    const win = this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-sender.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Our capture's frames come in as shared textures, whose receiving API runs in the preload, and
        // only unsandboxed. The page itself is local (sender.html, script-src 'self'), with context
        // isolation and no Node: it never sees Node or Electron.
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    const failed = (error) => {
      if (this.win !== win) return;
      this.win = null;
      this.ready = false;
      this.queue = [];
      const sessions = [...this.live];
      for (const session of sessions) this.stop(session);
      for (const session of sessions) this.emit('state', session, { status: 'failed', error });
      if (!win.isDestroyed()) win.destroy();
    };
    win.webContents.on('render-process-gone', (_e, detail) => failed('Screen capture stopped: ' + detail.reason));
    win.webContents.on('did-fail-load', (_e, _code, description, _url, mainFrame) => {
      if (mainFrame !== false) failed('Screen capture could not load: ' + description);
    });
    win.on('closed', () => failed('The screen capture window closed'));
    win.loadFile(path.join(__dirname, 'sender.html')).catch((e) => failed('Screen capture could not load: ' + e.message));
  }
}

module.exports = Sender;
