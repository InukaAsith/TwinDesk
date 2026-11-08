// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Standalone sound, both ways, independent of the screen:
//   m2w — this Mac's sound to the PC: sent when "Send this Mac's sound" is on, the PC accepts
//         (`audio.policy`) and the screen session isn't already carrying it.
//   w2m — the PC's sound here: we tell the PC with `audio.policy {accept}` and answer its offers.
//
// Events: 'change' — this.view changed.
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const DROP_MS = 30000;

class Audio extends EventEmitter {
  constructor({ server, hub, stream, getSettings }) {
    super();
    Object.assign(this, { server, hub, stream, getSettings });
    this.win = null;
    this.peerAccepts = false; // the PC plays our sound
    this.sendSession = 0;
    this.sending = null; // { session, status }
    this.receiving = null; // { session, status }

    server.on('client', () => {
      this.peerAccepts = false;
      this._policy();
      this.evaluate();
    });
    server.on('closed', () => {
      if (server.current) return;
      this._stopSend(false);
      this._stopRecv();
      this._idle();
    });
    server.on(`t:${P.T.AUDIO_POLICY}`, (m) => {
      this.peerAccepts = m.accept === true;
      this.evaluate();
    });
    server.on(`t:${P.T.AUDIO_OFFER}`, (m) => m.dir === 'w2m' && this._onOffer(m));
    server.on(`t:${P.T.AUDIO_STOP}`, (m) => m.dir === 'w2m' && this._stopRecv());
    for (const t of [P.T.AUDIO_ANSWER, P.T.AUDIO_ICE]) server.on(`t:${t}`, (m) => this._toWin('remote', m));
    stream.on('change', () => this.evaluate()); // the screen may have started/stopped carrying sound

    ipcMain.on('audio:out', (e, m) => {
      if (!this._fromWin(e)) return;
      const ours = m.dir === 'm2w' ? this.sending : this.receiving;
      if (ours && m.session === ours.session) this.server.sendToClient(m);
    });
    ipcMain.on('audio:state', (e, s) => {
      if (!this._fromWin(e)) return;
      const ours = s.dir === 'm2w' ? this.sending : this.receiving;
      if (!ours || s.session !== ours.session) return;
      ours.status = s.status === 'connected' ? 'live' : s.status;
      this.emit('change');
    });
  }

  get cfg() {
    return this.getSettings().audio;
  }

  _fromWin(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  async _ensureWin() {
    clearTimeout(this.dropTimer);
    if (this.win && !this.win.isDestroyed()) return;
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-audio.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[audio-window] ${e.message}`));
    await this.win.loadFile(path.join(__dirname, 'audio.html'));
    this._toWin('volume', this.cfg.volume);
  }

  _toWin(channel, msg) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, msg);
  }

  _policy() {
    this.server.sendToClient({ t: P.T.AUDIO_POLICY, accept: !!this.cfg.receive });
  }

  // m2w: start or stop sending to match the switches.
  async evaluate() {
    const screenCarries = this.stream.audio.on;
    const want = !!(this.cfg.send && this.peerAccepts && this.server.current && !screenCarries);
    if (want && !this.sending) {
      const session = ++this.sendSession;
      this.sending = { session, status: 'starting' };
      this.emit('change');
      await this._ensureWin();
      if (!this.sending || this.sending.session !== session) return;
      if (!(await this.hub.acquire('audio', this.win.webContents))) {
        this.sending = { session, status: `error: ${this.hub.error}` };
        return this.emit('change');
      }
      this._toWin('send-start', { session, ice: (this.server.current && this.server.current.ice) || null });
    } else if (!want && this.sending) {
      this._stopSend(true);
    }
    this.emit('change');
  }

  _stopSend(tell) {
    if (!this.sending) return;
    this.sending = null;
    this.hub.release('audio');
    this._toWin('send-stop', {});
    if (tell && this.server.current) this.server.sendToClient({ t: P.T.AUDIO_STOP, dir: 'm2w' });
    this.emit('change');
    this._idle();
  }

  // Nothing playing either way and nobody who would (no session, or both switches off): the hidden
  // window and its renderer go after DROP_MS; the next sound makes it again.
  _idle() {
    clearTimeout(this.dropTimer);
    if (!this.win) return;
    this.dropTimer = setTimeout(() => {
      const c = this.cfg;
      if (this.sending || this.receiving || !this.win || (this.server.current && (c.send || c.receive))) return;
      const w = this.win;
      this.win = null;
      if (!w.isDestroyed()) w.destroy();
    }, DROP_MS);
  }

  // w2m: the PC offers its sound.
  async _onOffer(m) {
    if (!this.cfg.receive) return;
    this.receiving = { session: m.session, status: 'connecting' };
    await this._ensureWin();
    this._toWin('recv', { session: m.session, sdp: m.sdp, ice: (this.server.current && this.server.current.ice) || null });
    this.emit('change');
  }

  _stopRecv() {
    if (!this.receiving) return;
    this.receiving = null;
    this._toWin('recv-stop', {});
    this.emit('change');
    this._idle();
  }

  // After the Audio tab changed.
  applySettings() {
    this._policy();
    if (!this.cfg.receive) this._stopRecv();
    this._toWin('volume', this.cfg.volume);
    this.hub.applyMute();
    this.evaluate();
    this._idle();
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      screenCarries: this.stream.audio.on,
      sending: this.sending,
      receiving: this.receiving,
      error: this.hub.error,
    };
  }
}

module.exports = { Audio };
