// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio › Microphone (#125): a computer's microphone on the other one, each way on its own switch.
// The sender captures its microphone (getUserMedia, the device picked) and offers it (`mic.offer`)
// once the other side's `mic.policy` accepts; the receiver plays it into an output device, so apps
// there can take it as a microphone:
//   Linux    TwinDesk makes the microphone itself: a null sink ("TwinDesk Microphone output") and a
//            source remapped from its monitor ("TwinDesk Microphone"), through pactl (PulseAudio or
//            PipeWire's pulse server); unloaded when it stops.
//   Windows, macOS  a virtual audio cable (VB-CABLE, BlackHole, Loopback…) when one is installed,
//            found by name, or the output picked; without one it plays on the speakers.
// Loaded only when one of its switches is on (each main.js loadMic): off, none of this is in memory.
// Its WebRTC runs in a hidden window (mic.html), closed while both ways are off.
//
// opts: link (Windows/Linux peer.js or the mesh facade) | server (the Mac's), cfg() → settings.audio,
//       onChange(), platform ('mac'|'win'|'linux'), askMic?() → Promise<bool> (macOS permission).
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const P = require('./protocol.js');

const T = P.T;
const CABLE = /CABLE Input|VB-Audio|BlackHole|Loopback Audio|Soundflower|Virtual Cable/i;
const LINUX_SINK = 'twindesk_mic';

function transportOf(opts) {
  if (opts.link) {
    const l = opts.link;
    return {
      on: (t, fn) => l.on(t, fn),
      send: (m) => l.send(m),
      connected: () => !!(l.status && l.status.state === 'connected'),
      welcome: (fn) => l.on('welcome', fn),
      closed: (fn) => l.on('closed', fn),
      ice: () => { const c = l.hosting && l.server && l.server.current; return (c && c.ice) || null; },
    };
  }
  const s = opts.server;
  return {
    on: (t, fn) => s.on('t:' + t, fn),
    send: (m) => s.sendToClient(m),
    connected: () => !!s.current,
    welcome: (fn) => s.on('client', fn),
    closed: (fn) => s.on('closed', () => { if (!s.current) fn(); }),
    ice: () => (s.current && s.current.ice) || null,
  };
}

const pactl = (args) => new Promise((resolve) => execFile('pactl', args, { timeout: 5000 }, (e, out) => resolve(e ? null : String(out).trim())));

class Mic {
  constructor(opts) {
    Object.assign(this, { onChange: () => {}, platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', askMic: null }, opts);
    this.tx = transportOf(opts);
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.peerAccepts = false; // the other side's mic.policy: it uses our microphone
    this.sending = null; // {session} while our microphone goes over
    this.counter = 0;
    this.modules = []; // Linux: the pactl modules we loaded
    this.status = { sending: false, receiving: false, error: '', into: '', inputs: [], outputs: [] };

    this.tx.welcome(() => { this.peerAccepts = false; this.apply(true); });
    this.tx.closed(() => { this.peerAccepts = false; this._stopSend(false); this._toWin({ t: 'stop-recv' }); this.apply(); });
    this.tx.on(T.MIC_POLICY, (m) => {
      const accept = m.accept === true;
      if (m.ask) this._policy(); // the other side just loaded its microphone: it asks for ours
      if (accept === this.peerAccepts) return;
      this.peerAccepts = accept;
      this.apply();
    });
    this.tx.on(T.MIC_OFFER, (m) => { if (this.cfg().micReceive && typeof m.sdp === 'string') this._recvOffer(m); });
    this.tx.on(T.MIC_ANSWER, (m) => { if (this.sending && m.session === this.sending.session && typeof m.sdp === 'string') this._toWin(m); });
    this.tx.on(T.MIC_ICE, (m) => this.win && this._toWin(m));
    this.tx.on(T.MIC_STOP, () => this.win && this._toWin({ t: 'stop-recv' }));

    this._onOut = (e, m) => { if (this._ours(e) && m && [T.MIC_OFFER, T.MIC_ANSWER, T.MIC_ICE].includes(m.t)) this.tx.send(m); };
    this._onState = (e, s) => {
      if (!this._ours(e) || !s) return;
      const list = (v) => (Array.isArray(v) ? v.slice(0, 40).map((d) => ({ id: String(d.id || '').slice(0, 200), label: String(d.label || '').slice(0, 200) })) : []);
      Object.assign(this.status, { sending: !!s.sending, receiving: !!s.receiving, error: String(s.error || '').slice(0, 300), into: String(s.into || '').slice(0, 200), inputs: list(s.inputs), outputs: list(s.outputs) });
      this.onChange();
    };
    this._onReady = (e) => {
      if (!this._ours(e)) return;
      this.ready = true;
      for (const m of this.queue.splice(0)) this.win.webContents.send('mic', m);
    };
    ipcMain.on('mic-out', this._onOut);
    ipcMain.on('mic-state', this._onState);
    ipcMain.on('mic-ready', this._onReady);
    this.apply(true);
  }

  // After welcome, a policy, or a settings change. ask: tell the other side to send its policy (we
  // were just loaded, and missed it).
  async apply(ask = false) {
    const c = this.cfg();
    this._policy(ask);
    if (!c.micReceive) this._toWin({ t: 'stop-recv' });
    if (c.micReceive && this.platform === 'linux') await this._linuxMic(true);
    if (!c.micReceive && this.modules.length) await this._linuxMic(false);
    if ((c.micSend || c.micReceive) && (!this.win || this.win.isDestroyed())) this._create(); // on: the pickers list the devices
    else this._toWin({ t: 'devices', input: c.micDevice || '', output: c.micOut || '', virtual: this.platform === 'linux' ? 'TwinDesk Microphone' : '' });
    const want = this.tx.connected() && c.micSend && this.peerAccepts;
    if (want && this.sending && this.sending.device !== (c.micDevice || '')) this._stopSend(true); // a new microphone: start again
    if (want && !this.sending) {
      if (this.askMic && !(await this.askMic())) {
        this.status.error = 'Allow TwinDesk to use the microphone (System Settings › Privacy & Security › Microphone)';
      } else if (!this.sending && this.tx.connected() && this.cfg().micSend && this.peerAccepts) {
        this.sending = { session: ++this.counter, device: c.micDevice || '' };
        this._toWin({ t: 'start-send', session: this.sending.session, device: c.micDevice || '', ice: this.tx.ice() });
      }
    } else if (!want && this.sending) this._stopSend(true);
    if (!c.micSend && !c.micReceive) this._close(); // both off: the window goes (no memory kept for it)
    this.onChange();
  }

  _policy(ask = false) {
    if (this.tx.connected()) this.tx.send({ t: T.MIC_POLICY, accept: !!this.cfg().micReceive, ...(ask ? { ask: true } : {}) });
  }

  _recvOffer(m) {
    this._toWin({ ...m, ice: this.tx.ice() });
  }

  _stopSend(tell) {
    if (!this.sending) return;
    this.sending = null;
    this._toWin({ t: 'stop-send' });
    if (tell && this.tx.connected()) this.tx.send({ t: T.MIC_STOP });
  }

  // Linux: the "TwinDesk Microphone" apps pick (on), or gone (off).
  async _linuxMic(on) {
    if (on) {
      if (this.modules.length) return;
      const have = await pactl(['list', 'short', 'sinks']);
      if (have === null) { this.status.error = 'pactl isn’t there: install pulseaudio-utils (PipeWire: pipewire-pulse) for the TwinDesk microphone'; return; }
      if (have.split('\n').some((l) => l.split('\t')[1] === LINUX_SINK)) return; // left by an earlier run: use it
      const sink = await pactl(['load-module', 'module-null-sink', `sink_name=${LINUX_SINK}`, 'sink_properties=device.description=TwinDesk-Microphone-output']);
      const src = sink && await pactl(['load-module', 'module-remap-source', `master=${LINUX_SINK}.monitor`, 'source_name=twindesk_mic_source', 'source_properties=device.description=TwinDesk-Microphone']);
      this.modules = [sink, src].filter(Boolean);
      if (!src) this.status.error = 'Couldn’t make the TwinDesk microphone (pactl load-module)';
    } else {
      for (const id of this.modules.reverse()) await pactl(['unload-module', id]);
      this.modules = [];
    }
  }

  _ours(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) {
      if (m.t !== 'start-send' && m.t !== T.MIC_OFFER) return; // nothing to stop or set
      this._create();
    }
    if (this.ready) this.win.webContents.send('mic', m);
    else this.queue.push(m);
  }

  _create() {
    this.ready = false;
    this.queue = [];
    const c = this.cfg();
    this.queue.push({ t: 'devices', input: c.micDevice || '', output: c.micOut || '', virtual: this.platform === 'linux' ? 'TwinDesk Microphone' : '' });
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-mic.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win.loadFile(path.join(__dirname, 'mic.html'));
    this.win.on('closed', () => { this.win = null; this.ready = false; });
  }

  _close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
    this.queue = [];
    Object.assign(this.status, { sending: false, receiving: false, into: '' });
  }

  // Quit: everything stops, the Linux microphone goes.
  async shutdown() {
    this._stopSend(true);
    this._close();
    if (this.modules.length) await this._linuxMic(false);
  }

  view() {
    return { ...this.status, peerAccepts: this.peerAccepts, linux: this.platform === 'linux', cable: CABLE.source };
  }
}

module.exports = { Mic, CABLE };
