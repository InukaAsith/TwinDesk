// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A web device's camera and microphone on this computer (shared/web/webhub.js): one hidden window
// (webrecv.html), opened with the first offer and closed a minute after the last one stops. One
// camera and one microphone at a time: a second device's offer takes over from the first.
// fromPhone(dev, msg); stopDevice(id); stopAll(); view() → {cam, mic}
// Events: 'out' (devId, msg for that page), 'change'
'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain, systemPreferences } = require('electron');

class WebRecv extends EventEmitter {
  constructor({ allowed = () => true } = {}) {
    super();
    this.allowed = allowed; // (kind) → '' or why not (Camera / Microphone off for web devices)
    this.win = null;
    this.state = { cam: { status: 'off', dev: null }, mic: { status: 'off', dev: null, out: '' } };
    ipcMain.on('webrecv:out', (e, m) => {
      if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) return;
      if (m.t === 'state') {
        const s = this.state[m.kind];
        if (!s || (s.dev && s.dev !== m.dev)) return;
        s.status = m.status;
        if (m.out !== undefined) s.out = m.out;
        if (m.status === 'off') s.dev = null;
        this.emit('out', m.dev, { t: `${m.kind}.state`, status: m.status, out: s.out || '' });
        this._idle();
        return this.emit('change');
      }
      if (m.dev) this.emit('out', m.dev, { ...m, dev: undefined });
    });
  }

  async _window() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      show: false, width: 320, height: 240,
      webPreferences: { preload: path.join(__dirname, 'preload-webrecv.js'), backgroundThrottling: false, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    this.win.webContents.on('console-message', (e) => { if (e.message) console.log('[webrecv]', e.message); });
    this.ready = this.win.loadFile(path.join(__dirname, 'webrecv.html'));
    return this.ready;
  }

  async fromPhone(dev, m) {
    const [kind, what] = m.t.split('.');
    const s = this.state[kind];
    if (what === 'offer') {
      const why = this.allowed(kind);
      if (why) return this.emit('out', dev.id, { t: `${kind}.state`, status: `error: ${why}` });
      if (s.dev && s.dev !== dev.id) this.emit('out', s.dev, { t: `${kind}.state`, status: 'off', why: `${dev.name} took over` });
      s.dev = dev.id;
      s.status = 'connecting';
      s.name = dev.name;
      this.emit('change');
      await this._window();
    } else if (s.dev !== dev.id) {
      return;
    }
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('webrecv:in', { t: m.t, dev: dev.id, sdp: typeof m.sdp === 'string' ? m.sdp : undefined, candidate: m.candidate });
  }

  stopDevice(id) {
    for (const kind of ['cam', 'mic']) if (this.state[kind].dev === id) this._stop(kind);
  }

  stopAll() {
    this._stop('cam');
    this._stop('mic');
  }

  _stop(kind) {
    const s = this.state[kind];
    if (!s.dev) return;
    s.dev = null;
    s.status = 'off';
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('webrecv:in', { t: `${kind}.stop` });
    this.emit('change');
    this._idle();
  }

  _idle() {
    clearTimeout(this.idleTimer);
    if (this.state.cam.dev || this.state.mic.dev) return;
    this.idleTimer = setTimeout(() => {
      if (this.state.cam.dev || this.state.mic.dev || !this.win || this.win.isDestroyed()) return;
      this.win.destroy();
      this.win = null;
    }, 60000);
  }

  view() {
    return { cam: { ...this.state.cam }, mic: { ...this.state.mic } };
  }
}

module.exports = { WebRecv };
