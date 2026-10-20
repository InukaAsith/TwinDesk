// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share screen to several devices at once (docs/screen-mesh.md). Every connected device gets a PcScreen
// of its own, made by `make(scopedLink)` on a link scoped to that device (hub.scoped), so each target has
// its own WebRTC session, mode, monitor and policy. The stream table (shared/screen-mesh.js) holds what
// each target gets and checks it against this computer's displays; there is one virtual display adapter,
// so at most one target can be on Extend.
//
// This object is also the single-peer API the rest of the app grew up with (`pcScreen`): setMode(),
// view() and the Share screen page act on the ACTIVE target (the selected device, else the first
// one), so with one device everything behaves as before. Settings changes (apply, sizeExtend,
// applyInput, sendState, shutdown) reach every target.
'use strict';

const { EventEmitter } = require('events');
const S = require('../shared/screen-mesh.js');

const UI_MODE = { off: 'none', mirror: 'mirror', extend: 'virtual' };

class PcScreenSet extends EventEmitter {
  // hub: hub.js; make(scopedLink, extendFree) -> PcScreen; model() -> raw displays of this computer.
  constructor({ hub, make, model, onChange = () => {} }) {
    super();
    Object.assign(this, { hub, make, model, onChange });
    this.byId = new Map(); // device id -> PcScreen
    this.all = [];
    this.table = {}; // { [deviceId]: choice } of shared/screen-mesh.js
    hub.on('peerAdded', (id) => this._ensure(id));
    hub.on('peerRemoved', (id) => this._gone(id));
    this.first = this._create(hub.scoped(null));
    for (const id of hub._connectedIds()) this._ensure(id);
  }

  _create(link) {
    const pc = this.make(link, () => this._extendFree(pc));
    pc.link = link;
    this.all.push(pc);
    return pc;
  }

  _ensure(id) {
    if (this.byId.has(id)) return;
    const pc = this.first.link.id === null ? this.first : this._create(this.hub.scoped(null));
    pc.link.bind(id);
    this.byId.set(id, pc);
    pc.welcome(); // the link's own 'welcome' went out before this unit was bound
    this.onChange();
  }

  _gone(id) {
    delete this.table[id];
    this.onChange();
  }

  _extendFree(pc) {
    return !this.all.some((x) => x !== pc && x.mode === 'extend');
  }

  get active() {
    return this.byId.get(this.hub.selectedId) || (this.all.find((u) => u.link.id !== null && this.hub.sessions.get(u.link.id)?.connected)) || this.first;
  }

  unit(id) {
    return id ? this.byId.get(id) || null : this.active;
  }

  get displays() {
    return S.normalizeDisplays(this.model());
  }

  // ---- the per-target choice (the page): choice = { mode: 'off'|'mirror'|'extend', displayId? } ----
  async setTarget(id, choice) {
    const pc = this.byId.get(id);
    if (!pc) return { ok: false, error: 'device' };
    const mode = UI_MODE[choice && choice.mode] ? choice.mode : 'off';
    const ids = this.hub._connectedIds();
    const size = pc._extendSize ? pc._extendSize() : [1920, 1080];
    const want = mode === 'off' ? { mode: 'none' }
      : mode === 'mirror' ? { mode: 'mirror', displayId: String(choice.displayId || (this.displays.find((d) => d.primary) || {}).id) }
        : { mode: 'virtual', size: { w: size[0], h: size[1] } };
    const r = S.setChoice(this.table, id, want, ids, this.displays);
    if (!r.ok) {
      pc.status.error = r.error === 'virtual-limit' ? 'The virtual display is already used by another device' : 'That choice isn’t possible now';
      this.onChange();
      return r;
    }
    this.table = r.table;
    if (want.mode === 'mirror') pc.monitorId = want.displayId;
    await pc.setMode(mode);
    return r;
  }

  // ---- the single-peer API: the active target ----
  setMode(mode) { return this.active.setMode(mode); }
  get mode() { return this.active.mode; }
  get link() { return this.first.link; }
  applyInput() { for (const u of this.all) u.applyInput(); }
  apply() { return Promise.all(this.all.map((u) => u.apply())); }
  sizeExtend() { return Promise.all(this.all.map((u) => u.sizeExtend())); }
  sendState() { for (const u of this.all) u.sendState(); }
  shutdown() { for (const u of this.all) u.shutdown(); }

  view() {
    const a = this.active;
    return {
      ...a.view(),
      deviceId: a.link.id,
      displays: this.displays,
      // Every connected device with what it gets now, for the page's per-target choice.
      targets: [...this.byId].filter(([id]) => this.hub.sessions.get(id)?.connected).map(([id, u]) => {
        const s = this.hub.sessions.get(id);
        return { id, name: s.displayName(), os: s.peerOs, mode: u.mode, monitor: u.monitorId || '', status: u.status.status, error: u.status.error, busy: u.busy, active: u === a };
      }),
    };
  }
}

module.exports = { PcScreenSet };
