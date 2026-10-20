// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share this Mac's screen to several devices at once (docs/screen-mesh.md). Every connected device gets a
// Stream of its own (stream.js) on a peer bound to that device, so each target has its own WebRTC
// session, policy and display. A target follows the shared settings (`sharing.on`, `sharing.displayId`,
// the virtual display) until it is given a choice of its own: none, mirror of a display, or the
// virtual display. The stream table (shared/screen-mesh.js) checks the choices against this Mac's displays.
//
// This object is also the single-stream API the rest of the app grew up with (`stream`): restart(),
// stop(), `view` and `audio` are the ACTIVE target's (the selected device), so with one device
// everything behaves as before. restart() and stop() reach every target.
//
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const S = require('../shared/screen-mesh.js');
const { ScopedPhonePeer: ScopedPeer } = require('./phones.js');

class StreamSet extends EventEmitter {
  // hub: hub.js; server: the Server; make(peer) -> Stream; displays: Displays (model()).
  constructor({ hub, server, make, displays }) {
    super();
    Object.assign(this, { hub, server, make, displays });
    this.byId = new Map();
    this.all = [];
    this.table = {};
    this.first = this._create();
    hub.bus.onPeer('welcome', (id) => this._ensure(id));
    hub.bus.onPeer('closed', (id) => this._gone(id));
    for (const s of hub.sessions.list()) if (s.connected) this._ensure(s.id);
  }

  _create() {
    const peer = new ScopedPeer(this.hub, this.server, null);
    const st = this.make(peer);
    st.peer = peer;
    st.audioOk = () => st === this.active;
    st.on('change', () => this.emit('change'));
    this.all.push(st);
    return st;
  }

  _ensure(id) {
    if (this.byId.has(id)) return;
    const st = this.first.peer.id === null ? this.first : this._create();
    st.peer.bind(id);
    this.byId.set(id, st);
    this.emit('change');
  }

  _gone(id) {
    delete this.table[id];
    this.emit('change');
  }

  get active() {
    return this.byId.get(this.hub.selectedId) || this.first;
  }

  get view() {
    const a = this.active;
    return {
      ...a.view,
      deviceId: a.peer.id,
      displays: S.normalizeDisplays(this.displays.model()),
      targets: [...this.byId].filter(([id]) => (this.hub.sessions.get(id) || {}).connected).map(([id, st]) => {
        const c = st.choice;
        return { id, name: this.hub.sessions.get(id).displayName(), mode: c ? c.mode : 'default', displayId: c && c.displayId ? String(c.displayId) : '', status: st.view.status, active: st === a };
      }),
    };
  }

  get audio() {
    return this.active.audio;
  }

  // choice: { mode: 'default'|'none'|'mirror'|'virtual', displayId? }. 'default' follows the shared settings again.
  setTarget(id, choice) {
    const st = this.byId.get(id);
    if (!st) return { ok: false, error: 'device' };
    const ids = [...this.byId.keys()];
    const displays = S.normalizeDisplays(this.displays.model());
    if (!choice || choice.mode === 'default') {
      delete this.table[id];
      st.choice = null;
    } else {
      const want = choice.mode === 'virtual' ? { mode: 'virtual', size: { w: 1920, h: 1080 } }
        : choice.mode === 'mirror' ? { mode: 'mirror', displayId: String(choice.displayId) } : { mode: choice.mode };
      const r = S.setChoice(this.table, id, want, ids, displays);
      if (!r.ok) return r;
      this.table = r.table;
      st.choice = choice.mode === 'mirror' ? { mode: 'mirror', displayId: Number(choice.displayId) } : { mode: choice.mode };
    }
    st.restart('target choice');
    this.emit('change');
    return { ok: true };
  }

  restart(reason) {
    return Promise.all(this.all.map((st) => st.restart(reason)));
  }

  stop(status) {
    for (const st of this.all) st.stop(status);
  }
}

module.exports = { StreamSet };
