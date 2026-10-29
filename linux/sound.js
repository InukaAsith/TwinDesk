// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio both ways (copy of windows/sound.js): its own peer
// connections in a hidden window, independent of the screen. Other → here: we answer
// `audio.offer {dir:'m2w'}` while "Play <name>'s sound" is on (our `audio.policy`). Here → other: we
// offer `dir:'w2m'` while "Send this computer's sound" is on and the other side's `audio.policy`
// accepts; capture = the PulseAudio/PipeWire loopback source (loopback.js).
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const P = require('../shared/protocol.js');
const loopback = require('./loopback');

const T = P.T;

class Sound {
  // opts: link, settings (shared), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.win = null;
    this.ready = false;
    this.queue = [];          // messages for the window until it is ready
    this.macAccepts = false;  // the Mac's audio.policy (it plays our sound)
    this.sending = null;      // {session, muteLocal} while our sender runs
    this.session = 0;
    this.status = { receiving: false, sending: false, error: '' };

    const link = this.link;
    link.on('welcome', () => { this.macAccepts = false; this.apply(); });
    link.on('closed', () => { this.macAccepts = false; this._stopSend(false); this._toWin({ t: 'stop-all' }); });
    link.on(T.AUDIO_POLICY, (m) => {
      const accept = m.accept === true;
      if (accept === this.macAccepts) return; // apply() answers with our policy: only on a change, or the two sides echo forever
      this.macAccepts = accept;
      this.apply();
    });
    link.on(T.AUDIO_OFFER, (m) => {
      if (m.dir === 'm2w' && this.cfg.receive && typeof m.sdp === 'string') this._toWin({ ...m, ice: this._ice() });
    });
    link.on(T.AUDIO_ANSWER, (m) => { if (m.dir === 'w2m' && this.sending && m.session === this.sending.session) this._toWin(m); });
    link.on(T.AUDIO_ICE, (m) => this._toWin(m));
    link.on(T.AUDIO_STOP, (m) => { if (m.dir === 'm2w') this._toWin(m); });

    ipcMain.on('sound-out', (e, m) => {
      if (!this.win || e.sender !== this.win.webContents || !m) return;
      if ([T.AUDIO_OFFER, T.AUDIO_ANSWER, T.AUDIO_ICE].includes(m.t)) this.link.send(m);
    });
    ipcMain.on('sound-state', (e, s) => {
      if (!this.win || e.sender !== this.win.webContents || !s) return;
      Object.assign(this.status, { receiving: !!s.receiving, sending: !!s.sending, error: String(s.error || '') });
      this.onChange();
    });
    ipcMain.on('sound-ready', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.ready = true;
      this._toWin({ t: 'volume', volume: this.cfg.volume });
      for (const m of this.queue.splice(0)) this.win.webContents.send('sound', m);
    });
  }

  get cfg() {
    return this.settings.audio;
  }

  // After welcome, a policy from the Mac, or a settings change.
  apply() {
    const connected = this.link.status.state === 'connected';
    if (connected) this.link.send({ t: T.AUDIO_POLICY, accept: !!this.cfg.receive });
    if (!this.cfg.receive) this._toWin({ t: T.AUDIO_STOP, dir: 'm2w' });
    this._toWin({ t: 'volume', volume: this.cfg.volume });
    const want = connected && this.cfg.send && this.macAccepts;
    if (want && !this.sending) {
      const me = (this.sending = { session: ++this.session, loop: false });
      loopback.acquire().then((label) => {
        if (this.sending !== me) return loopback.release();
        me.loop = true;
        this._toWin({ t: 'start-send', session: me.session, label, ice: this._ice() });
      }, (e) => {
        if (this.sending !== me) return;
        this.status.error = 'Sending this computer’s sound: ' + e.message;
        this.onChange();
      });
    } else if (!want && this.sending) this._stopSend(true);
    this.onChange();
  }

  _stopSend(tellMac) {
    if (!this.sending) return;
    if (this.sending.loop) loopback.release();
    this.sending = null;
    this._toWin({ t: 'stop-send' });
    if (tellMac) this.link.send({ t: T.AUDIO_STOP, dir: 'w2m' });
  }

  // A phone on the USB cable: WebRTC through the relay (wired.js), else null.
  _ice() {
    const c = this.link.hosting && this.link.server && this.link.server.current;
    return (c && c.ice) || null;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) {
      if (m.t === 'stop-all' || m.t === 'volume' || m.t === T.AUDIO_STOP || m.t === 'stop-send') return; // nothing to stop
      this._create();
    }
    if (this.ready) this.win.webContents.send('sound', m);
    else this.queue.push(m);
  }

  _create() {
    this.ready = false;
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-sound.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win.loadFile(path.join(__dirname, 'sound.html'));
    this.win.on('closed', () => { this.win = null; this.ready = false; });
  }

  view() {
    return { ...this.status, macAccepts: this.macAccepts };
  }
}

module.exports = Sound;
