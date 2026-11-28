// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device sound on the Mac, step 2 of docs/mesh-graph.md, as shared/sound-mesh.js on Windows and
// Linux: an Audio (../audio.js) per connected device, on a route that always follows that device
// (hub.route), instead of one Audio on the audio route. Each has its own policy both ways and its own
// session; the capture (audiohub.js) is shared, each Audio its own consumer of it. This Mac's sound
// goes to every device the sound graph keeps (shared/mesh-graph.js), and every device's plays here.
//
// The object main.js and ipc.js had as `audio`: view is the selected device's (the Audio page shows
// one device) plus `edges`; applySettings() reaches every device; 'change' from any of them.
'use strict';

const { EventEmitter } = require('events');
const { sendsTo, mixOf } = require('../../shared/sound-mesh.js');

class AudioSet extends EventEmitter {
  // Audio: ../audio.js's; Peer: ./peer.js's; hub: the mesh hub; audioHub, stream, getSettings: as Audio takes.
  constructor({ Audio, Peer, hub, audioHub, stream, getSettings, saveSettings = () => {} }) {
    super();
    Object.assign(this, { Audio, Peer, hub, audioHub, stream, getSettings, saveSettings });
    this.byId = new Map(); // device id -> Audio
    // What each Audio reads of the hub: the selection, for whose switches are in settings.audio.
    // Nothing holds sound to a device (no sticky route): every device has its own.
    this.meshHub = { get selectedId() { return hub.selectedId; }, get consent() { return hub.consent || null; }, setAudioSticky() {} }; // each device's own pair (hub.consent)
    hub.on('peerAdded', (id) => this._ensure(id));
    hub.on('peerRemoved', () => this.evaluate()); // the graph without it
    this.selectedId = hub.selectedId;
    hub.on('change', () => {
      if (hub.selectedId === this.selectedId) return; // settings.audio is the new one's pair: every edge again
      this.selectedId = hub.selectedId;
      this.applySettings();
    });
    for (const id of hub._connectedIds()) this._ensure(id);
  }

  _ensure(id) {
    if (!id || this.byId.has(id)) return this.evaluate();
    const route = this.hub.route(() => id);
    const a = new this.Audio({
      server: new this.Peer(route, this.hub.server), hub: this.audioHub, stream: this.stream,
      getSettings: this.getSettings, saveSettings: this.saveSettings, meshHub: this.meshHub, capName: 'audio:' + id,
    });
    const on = a._on.bind(a);
    a._on = (key) => (key === 'send' ? sendsTo(this.hub, this.getSettings(), id) : on(key));
    a.on('change', () => this.emit('change'));
    this.byId.set(id, a);
    route.refresh(); // 'client' now: it's connected
    this.evaluate();
  }

  evaluate() {
    for (const a of this.byId.values()) a.evaluate();
  }

  applySettings() {
    for (const a of this.byId.values()) a.applySettings();
  }

  get view() {
    const sel = this.byId.get(this.hub.selectedId);
    const base = sel ? sel.view : { peerAccepts: false, screenCarries: this.stream.audio.on, sending: null, receiving: null, error: this.audioHub.error };
    const edges = [];
    for (const [id, a] of this.byId) {
      const s = this.hub.sessions.get(id);
      if (!s || !s.connected) continue;
      const v = a.view;
      edges.push({ id, name: s.displayName(), sending: !!(v.sending && v.sending.status === 'live'), receiving: !!(v.receiving && v.receiving.status === 'live'), accepts: !!v.peerAccepts, ...mixOf(this.hub, this.getSettings(), id, s.peerOs, v) });
    }
    return { ...base, edges };
  }

  // The mixer: device id's speakers for our sound ('out'), or ours for its ('in').
  setRoute(id, dir, outs) {
    const a = this.byId.get(id);
    return !!a && a.setRoute(dir, outs);
  }

  // Every device's Audio (the shadow reads them).
  devices() {
    return [...this.byId].map(([id, a]) => ({ id, sound: { view: () => ({ sending: !!(a.sending && a.sending.status === 'live') }) } }));
  }
}

module.exports = { AudioSet };
