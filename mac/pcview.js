// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › PC → Mac: the PC's screen in a window on this Mac.
// We tell the PC with `screen.policy {accept, width, height}` and answer every `rtc2.offer`
// (recvonly) in a visible viewer window, tuned for the lowest latency (jitter buffer 0, input sent
// the moment it arrives). Keys are taken in main (before-input-event) so Cmd+Q/W/… reach the PC;
// mouse input comes from the viewer page. Closing the window turns the switch off.
// The window is the switch. It opens only when the person opens it (Receive tab, menu
// bar, never because the other side started sharing); while it is open and not minimized we accept
// (`screen.policy`), which is what makes the other computer send; opening it also starts the other
// side's sharing when that's allowed, and closing it stops what we started.
// Minimizing pauses the picture (accept false: the PC stops capturing); the PC's
// `screen.state` lets us start its sharing and switch Extend/Mirror from here (`screen.ctl`), from
// the Receive tab or the window's toolbar; opening the window starts it when the PC allows that.
//
// Events: 'change' — this.view changed.
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const I18n = require('../shared/i18n.js');
const { attachKeys } = require('./viewer-keys');

const T = P.T;
const POINTER = new Set([T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL]);

class PcView extends EventEmitter {
  constructor({ server, getSettings, saveSettings }) {
    super();
    Object.assign(this, { server, getSettings, saveSettings });
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.session = null; // the PC's rtc2 session we answer
    this.kind = '';
    this.status = 'off';
    this.stats = null; // {width, height, fps, mbps, decoder, codec, delayMs}
    this.keys = null;
    this.sized = false;
    this.remote = null; // the peer's screen.state {on, mode, remote, modes}
    this.startedByUs = false; // we switched the PC's sharing on (switch it off again when we close)

    server.on('client', () => {
      this.remote = null;
      this.startedByUs = false;
      this._policy();
    });
    server.on(`t:${T.SCREEN_STATE}`, (m) => {
      this.remote = { on: !!m.on, mode: String(m.mode || ''), remote: m.remote !== false, modes: Array.isArray(m.modes) ? m.modes.slice(0, 4).map(String) : [] };
      if (!this.remote.on) this.startedByUs = false;
      this._toWin({ t: 'remote', ...this.remote });
      if (this.wantStart && this.remote.remote && !this.remote.on) this.control({ share: true });
      this.wantStart = false;
      this.emit('change');
    });
    server.on('closed', () => {
      if (!server.current) this._end('');
    });
    server.on(`t:${T.RTC2_OFFER}`, (m) => this._onOffer(m));
    // App-window sessions carry `win` (pcapps.js / appsend.js): never the screen's.
    server.on(`t:${T.RTC2_ICE}`, (m) => !m.win && m.session === this.session && this._toWin({ ...m }));
    server.on(`t:${T.RTC2_STOP}`, (m) => !m.win && (m.session === undefined || m.session === this.session) && this._end(`${this.server.current ? this.server.current.name : 'It'} stopped sharing`, this.server.current ? '{name} stopped sharing' : 'The other computer stopped sharing', this.server.current ? { name: this.server.current.name } : undefined));
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => this._policy());

    ipcMain.on('pcview:out', (e, m) => {
      if (!this._fromWin(e) || !m || !this.server.current) return;
      if ((m.t === T.RTC2_ANSWER || m.t === T.RTC2_ICE) && m.session === this.session) this.server.sendToClient(m);
      else if (POINTER.has(m.t) && this.cfg.input && (m.t === T.IN_UP || this.win.isFocused())) this.server.sendToClient(m);
    });
    ipcMain.on('pcview:state', (e, s) => {
      if (!this._fromWin(e) || !s || s.session !== this.session) return;
      if (s.status) this.status = String(s.status);
      if (s.stats) this.stats = s.stats;
      if (s.size) this._fit(s.size.width, s.size.height);
      this.emit('change');
    });
    ipcMain.on('pcview:ctl', (e, m) => {
      if (!this._fromWin(e) || !m) return;
      if (m.framegen !== undefined) {
        this.cfg.framegen = !!m.framegen;
        this.saveSettings();
        this._toWin({ t: 'pacing', pacing: this.getSettings().sharing.pace || 'fast', framegen: !!this.cfg.framegen });
        this.emit('change');
      }
      if (m.fullScreen && this.win) this.win.setFullScreen(!this.win.isFullScreen());
      if (m.share !== undefined || m.mode) this.control({ share: m.share, mode: m.mode });
      if (m.share === false) this.close(); // Stop on the bar: nothing left to watch
    });
    ipcMain.on('pcview:ready', (e) => {
      if (!this._fromWin(e)) return;
      this.ready = true;
      for (const m of this.queue.splice(0)) this.win.webContents.send('pcview', m);
    });
  }

  get cfg() {
    return this.getSettings().receive;
  }

  // The size we'd like for Extend on the PC: this Mac's main screen in points (text the same size
  // as here, and a light stream for the lowest latency).
  _policy() {
    const d = screen.getPrimaryDisplay();
    const even = (v) => Math.round(v / 2) * 2;
    const watching = this.isOpen && !this.win.isMinimized();
    this.server.sendToClient({ t: T.SCREEN_POLICY, accept: watching, width: even(d.size.width), height: even(d.size.height) });
  }

  // Start/stop the PC's sharing or switch its mode (it obeys when its "remote" setting allows).
  control({ share, mode }) {
    if (!this.server.current) return;
    const m = { t: T.SCREEN_CTL };
    if (typeof share === 'boolean') m.share = share;
    if (mode === 'extend' || mode === 'mirror') m.mode = mode;
    if (m.share === undefined && !m.mode) return;
    if (m.share === true && !(this.remote && this.remote.on)) this.startedByUs = true;
    if (m.share === true && !this.isOpen) return this.show(); // starting it means watching it
    this.server.sendToClient(m);
  }

  _onOffer(m) {
    // Only into an open window (an older app may offer before anyone opened it: ignored).
    if (!this.isOpen || typeof m.sdp !== 'string' || !/^screen/.test(String(m.kind))) return;
    this.session = m.session;
    this.kind = m.kind;
    this.status = 'connecting';
    this.stats = null;
    this.sized = false;
    clearTimeout(this.closeTimer);
    this._open();
    this._toWin({ t: 'offer', session: m.session, sdp: m.sdp, audio: m.kind === 'screen+audio', volume: this.getSettings().audio.volume, input: !!this.cfg.input,
      pacing: this.getSettings().sharing.pace || 'fast', framegen: !!this.cfg.framegen });
    if (this.remote) this._toWin({ t: 'remote', ...this.remote });
    this.emit('change');
  }

  // Session over (the other side stopped or went away): the window stays (only the person closes
  // it) and says so; it fills in again when a new offer comes.
  _end(why, whyKey, whyVars) {
    this._releaseKeys();
    this.session = null;
    this.status = why ? 'stopped' : 'off';
    this.stats = null;
    this._toWin({ t: 'stop', why: why || 'Waiting for the other computer…', whyKey: whyKey || (!why ? 'Waiting for the other computer…' : undefined), whyVars });
    this.emit('change');
  }

  get isOpen() {
    return !!(this.win && !this.win.isDestroyed());
  }

  // Close the window (Receive tab switch, menu bar): the same as the person closing it.
  close() {
    if (this.isOpen) this.win.close();
  }

  _i18n() {
    const settings = this.getSettings();
    return I18n.create(I18n.resolveLanguage(settings.ui && settings.ui.language, app.getLocale()));
  }

  _open() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      return;
    }
    const name = this.server.current && this.server.current.name;
    const pcName = name || this._i18n().t('PC');
    const wa = screen.getPrimaryDisplay().workArea;
    this.ready = false;
    this.queue = [];
    this.sized = false;
    this.closingByUs = false;
    const w = Math.round(wa.width * 0.8), h = Math.round((w * 9) / 16);
    this.win = new BrowserWindow({
      title: pcName,
      width: w,
      height: Math.min(h, wa.height),
      x: wa.x + Math.round((wa.width - w) / 2),
      y: wa.y + Math.round((wa.height - Math.min(h, wa.height)) / 2),
      backgroundColor: '#000000',
      useContentSize: true,
      fullscreenable: true,
      fullscreen: !!this.cfg.fullScreen,
      webPreferences: {
        preload: path.join(__dirname, 'preload-pcview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const win = this.win;
    win.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[pcview] ${e.message}`));
    this.keys = attachKeys(win, {
      send: (m) => this.server.current && this.server.sendToClient(m),
      enabled: () => !!(this.cfg.input && this.session && this.server.current),
      // Ctrl-⌘-F: full screen here.
      local: (input) => {
        if (!(input.code === 'KeyF' && input.meta && input.control)) return false;
        if (input.type === 'keyDown' && !input.isAutoRepeat) win.setFullScreen(!win.isFullScreen());
        return true;
      },
    });
    win.on('minimize', () => this._policy()); // paused: the PC stops capturing
    win.on('restore', () => this._policy());
    win.on('blur', () => {
      this._releaseKeys();
      this._toWin({ t: 'blur' });
    });
    win.on('closed', () => {
      this._releaseKeys();
      if (this.win === win) this.win = null;
      this.ready = false;
      if (!this.closingByUs) {
        // Closed: stop watching, and stop the other side's sharing if we started it.
        this._policy();
        if (this.startedByUs) this.control({ share: false }); // we started it, so we stop it
        this.startedByUs = false;
        this.session = null;
        this.status = 'off';
        this.emit('change');
      }
    });
    win.loadFile(path.join(__dirname, 'pcview.html'), { query: { language: this._i18n().locale, title: pcName, titleKey: name ? '' : 'PC' } });
  }

  // First picture (or a new size): fit the window to the PC's aspect ratio, ≤ 80 % of the screen.
  _fit(vw, vh) {
    if (!this.win || this.win.isDestroyed() || !vw || !vh) return;
    this.win.setAspectRatio(vw / vh);
    if (this.sized || this.win.isFullScreen()) return;
    this.sized = true;
    const wa = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const scale = Math.min((wa.width * 0.9) / vw, (wa.height * 0.9) / vh, 1);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    this.win.setContentSize(w, h);
    this.win.center();
  }

  _releaseKeys() {
    if (this.keys) this.keys.release();
  }

  _fromWin(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.ready) this.win.webContents.send('pcview', m);
    else this.queue.push(m);
  }

  // Is the PC window focused? (kvm.js doesn't cross the edge while it is.)
  get focused() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isFocused());
  }

  // After the PC → Mac tab changed.
  applySettings() {
    this._policy();
    if (!this.cfg.input) this._releaseKeys();
    this._toWin({ t: 'input', on: !!this.cfg.input });
    this._toWin({ t: 'volume', volume: this.getSettings().audio.volume });
    this._toWin({ t: 'pacing', pacing: this.getSettings().sharing.pace || 'fast', framegen: !!this.cfg.framegen });
    if (this.win && !this.win.isDestroyed() && this.win.isFullScreen() !== !!this.cfg.fullScreen) this.win.setFullScreen(!!this.cfg.fullScreen);
  }

  // "Open the PC's screen" (PC → Mac tab): turn receiving on and open the window, also before the
  // PC shares — it then shows what to do on the PC and fills in when the offer comes.
  show() {
    const fresh = !this.isOpen;
    this._open();
    this._policy(); // watching: the other side may send now
    // Nothing shared yet: start it from here (no need to touch the PC) when it allows that.
    const r = this.remote;
    if (r && !r.on && r.remote) this.control({ share: true });
    else if (!r) this.wantStart = true; // an older PC app or state not here yet
    if (fresh && !this.session) {
      const pc = this.server.current ? this.server.current.name : 'the other computer';
      const why = !this.server.current ? 'Waiting for the other computer…'
        : r && !r.on && r.remote ? `Starting ${pc}’s screen…` : `Choose what to share in TwinDesk on ${pc}`;
      this._toWin({ t: 'stop', why });
      if (this.remote) this._toWin({ t: 'remote', ...this.remote });
    }
    this.win.focus();
    this.emit('change');
  }

  shutdown() {
    this._releaseKeys();
    this.closingByUs = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }

  get view() {
    return { session: this.session, kind: this.kind, status: this.status, stats: this.stats, open: !!(this.win && !this.win.isDestroyed()), remote: this.remote };
  }
}

module.exports = { PcView };
