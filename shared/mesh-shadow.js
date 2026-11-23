// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device, step 1 of docs/mesh-graph.md: the graph in shadow. Beside today's routing, it works out
// what the graph would do for the services routed on this computer (its sound, its microphone, the name
// the popups give) and logs it next to what happens, as [graph] lines, once per change. It changes
// nothing: it only reads the hub, the kvm, Sound and Mic.
//   new MeshShadow({ hub, kvm: () => kvm, sound: () => sound, mic: () => mic, settings: () => settings }).start()
'use strict';

const { resolve, InputPeer } = require('./mesh-graph.js');
const { pairFor } = require('./pairfor.js');

const TICK_MS = 1000;

class MeshShadow {
  // opts: hub; kvm(), sound(), mic(), settings(): today's objects (null until made);
  // log (console.log); now (Date.now); dwellMs (the input peer's).
  constructor(opts) {
    Object.assign(this, { log: (...a) => console.log(...a), now: () => Date.now() }, opts);
    this.peer = new InputPeer({ dwellMs: opts.dwellMs != null ? opts.dwellMs : 2000 });
    this.last = {}; // service -> the line last logged
    this.timer = null;
    this.failed = false;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    try {
      this._tick();
    } catch (e) {
      if (this.failed) return; // once: a shadow must never get in the way
      this.failed = true;
      this.log('[graph] shadow stopped logging: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
    }
  }

  _tick() {
    const hub = this.hub;
    const self = hub.device && hub.device.id;
    if (!self) return;
    const sessions = hub.sessions.list().filter((s) => s.connected);
    const nodes = [{ id: self, os: this.os || osOf(process.platform), name: (hub.device && hub.device.name) || 'this computer' }]
      .concat(sessions.map((s) => ({ id: s.id, os: s.peerOs, name: s.displayName() })));
    const name = (id) => { const n = nodes.find((x) => x.id === id); return n ? n.name : id || 'nobody'; };

    // The input peer, from where the pointer is.
    const kvm = this.kvm();
    for (const id of [this.peer.id, this.peer.pending && this.peer.pending.id]) {
      if (id && !sessions.some((s) => s.id === id)) this.peer.forget(id);
    }
    if (kvm) this.peer.note(kvm.mode, kvm.partner, this.now());
    this._line('input peer', this.peer.id ? `${name(this.peer.id)} (${this.peer.why})` : 'nobody yet');

    const settings = this.settings();
    if (!settings) return;
    const g = {
      nodes,
      from: self,
      inputPeer: (id) => (id === self ? this.peer.id : null),
      selected: (id) => (id === self ? hub.selectedId : null),
      allowed: (svc, from, to) => this._allowed(svc, from, to, settings),
    };

    // Sound from here: every allowed edge (many).
    this._line('sound', `would ${this._would('sound', g, name)} | does ${this._does(this.sound(), name)}`);
    // The microphone from here: one, the input peer's first.
    const mic = this.mic();
    this._line('mic', `would ${this._would('mic', g, name)} | does ${mic ? this._does(mic, name) : 'nothing (the microphone isn’t on)'}`);
    // The name the popups and the Overview give the other device.
    const would = this.peer.id || hub.selectedId;
    this._line('name', `would ${name(would)}${this.peer.id ? ' (the input peer)' : ' (the selection)'} | does ${name(hub.selectedId)} (the selection)`);
  }

  // Today's switches, read the way the features read them (Sound._on, Mic).
  _allowed(svc, from, to, settings) {
    const a = settings.audio || {};
    if (svc === 'sound') return pairFor(settings, this.hub.selectedId, to, 'audio', 'out', !!a.send) ? true : 'Send is off for it';
    if (svc === 'mic') return a.micSend ? true : 'Send microphone is off';
    return 'not in the shadow yet';
  }

  _would(svc, g, name) {
    const edges = resolve(svc, g);
    const on = edges.filter((e) => e.stage === 'active').map((e) => name(e.to));
    const off = edges.filter((e) => e.stage !== 'active').map((e) => `${name(e.to)}: ${e.reason}`);
    return (on.length ? on.join(', ') : 'nobody') + (off.length ? ` (${off.join('; ')})` : '');
  }

  // What a Sound or Mic does now: the device its route is on, and whether it sends. A SoundSet (a Sound
  // per device, shared/sound-mesh.js): the devices it sends to.
  _does(f, name) {
    if (f && typeof f.devices === 'function') {
      const on = f.devices().filter((d) => d.sound.view().sending).sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => name(d.id)); // by id, as would
      return on.length ? `${on.join(', ')}, sending` : 'nobody, not sending';
    }
    if (!f || !f.link) return 'nothing';
    const c = f.link.current;
    if (!c || !c.deviceId) return 'nobody';
    return `${name(c.deviceId)}, ${f.status && f.status.sending ? 'sending' : 'not sending'}`;
  }

  _line(key, text) {
    if (this.last[key] === text) return;
    this.last[key] = text;
    this.log(`[graph] ${key}: ${text}`);
  }
}

function osOf(platform) {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
}

module.exports = { MeshShadow };
