// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two-way switches per pair in Multi-device (step 5 of docs/mesh-graph.md), on the bus instead of the facade.
// The wire and its meaning are pairsync.js's (an older app speaks the same): `pair.sync {feature, dir, on}`,
// `{key, value}` (a shared value) and `{all}` (the host's, when the session starts), directions from the
// sender's side.
//
// Every device's pair is kept (settings.pairSync[id]) and told by its own session; the settings hold the
// pair of the device the pages show (the selected one), which is where they're read and changed. The facade
// did that on its welcome and closed (a crossing): PairSync adopted the new device's pair into the settings
// and a pair.sync from a device that wasn't selected was only stashed. Here the hub says so ('selected'):
// the pair of the device the pages showed is kept, the next one's goes into the settings; a pair.sync from
// any device is kept for it, and goes into the settings when it's the one shown.
//
//   pairSyncMesh({ bus, hub, features, values, settings(), save(), setFeature(f, dir, on), setValue(key, v),
//                  peerRole(id), peerOs(id), onPair(id) })
//     features / values: the platform's pairsync.js FEATURES / VALUES (only those this app syncs)
//     setFeature / setValue: apply one to the settings with its side effects (ipc.set, the Mac's actions)
//     check()   with every state push: what changed in the settings goes to the device shown, and is kept
'use strict';

const P = require('./protocol.js');

const T = P.T;

class PairSyncMesh {
  constructor(o) {
    Object.assign(this, o);
    if (!this.settings().pairSync || typeof this.settings().pairSync !== 'object') this.settings().pairSync = {};
    this.shownId = this.hub.selectedId || null; // whose pair the settings hold
    this.mirroring = false;
    this.bus.on(T.PAIR_SYNC, (m, from) => this._heard(m, from));
    this.bus.onPeer('welcome', (id) => this._welcome(id));
    this.hub.on('selected', (id) => this._show(id || null));
  }

  get all() {
    return this.settings().pairSync;
  }

  _flat(f, dir) {
    const p = this.features[f] && this.features[f][dir];
    const sec = p && this.settings()[p[0]];
    return sec && typeof sec === 'object' ? !!sec[p[1]] : undefined;
  }

  _valuesFor(id) {
    const phone = !!(this.peerOs && P.isPhoneOs(this.peerOs(id)));
    return Object.fromEntries(Object.entries(this.values).filter(([, d]) => (phone || !d.phone) && (!d.feature || this.features[d.feature])));
  }

  // The settings as a pair (directions from our side), for the device shown.
  _snapshot(id) {
    const out = { values: {} };
    for (const f of Object.keys(this.features)) out[f] = { out: this._flat(f, 'out'), in: this._flat(f, 'in') };
    for (const [k, d] of Object.entries(this._valuesFor(id))) {
      let v = this.settings();
      for (const p of d.path) v = v == null ? undefined : v[p];
      out.values[k] = v;
    }
    return out;
  }

  // A device's pair: its saved one, else the settings (a device met for the first time takes them).
  pairOf(id) {
    return id === this.shownId ? this._snapshot(id) : this.all[id] || this._snapshot(id);
  }

  // A message as a pair to keep (our side's directions), or null.
  _fromWire(m, id) {
    const vals = this._valuesFor(id);
    if (vals[m.key] && vals[m.key].allowed.includes(m.value)) return { values: { [m.key]: m.value } };
    if (m.all && typeof m.all === 'object') {
      const mine = { values: {} };
      for (const [k, d] of Object.entries(vals)) if (m.all.values && d.allowed.includes(m.all.values[k])) mine.values[k] = m.all.values[k];
      for (const f of Object.keys(this.features)) {
        const v = m.all[f];
        if (v && typeof v === 'object') mine[f] = { out: v.in, in: v.out }; // their in = our out
      }
      return mine;
    }
    if (this.features[m.feature] && (m.dir === 'out' || m.dir === 'in') && typeof m.on === 'boolean') {
      return { [m.feature]: { [m.dir === 'out' ? 'in' : 'out']: m.on } };
    }
    return null;
  }

  _keep(id, add) {
    const cur = this.all[id] || { values: {} };
    if (!cur.values) cur.values = {};
    for (const [k, v] of Object.entries(add.values || {})) if (v !== undefined) cur.values[k] = v;
    for (const [f, v] of Object.entries(add)) {
      if (f === 'values' || !v || !this.features[f]) continue;
      cur[f] = { ...(cur[f] || {}) };
      for (const dir of ['out', 'in']) if (typeof v[dir] === 'boolean') cur[f][dir] = v[dir];
    }
    this.all[id] = cur;
    this.save();
    if (this.onPair) this.onPair(id);
  }

  // Into the settings, each with its side effects, without telling it back (check() sees no change).
  _mirror(pair, id) {
    this.mirroring = true;
    try {
      for (const f of Object.keys(this.features)) {
        const v = pair[f];
        if (!v) continue;
        for (const dir of ['out', 'in']) {
          if (typeof v[dir] === 'boolean' && this.features[f][dir] && this._flat(f, dir) !== v[dir]) this.setFeature(f, dir, v[dir]);
        }
      }
      const now = this._snapshot(id).values;
      for (const [k, d] of Object.entries(this._valuesFor(id))) {
        const v = pair.values && pair.values[k];
        if (v !== undefined && d.allowed.includes(v) && now[k] !== v) this.setValue(k, v);
      }
    } finally {
      this.mirroring = false;
    }
  }

  _heard(m, id) {
    const add = this._fromWire(m, id);
    if (!add) return;
    this._keep(id, add);
    if (id === this.shownId) this._mirror(add, id);
  }

  // A device's session started: the host tells its pair (an older app adopts it as before).
  _welcome(id) {
    if (id === this.shownId) this.check();
    if (this.peerRole && this.peerRole(id) !== 'guest') return;
    this.bus.send(id, { t: T.PAIR_SYNC, all: this.pairOf(id) });
  }

  // The pages show another device: the last one's pair kept as it is now, the next one's into the settings.
  _show(id) {
    if (id === this.shownId) return;
    this.check();
    this.shownId = id;
    if (!id) return;
    const saved = this.all[id];
    if (saved) this._mirror(saved, id);
    else this._keep(id, this._snapshot(id)); // met for the first time: the settings are its pair
  }

  // With every state push: a switch or value changed on the pages goes to the device shown, and is kept.
  check() {
    const id = this.shownId;
    if (!id || this.mirroring) return;
    const now = this._snapshot(id);
    const was = this.all[id];
    if (!was) return this._keep(id, now); // its first pair: the settings, nothing changed
    // One the pair never had (an older entry, a value added since) is the settings' now: kept, not told.
    let changed = false;
    let fresh = false;
    for (const f of Object.keys(this.features)) {
      for (const dir of ['out', 'in']) {
        const v = now[f][dir];
        const old = (was[f] || {})[dir];
        if (typeof v !== 'boolean' || v === old) continue;
        if (typeof old !== 'boolean') { fresh = true; continue; }
        changed = true;
        this.bus.send(id, { t: T.PAIR_SYNC, feature: f, dir, on: v });
      }
    }
    for (const [k, v] of Object.entries(now.values)) {
      const old = (was.values || {})[k];
      if (v === undefined || v === old) continue;
      if (old === undefined) { fresh = true; continue; }
      changed = true;
      this.bus.send(id, { t: T.PAIR_SYNC, key: k, value: v });
    }
    if (changed || fresh) this._keep(id, now);
  }
}

module.exports = { PairSyncMesh, pairSyncMesh: (o) => new PairSyncMesh(o) };
