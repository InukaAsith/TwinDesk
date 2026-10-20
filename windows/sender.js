// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every `rtc2` video session this PC sends (its screen: one per app window)
// runs in one hidden window (sender.html). Session numbers come from one counter, since the Mac
// routes `rtc2.ice` / `rtc2.stop` by session. Answers and candidates from the Mac are routed here.
// Events: 'state' (session, {status, error}), 'stats' (session, stats).
const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;

class Sender extends EventEmitter {
  // base: the first session number minus one; a sender on a link of its own starts high so its numbers
  // never meet those of the selected-device sender on the same link (the Mac routes by session).
  constructor(link, base = 0) {
    super();
    this.link = link;
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.counter = base;
    this.live = new Set(); // sessions started and not stopped
    this.windows = new Set(); // the live sessions that are app windows (tagged win: 'send')

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
      if (this._fromWin(e) && s && this.live.has(s.session)) this.emit('stats', s.session, s);
    });
    ipcMain.on('sender-ready', (e) => {
      if (!this._fromWin(e)) return;
      this.ready = true;
      for (const m of this.queue.splice(0)) this.win.webContents.send('sender', m);
    });
  }

  // opts: {sourceId, width, height, follow?, mbps, fps?, audio?, offer: {kind, wid?}} → session number
  start(opts) {
    const session = ++this.counter;
    this.live.add(session);
    if (opts.offer && opts.offer.kind === 'window') this.windows.add(session);
    this._toWin({ ...opts, ice: this._ice(), t: 'start', session });
    return session;
  }

  // A phone on the USB cable: WebRTC through the relay (wired.js), else null.
  _ice() {
    const c = this.link.hosting && this.link.server && this.link.server.current;
    return (c && c.ice) || null;
  }

  stop(session, tellMac = true) {
    if (!this.live.delete(session)) return;
    const win = this.windows.delete(session);
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
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-sender.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.loadFile(path.join(__dirname, 'sender.html'));
    this.win.on('closed', () => { this.win = null; this.ready = false; });
  }
}

module.exports = Sender;
