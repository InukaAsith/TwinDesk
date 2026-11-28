// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device sound, step 2 of docs/mesh-graph.md: a Sound (windows/sound.js, linux/sound.js) per
// connected device, on a link scoped to that device (hub.scoped), instead of one Sound moved along the
// audio route. Each one has its own policy both ways, its own WebRTC session and its own state, so this
// computer's sound plays on every device whose switch is on, and every device's sound can play here, at
// once, without either side having the other selected. Which of our edges send is the sound graph's
// (shared/mesh-graph.js: every allowed edge, up to its limit); each edge's own Sound does the rest.
//
// This is also the object the app had as `sound`: view() is the selected device's, as the Audio page
// shows one device, plus `edges` (every device's); apply() reaches every device.
'use strict';

const { resolve } = require('./mesh-graph.js');
const { viewOf } = require('./hub-route.js');

class SoundSet {
  // Sound: the platform's class; hub: the mesh hub; settings (shared), onChange().
  constructor({ Sound, hub, settings, onChange, save = () => {} }) {
    Object.assign(this, { Sound, hub, settings, onChange, save });
    this.byId = new Map(); // device id -> Sound
    // What each edge's Sound reads of the hub: the selection and each device's own pair (hub.consent,
    // shared/consent.js). Nothing holds sound to a device any more (no sticky route).
    this.meshHub = { get selectedId() { return hub.selectedId; }, get consent() { return hub.consent || null; }, setAudioSticky() {} };
    hub.on('peerAdded', (id) => this._ensure(id));
    hub.on('peerRemoved', () => this.apply()); // the graph without it: another edge may send now
    // settings.audio is the selected device's pair: a new selection changes every edge's switches. Only
    // then (apply() tells each device our policy, so not on every change of the hub).
    this.selectedId = hub.selectedId;
    hub.on('change', () => {
      if (hub.selectedId === this.selectedId) return;
      this.selectedId = hub.selectedId;
      this.apply();
    });
    for (const id of hub._connectedIds()) this._ensure(id);
  }

  _ensure(id) {
    if (!id) return;
    let snd = this.byId.get(id);
    if (!snd) {
      const link = this._link(id);
      snd = new this.Sound({ link, settings: this.settings, save: this.save, onChange: this.onChange, meshHub: this.meshHub });
      // Send: the graph's edge, not only the switch (its limit; the same switch inside).
      const on = snd._on.bind(snd);
      snd._on = (key) => (key === 'send' ? this._sends(id) : on(key));
      this.byId.set(id, snd);
      link.welcome(); // its 'welcome' went out before this Sound listened
    }
    this.apply();
  }

  // hub.scoped(id) and what Sound reads besides: current (the device, as a route gives it).
  _link(id) {
    const hub = this.hub;
    const link = hub.scoped(id);
    const welcomes = [];
    const on = link.on.bind(link);
    link.on = (type, fn) => {
      if (type === 'welcome') welcomes.push(fn);
      on(type, fn);
    };
    link.welcome = () => { for (const fn of welcomes) fn({}); };
    Object.defineProperty(link, 'current', { get: () => { const s = hub.sessions.get(id); return s && s.connected ? viewOf(s) : null; } });
    return link;
  }

  _sends(id) {
    return sendsTo(this.hub, this.settings, id);
  }

  // A settings change, a selection change (whose switches settings.audio holds), a device gone.
  apply() {
    for (const snd of this.byId.values()) snd.apply();
  }

  // The selected device's, as the Audio page shows one device; edges: every connected device's.
  view() {
    const sel = this.byId.get(this.hub.selectedId);
    const base = sel ? sel.view() : { receiving: false, sending: false, error: '', macAccepts: false };
    const edges = [];
    for (const [id, snd] of this.byId) {
      const s = this.hub.sessions.get(id);
      if (!s || !s.connected) continue;
      const v = snd.view();
      edges.push({ id, name: s.displayName(), sending: !!v.sending, receiving: !!v.receiving, accepts: !!v.macAccepts, error: v.error || '', ...mixOf(this.hub, this.settings, id, s.peerOs, v) });
    }
    const error = base.error || (edges.find((e) => e.error) || {}).error || '';
    return { ...base, error, edges };
  }

  // The mixer: device id's speakers for our sound ('out'), or ours for its ('in').
  setRoute(id, dir, outs) {
    const snd = this.byId.get(id);
    return !!snd && snd.setRoute(dir, outs);
  }

  // Every device's Sound (the shadow reads them).
  devices() {
    return [...this.byId].map(([id, sound]) => ({ id, sound }));
  }
}

// The sound graph from here (docs/mesh-graph.md): is this computer's edge to device `id` active? hub: a
// mesh hub (device, sessions, selectedId, consent) of Windows, Linux or the Mac; settings: audio.send, the
// switch when the hub has no consent (each device's own pair, shared/consent.js).
function sendsTo(hub, settings, id) {
  const self = hub.device && hub.device.id;
  if (!self) return false;
  const nodes = [{ id: self, os: osOf(process.platform), name: hub.device.name }]
    .concat(hub.sessions.list().filter((s) => s.connected).map((s) => ({ id: s.id, os: s.peerOs, name: s.displayName() })));
  const a = settings.audio || {};
  const edges = resolve('sound', {
    nodes,
    from: self,
    selected: () => hub.selectedId,
    allowed: (svc, from, to) => ((hub.consent ? hub.consent.get(to, 'audio', 'out') : !!a.send) ? true : 'Send is off for it'),
  });
  const e = edges.find((x) => x.to === id);
  return !!e && e.stage === 'active';
}

// What the mixer shows of one edge (shared/ui-sound-mix.js): its OS, both switches (the device's own pair,
// shared/consent.js), what the receiver told us of our sound there, and its sound here.
function mixOf(hub, settings, id, os, v) {
  const a = settings.audio || {};
  const c = hub.consent;
  return {
    os: os || '',
    sendOn: c ? !!c.get(id, 'audio', 'out') : !!a.send,
    recvOn: c ? !!c.get(id, 'audio', 'in') : !!a.receive,
    remote: v.remote || null,
    local: v.local || null,
  };
}

function osOf(platform) {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
}

module.exports = { SoundSet, sendsTo, mixOf };
