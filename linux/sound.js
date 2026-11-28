// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio both ways (copy of windows/sound.js): its own peer
// connections in a hidden window, independent of the screen. Other → here: we answer
// `audio.offer {dir:'m2w'}` while "Play <name>'s sound" is on (our `audio.policy`). Here → other: we
// offer `dir:'w2m'` while "Send this computer's sound" is on and the other side's `audio.policy`
// accepts; capture = the PulseAudio/PipeWire loopback source (loopback.js).
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const P = require('../shared/protocol.js');
const { Routes } = require('../shared/sound-route.js');
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
    this.meshHub = opts.meshHub || null;
    // The mixer (shared/sound-route.js): which of our speakers its sound plays on, and its speakers ours.
    this.routes = new Routes({
      send: (m) => this.link.send(m), toWin: (m) => this._toWin(m), cfg: () => this.cfg,
      peerId: () => (this.link.current && this.link.current.deviceId) || this.link.id || '',
      save: opts.save || (() => {}), onChange: () => this.onChange(), receiving: () => this.status.receiving,
    });
    this.saidSync = null; // Keep speakers in sync, as last said to it while sending
    this.lastApply = '';      // the last apply() decision logged
    link.on('welcome', () => { this._log('with', this._who()); this.macAccepts = false; this.apply(); this._syncAudioSticky(); });
    link.on('closed', (v) => { this._log('left', (v && v.name) || this._who()); this.macAccepts = false; this._stopSend(false); this._toWin({ t: 'stop-all' }); this.routes.reset(); this.saidSync = null; this._syncAudioSticky(); });
    link.on(T.AUDIO_POLICY, (m) => {
      const accept = m.accept === true;
      this._log('policy from', this._who(), 'accept', accept);
      if (accept === this.macAccepts) return; // apply() answers with our policy: only on a change, or the two sides echo forever
      this.macAccepts = accept;
      this.apply();
    });
    link.on(T.AUDIO_OFFER, (m) => {
      const take = m.dir === 'm2w' && this._on('receive') && typeof m.sdp === 'string';
      this._log('offer from', this._who(), 'dir', m.dir, 'session', m.session, take ? 'answering' : 'ignored (Play is off for it)');
      if (take) this._toWin({ ...m, ice: this._ice() });
    });
    link.on(T.AUDIO_ANSWER, (m) => {
      const take = m.dir === 'w2m' && this.sending && m.session === this.sending.session;
      this._log('answer from', this._who(), 'session', m.session, take ? '' : '(not ours: ignored)');
      if (take) this._toWin(m);
    });
    link.on(T.AUDIO_ICE, (m) => this._toWin(m));
    link.on(T.AUDIO_ROUTE, (m) => this.routes.onRoute(m)); // the sender's pick of our speakers, its sync
    link.on(T.AUDIO_OUTS, (m) => this.routes.onOuts(m)); // the receiver's speakers for our sound
    link.on(T.AUDIO_STOP, (m) => { this._log('stop from', this._who(), 'dir', m.dir); if (m.dir === 'm2w') this._toWin(m); });

    ipcMain.on('sound-out', (e, m) => {
      if (!this.win || e.sender !== this.win.webContents || !m) return;
      if ([T.AUDIO_OFFER, T.AUDIO_ANSWER, T.AUDIO_ICE].includes(m.t)) this.link.send(m);
    });
    ipcMain.on('sound-state', (e, s) => {
      if (!this.win || e.sender !== this.win.webContents || !s) return;
      const next = { receiving: !!s.receiving, sending: !!s.sending, error: String(s.error || '') };
      const started = next.receiving && !this.status.receiving;
      if (next.receiving !== this.status.receiving || next.sending !== this.status.sending || next.error !== this.status.error) {
        this._log('state with', this._who(), 'receiving', next.receiving, 'sending', next.sending, next.error ? 'error ' + next.error : '');
      }
      Object.assign(this.status, next);
      if (s.info) this.routes.onWin(s.info);
      if (started) this.routes.tell(true); // its sound plays here: our speakers to it
      this._syncAudioSticky();
      this.onChange();
    });
    ipcMain.on('sound-ready', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.ready = true;
      this._toWin({ t: 'volume', volume: this.cfg.volume });
      this.routes.push();
      for (const m of this.queue.splice(0)) this.win.webContents.send('sound', m);
    });
  }

  get cfg() {
    return this.settings.audio;
  }

  // Send / Play for the device the sound is with. In the mesh the Audio page's switches are the selected
  // device's pair; sound that stays with another device (the sticky route) goes by that device's own (#245).
  _on(key) {
    const c = this.link.current;
    const consent = this.meshHub && this.meshHub.consent; // Multi-device: this device's own pair (shared/consent.js)
    return consent && c ? !!consent.get(c.deviceId, 'audio', key === 'send' ? 'out' : 'in') : !!this.cfg[key];
  }

  // Mesh (#196): while sound plays, its route stays on that device when another one is selected. Only
  // sound that plays: an offer the device never answers must not keep the route on it.
  _syncAudioSticky() {
    if (!this.meshHub) return;
    const live = !!(this.status.sending || this.status.receiving);
    const c = this.link.current;
    this.meshHub.setAudioSticky('sound', live && c ? c.deviceId : null);
  }

  // After welcome, a policy from the Mac, or a settings change.
  apply() {
    const connected = this.link.status.state === 'connected';
    const receive = this._on('receive');
    if (connected) this.link.send({ t: T.AUDIO_POLICY, accept: receive });
    if (!receive) this._toWin({ t: T.AUDIO_STOP, dir: 'm2w' });
    this._toWin({ t: 'volume', volume: this.cfg.volume });
    this.routes.push();
    const want = connected && this._on('send') && this.macAccepts;
    loopback.setMute(!!this.cfg.muteLocal); // Mute while sending: the speakers quiet, the capture goes on (loopback.js)
    const line = `with ${this._who()}: connected ${connected}, play ${receive}, send ${this._on('send')}, they accept ${this.macAccepts} -> ${want ? 'sending' : 'not sending'}`;
    if (line !== this.lastApply) this._log((this.lastApply = line));
    if (want && !this.sending) {
      const me = (this.sending = { session: ++this.session, loop: false });
      loopback.acquire().then((label) => {
        if (this.sending !== me) return loopback.release();
        me.loop = true;
        this._toWin({ t: 'start-send', session: me.session, label, ice: this._ice() });
      }, (e) => {
        if (this.sending !== me) return;
        this._log('capture failed:', e.message);
        this.status.error = 'Sending this computer’s sound: ' + e.message;
        this.onChange();
      });
    } else if (!want && this.sending) this._stopSend(true);
    // Keep speakers in sync: said to it while we send, again when it changes.
    const sync = want ? !!this.cfg.sync : null;
    if (sync !== null && sync !== this.saidSync) this.routes.sayingSync(sync);
    this.saidSync = sync;
    this._syncAudioSticky();
    this.onChange();
  }

  _who() {
    const c = this.link.current;
    if (c && c.deviceId) return `${c.name || '?'} (${String(c.deviceId).slice(0, 8)})`;
    return this.link.id ? `(${String(this.link.id).slice(0, 8)}, not connected)` : 'nobody'; // Multi-device: the device this Sound is for
  }

  _log(...a) {
    console.log('[sound]', ...a.filter((x) => x !== ''));
  }

  _stopSend(tellMac) {
    if (!this.sending) return;
    if (this.sending.loop) loopback.release();
    this.sending = null;
    this._toWin({ t: 'stop-send' });
    if (tellMac) this.link.send({ t: T.AUDIO_STOP, dir: 'w2m' });
    this._syncAudioSticky();
  }

  // A phone on the USB cable: WebRTC through the relay (wired.js), else null.
  _ice() {
    const c = this.link.hosting && this.link.server && this.link.server.current;
    return (c && c.ice) || null;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) {
      if (m.t === 'stop-all' || m.t === 'volume' || m.t === 'route' || m.t === T.AUDIO_STOP || m.t === 'stop-send') return; // nothing to stop (a route goes when it's made)
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
    return { ...this.status, macAccepts: this.macAccepts, ...this.routes.view() };
  }

  // The mixer: the receiver's speakers for our sound (From this computer), or ours for its (To).
  setRoute(dir, outs) {
    return dir === 'in' ? this.routes.setLocal(outs) : this.routes.setRemote(outs);
  }
}

module.exports = Sound;
