// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screen sharing: stream state, the Monitor 2 window, and relaying stream.*/rtc.* between the
// link (main process) and the Monitor 2 renderer, which owns the RTCPeerConnection.
// We tell the other computer whether anyone watches (`screen.policy {accept}`: Monitor 2
// shown and not minimized, or a Mac-app window open); it captures only while that is true. Its
// `screen.state` says whether its sharing is on. When it lets us (`remote`), opening Monitor 2 starts
// its sharing and closing it stops it again (`screen.ctl`); the Receive tab switches Extend/Mirror.
// Monitor 2 never opens by itself (no "Open automatically"): only the Receive tab, the
// tray or a Mac-app window open it, and nothing is sent before that.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;
const FROM_RENDERER = new Set([T.RTC_ANSWER, T.RTC_ICE, T.APP_FOCUS, T.APP_CLOSE]);
const INPUT = new Set([T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL, T.IN_KEY_DOWN, T.IN_KEY_UP]);

class Screen {
  // opts: link, clip, settings (shared object, .windows.monitor bounds), saveSettings(), onChange(),
  // isQuitting(), inputAllowed() (false while KVM drives or is driven)
  constructor(opts) {
    Object.assign(this, opts);
    this.state = { state: 'off', name: '', width: 0, height: 0 };
    this.win = null;
    this.ready = false; // renderer loaded and listening
    this.replay = []; // messages of the current session, for a renderer that (re)loads
    this.test = false;
    this.macInput = true; // the Mac's "Receive input" switch (stream.input); assumed on until told
    this.sentAccept = null; // the last screen.policy accept we sent on this connection
    this.remote = null; // the peer's screen.state {on, mode, remote, modes}; null = not told (older app)
    this.startedByUs = false; // we switched the peer's sharing on, so closing Monitor 2 switches it off
    this.wantStart = false; // Monitor 2 opened before the peer's screen.state arrived

    const link = this.link;
    link.on(T.STREAM_INFO, (m) => this._onInfo(m));
    link.on(T.RTC_OFFER, (m) => typeof m.sdp === 'string' && this._relay(m));
    link.on(T.RTC_ICE, (m) => this._relay(m));
    link.on(T.STREAM_STOP, () => this._stop());
    link.on(T.STREAM_INPUT, (m) => this._setMacInput(m.on !== false));
    link.on(T.SCREEN_STATE, (m) => this._onState(m));
    link.on('welcome', () => {
      this.sentAccept = null;
      this.remote = null;
      this.startedByUs = false;
      this.wantStart = !this.test && !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); // reconnected while watching
      this._pushRemote();
      this.policy();
    });
    link.on('closed', () => {
      this.sentAccept = null;
      this.remote = null;
      this.startedByUs = false;
      this._pushRemote();
      this._stop();
      this._setMacInput(true); // the Mac re-sends it after welcome
    });

    ipcMain.on('rtc', (e, m) => {
      if (!this.win || e.sender !== this.win.webContents || this.test) return;
      if (!m) return;
      if (FROM_RENDERER.has(m.t)) this.link.send(m);
      else if (INPUT.has(m.t) && this.state.state === 'on' && this.macInput && this.inputAllowed()) this.link.send(m);
    });
    ipcMain.on('drop', (e, d) => {
      if (!this.win || e.sender !== this.win.webContents || !this.fileDrop || !d || !Array.isArray(d.paths)) return;
      const n = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
      this.fileDrop.drop(d.paths.filter((p) => typeof p === 'string'), n(d.x), n(d.y));
    });
    // Details card: the renderer's once-a-second getStats summary.
    ipcMain.on('monitor-stats', (e, st) => {
      if (!this.win || e.sender !== this.win.webContents || !st || typeof st !== 'object' || this.state.state !== 'on') return;
      this.state = { ...this.state, stats: st };
      this.onChange();
    });
    // The window's toolbar: the peer's sharing (as the Receive tab), frame generation, full screen.
    ipcMain.on('monitor-ctl', (e, m) => {
      if (!this.win || e.sender !== this.win.webContents || !m || typeof m !== 'object') return;
      if (typeof m.framegen === 'boolean') {
        this.settings.monitor.framegen = m.framegen;
        this.saveSettings();
        this._pushAudio();
        this.onChange();
      }
      if (m.fullScreen) this.win.setFullScreen(!this.win.isFullScreen());
      if (typeof m.share === 'boolean' || m.mode) this.control({ share: m.share, mode: m.mode });
      if (m.share === false) this.close(); // Stop on the bar: nothing left to watch
    });
    ipcMain.on('monitor-ready', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.ready = true;
      this._pushInput();
      this._pushAudio();
      this._pushRemote();
      if (this.apps) this.apps.resend();
      for (const m of this.replay) this._toRenderer(m);
    });
  }

  open(test) {
    this.test = !!test;
    if (!this.win || this.win.isDestroyed()) this._create();
    else if (!this.win.isVisible()) this.win.show();
    else if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
    // Nothing shared over there: start it from here when it lets us (no need to touch it).
    const r = this.remote;
    if (this.test || this.link.status.state !== 'connected') return;
    if (r && !r.on && r.remote) this.control({ share: true });
    else if (!r) this.wantStart = true; // its state isn't here yet (or an older app)
  }


  // Tray "Receive Screen" off: like the window's close button (stops sharing we started there).
  close() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.close();
  }

  // screen.ctl: start/stop the peer's sharing or switch its mode (it obeys when it lets us).
  control({ share, mode }) {
    if (this.link.status.state !== 'connected') return;
    const m = { t: T.SCREEN_CTL };
    if (typeof share === 'boolean') m.share = share;
    if (mode === 'extend' || mode === 'mirror') m.mode = mode;
    if (m.share === undefined && !m.mode) return;
    if (m.share === true && !(this.remote && this.remote.on)) this.startedByUs = true;
    if (m.share === false) this.startedByUs = false;
    this.link.send(m);
  }

  _pushRemote() {
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send('remote', this.remote);
  }

  // Someone watches: Monitor 2 is on screen, or a Mac-app window (they show the same stream) is open
  // or opening. The dev test pattern needs no picture.
  watching() {
    const w = this.win;
    const mon = !this.test && !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized());
    return mon || !!(this.apps && (this.apps.windows.length || this.apps.opening.size));
  }

  // screen.policy to the peer whenever `watching` changes (and after welcome).
  policy() {
    if (this.link.status.state !== 'connected') return;
    const accept = this.watching();
    if (accept === this.sentAccept) return;
    this.sentAccept = accept;
    this.link.send({ t: T.SCREEN_POLICY, accept });
    this.onChange();
  }

  _onState(m) {
    const modes = Array.isArray(m.modes) ? m.modes.slice(0, 4).map(String) : [];
    this.remote = { on: m.on === true, mode: String(m.mode || ''), remote: m.remote !== false, modes };
    if (!this.remote.on) this.startedByUs = false;
    if (this.wantStart && this.remote.remote && !this.remote.on) this.control({ share: true });
    this.wantStart = false;
    this._pushRemote();
    this.onChange();
  }

  _onInfo(m) {
    const width = Number(m.width) || 0;
    const height = Number(m.height) || 0;
    // audio: the Mac's "Share sound with the screen" — only then is there a sound track.
    this.state = { state: 'on', name: typeof m.name === 'string' ? m.name : 'Shared screen', width, height, audio: m.audio === true };
    this.replay = []; // a fresh offer follows every stream.info
    this._relay({ t: T.STREAM_INFO, name: this.state.name, width, height, audio: this.state.audio });
    this._title();
    if (this.win && !this.win.isDestroyed()) this.win.streamSize = { width, height };
    this.onChange();
  }

  // File drop progress for the status line in Monitor 2.
  sendDropProgress(v) {
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send('drop-progress', v);
  }

  // Screen sound: played only when the Mac shares it with the screen; local volume.
  // Pacing travels with it: both come from the Receive tab's settings.
  applyAudio() {
    this._pushAudio();
  }

  _pushAudio() {
    const m = this.settings.monitor;
    if (!this.ready || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('audio', { on: !m.mute, volume: m.volume });
    this.win.webContents.send('pacing', { pacing: m.pacing, framegen: m.framegen });
  }

  // Input allowed changed elsewhere (KVM mode): tell the renderer.
  refreshInput() {
    this._pushInput();
  }

  // App windows need the Monitor 2 renderer (and its stream) even if Monitor 2 itself stays hidden.
  ensureHidden() {
    if (!this.win || this.win.isDestroyed()) {
      this.startHidden = true;
      this._create();
    }
  }

  _setMacInput(on) {
    if (on === this.macInput) return;
    this.macInput = on;
    this._pushInput();
    this.onChange();
  }

  // Tell the renderer whether to capture input at all (off = no listeners work, normal cursor).
  _pushInput() {
    if (this.ready && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('input-enabled', this.test || (this.macInput && this.inputAllowed()));
    }
  }

  _stop() {
    if (this.state.state === 'off' && !this.replay.length) return;
    this.state = { state: 'off', name: '', width: 0, height: 0 };
    this.replay = [];
    this._toRenderer({ t: T.STREAM_STOP });
    this._title();
    this.onChange();
  }

  _relay(m) {
    this.replay.push(m);
    this._toRenderer(m);
  }

  _toRenderer(m) {
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send('rtc', m);
  }

  _title() {
    if (!this.win || this.win.isDestroyed()) return;
    const macName = this.link.snapshot().link.macName || 'TwinDesk';
    const s = this.state;
    this.win.setTitle(s.state === 'on'
      ? macName + ' (' + s.width + ' × ' + s.height + ')'
      : macName);
  }

  _create() {
    const b = this.settings.windows.monitor || {};
    const aspect = this.state.width && this.state.height ? this.state.width / this.state.height : 16 / 9;
    const win = new BrowserWindow({
      width: b.width || 1280,
      height: b.height || Math.round(1280 / aspect),
      x: b.x,
      y: b.y,
      minWidth: 320,
      minHeight: 200,
      backgroundColor: '#000000',
      title: 'Monitor 2',
      icon: path.join(__dirname, 'assets', 'tray@2x.png'),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-monitor.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // keep decoding while covered or in the background
        autoplayPolicy: 'no-user-gesture-required', // the Mac's sound plays without a click
      },
    });
    this.win = win;
    this.ready = false;
    win.streamSize = { width: this.state.width || 1920, height: this.state.height || 1080 };
    if (this.apps) this.apps.attach(win); // Mac app windows open from this renderer
    win.loadFile(path.join(__dirname, 'monitor.html'), { query: this.test ? { test: '1' } : {} });
    win.once('ready-to-show', () => { if (!this.startHidden) win.show(); this.startHidden = false; });
    for (const ev of ['show', 'hide', 'minimize', 'restore', 'closed']) win.on(ev, () => this.policy());
    win.on('page-title-updated', (e) => e.preventDefault());
    // Clipboard follows the focus: our text goes over on focus, the Mac's comes back on blur.
    win.on('focus', () => { if (!this.test && this.state.state === 'on') this.clip.sendIfChanged(); });
    win.on('blur', () => { if (!this.test && this.state.state === 'on') this.clip.request(); });
    win.webContents.on('before-input-event', (e, input) => {
      // F11 fullscreen and F9 stats stay local: both key down and up are kept from the page,
      // so they are never sent to the Mac.
      if (input.key !== 'F11' && input.key !== 'F9') return;
      e.preventDefault();
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
      else win.webContents.send('toggle-stats');
    });
    win.webContents.on('did-start-loading', () => { this.ready = false; });
    // Closing only hides it, so the peer connection survives and reopening is instant.
    win.on('close', (e) => {
      this._saveBounds();
      if (!this.isQuitting()) {
        e.preventDefault();
        if (win.isFullScreen()) win.setFullScreen(false);
        win.hide();
        this.wantStart = false;
        if (this.startedByUs) this.control({ share: false }); // we started it, so we stop it
      }
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    this._title();
  }

  _saveBounds() {
    const win = this.win;
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    this.settings.windows.monitor = win.getNormalBounds();
    this.saveSettings();
  }
}

module.exports = Screen;
