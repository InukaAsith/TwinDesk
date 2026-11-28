// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The whole mesh's two-way switches, step 6 of docs/mesh-graph.md (the matrix): every device tells every
// other one (a Pool, relayed, as the layout's displays are) its pairs and who it's connected to, so the
// Multi-device tab can show, for each feature, which device sends it to which: providers in rows,
// receivers in columns.
//
// A cell u → v is on when u sends the feature to v (u's pair with v: out) and v takes it from u (v's pair
// with u: in). Both ends of a pair agree (pair.sync), so one side is enough when the other hasn't said
// (an older TwinDesk publishes nothing: its cells come from what its peers say). This computer's own
// cells are its consent (shared/consent.js), which the page may switch: its row (what it sends) and its
// column (what it takes).
//
//   meshEdges({ bus, mesh, selfId, consent, features, names(id) → name, os(id), connected(id) → bool })
//     features: [{ key: 'clipboard', dirs: { out: true, in: true } }]: the pairs this app has, and which
//               ways it has a switch (a way without one is always on: the Mac takes files with a switch,
//               sends them without)
//     tick()     with every state push: publish ours if it changed (and every minute anyway)
//     view()     { features, devices: [{id, name, os, self, said}], cells: {feature: [{from, to, on, live, why, mine, edit}]} }
//     setCell(from, to, feature, on)  any cell, from any device (REMOTE features): each end's side set where
//                its owner keeps it, ours here, another device's by 'mesh.cell' to that device
//
// A cell between two other devices can be changed here (edit) when both owners accept it: an owner
// accepts changes to its side while its own switch for that way is on (the feature's page's top two
// cards, consent.flat), and never to its pair with the device it has selected (those cards are it).
// Each device says which of its sides are open (`open` in mesh.edges).
'use strict';

const { Pool } = require('./mesh.js');

const TYPE = 'mesh.edges';
const CELL = 'mesh.cell';
const REMOTE = ['notifs']; // the features whose cells any device may change (Notifications › Across devices)
const REPUBLISH_MS = 60000;
const MAX_PEERS = 32;
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

class MeshEdges {
  constructor(o) {
    Object.assign(this, o);
    this.pool = new Pool({ name: 'edges', selfId: this.selfId, peers: () => this._peers() });
    this.by = new Map(); // origin id -> { pairs: {peerId: {feature: {out, in}}}, up: [ids], at }
    this.sentKey = '';
    this.sentAt = 0;
    this.bus.on(TYPE, (m, from) => this._heard(m, from));
    this.bus.on(CELL, (m, from) => this._cell(m, from));
    this.bus.onPeer('welcome', () => { this.sentKey = ''; this.tick(); }); // a device came: it hears ours
  }

  _peers() {
    return this.mesh.peers().filter((e) => e.mesh).map((e) => ({ id: e.id, mesh: true, pool: true, send: (msg) => e.send(msg) }));
  }

  // Our side of a pair with `id`: the consent, a way without a switch is on.
  _mine(id, key, dir) {
    const f = this.features.find((x) => x.key === key);
    if (!f) return undefined;
    return f.dirs[dir] ? !!this.consent.get(id, key, dir) : true;
  }

  _ours() {
    const ids = [...new Set([...this.mesh.known().map((k) => k.id), ...this.bus.connectedIds()])].filter((id) => id !== this.selfId).slice(0, MAX_PEERS);
    const pairs = {};
    for (const id of ids) {
      pairs[id] = {};
      for (const f of this.features) pairs[id][f.key] = { out: this._mine(id, f.key, 'out'), in: this._mine(id, f.key, 'in') };
    }
    return { pairs, up: this.bus.connectedIds().slice(0, MAX_PEERS), open: this._open(), selected: (this.consent.selectedId && this.consent.selectedId()) || '' };
  }

  // Our sides other devices may change: a REMOTE feature's way whose own switch is on here.
  _open() {
    const out = {};
    for (const key of REMOTE) {
      if (!this.features.some((f) => f.key === key) || !this.consent.flat) continue;
      out[key] = { out: this.consent.flat(key, 'out') === true, in: this.consent.flat(key, 'in') === true };
    }
    return out;
  }

  // Another device changes our side of our pair with `peer` (it asked from its grid).
  _cell(m, from) {
    if (!m || typeof m !== 'object' || !REMOTE.includes(m.key) || (m.dir !== 'out' && m.dir !== 'in') || typeof m.on !== 'boolean') return;
    if (typeof m.peer !== 'string' || !m.peer || m.peer.length > 64 || m.peer === this.selfId) return;
    if (!this.bus.connectedIds().includes(from)) return;
    if (this.consent.selectedId && m.peer === this.consent.selectedId()) return; // that pair is the top cards
    if (!(this._open()[m.key] || {})[m.dir]) return; // our switch for that way is off: closed to others
    this.consent.set(m.peer, m.key, m.dir, m.on);
    this.sentKey = '';
    this.tick();
  }

  // Whether u's `dir` side of its pair with v can be set from here.
  _canSet(u, v, key, dir) {
    if (u === this.selfId) return !(this.consent.selectedId && v === this.consent.selectedId()) && !!this.features.find((f) => f.key === key);
    const said = this.by.get(u);
    return !!(said && said.open && said.open[key] && said.open[key][dir]) && this.connected(u)
      && !(said.selected && said.selected === v);
  }

  setCell(from, to, key, on) {
    if (!REMOTE.includes(key) || typeof on !== 'boolean' || from === to) return false;
    const sides = [[from, to, 'out'], [to, from, 'in']];
    // On needs both sides on; off needs one side off (each that can be is).
    const can = sides.filter(([u, v, dir]) => this._canSet(u, v, key, dir));
    if (on ? !sides.every((x) => can.includes(x) || this._side(x[0], x[1], key, x[2]) === true) : !can.length) return false;
    for (const [u, v, dir] of can) {
      if (this._side(u, v, key, dir) === on) continue;
      if (u === this.selfId) this.consent.set(v, key, dir, on);
      else this.bus.send(u, { t: CELL, peer: v, key, dir, on });
    }
    this.sentKey = '';
    this.tick();
    return true;
  }

  tick() {
    const ours = this._ours();
    const key = JSON.stringify(ours);
    if (key === this.sentKey && Date.now() - this.sentAt < REPUBLISH_MS) return;
    this.sentKey = key;
    this.sentAt = Date.now();
    this.pool.publish({ t: TYPE, ...ours });
  }

  _heard(m, from) {
    const r = this.pool.receive(from, m);
    if (!r.fresh || !r.msg || typeof r.msg.o !== 'string' || r.msg.o === this.selfId) return;
    const pairs = {};
    if (m.pairs && typeof m.pairs === 'object') {
      for (const id of Object.keys(m.pairs).slice(0, MAX_PEERS)) {
        const p = m.pairs[id];
        if (!p || typeof p !== 'object') continue;
        pairs[id] = {};
        for (const f of this.features) {
          const v = p[f.key];
          if (v && typeof v === 'object') pairs[id][f.key] = { out: bool(v.out), in: bool(v.in) };
        }
      }
    }
    const up = Array.isArray(m.up) ? m.up.filter((x) => typeof x === 'string').slice(0, MAX_PEERS) : [];
    const open = {};
    for (const key of REMOTE) {
      const o = m.open && m.open[key];
      if (o && typeof o === 'object') open[key] = { out: o.out === true, in: o.in === true };
    }
    const selected = typeof m.selected === 'string' ? m.selected.slice(0, 64) : '';
    this.by.set(r.msg.o, { pairs, up, open, selected, at: Date.now() });
  }

  // u's side of its pair with v for a feature and way: ours, else what u said, else what v said of the
  // other way (both ends agree), else unknown.
  _side(u, v, key, dir) {
    if (u === this.selfId) return this._mine(v, key, dir);
    const said = this.by.get(u);
    const own = said && said.pairs[v] && said.pairs[v][key] && said.pairs[v][key][dir];
    if (typeof own === 'boolean') return own;
    const other = dir === 'out' ? 'in' : 'out';
    if (v === this.selfId) return this._mine(u, key, other);
    const theirs = this.by.get(v);
    const back = theirs && theirs.pairs[u] && theirs.pairs[u][key] && theirs.pairs[u][key][other];
    return typeof back === 'boolean' ? back : undefined;
  }

  _linked(u, v) {
    if (u === this.selfId) return this.connected(v);
    if (v === this.selfId) return this.connected(u);
    const a = this.by.get(u);
    const b = this.by.get(v);
    return !!((a && a.up.includes(v)) || (b && b.up.includes(u)));
  }

  view() {
    const ids = [this.selfId, ...new Set([...this.mesh.known().map((k) => k.id), ...this.by.keys()])].filter((id, i, all) => id && all.indexOf(id) === i).slice(0, MAX_PEERS);
    const devices = ids.map((id) => ({ id, name: id === this.selfId ? this.names(id) : this.names(id) || id.slice(0, 8), os: this.os(id) || '', self: id === this.selfId, said: id === this.selfId || this.by.has(id) }));
    const cells = {};
    for (const f of this.features) {
      cells[f.key] = [];
      for (const u of ids) {
        for (const v of ids) {
          if (u === v) continue;
          const out = this._side(u, v, f.key, 'out');
          const inn = this._side(v, u, f.key, 'in');
          const on = out === true && inn === true;
          const linked = this._linked(u, v);
          const why = out === false ? { key: '{from} doesn’t send it to {to}' } : inn === false ? { key: '{to} doesn’t take it from {from}' }
            : out === undefined || inn === undefined ? { key: 'Not known: {who} runs an older TwinDesk', who: out === undefined ? u : v }
              : !linked ? { key: 'On, not connected now' } : null;
          const mine = u === this.selfId ? 'out' : v === this.selfId ? 'in' : '';
          const sides = [[u, v, 'out'], [v, u, 'in']].map(([a, b, d]) => this._canSet(a, b, f.key, d));
          const edit = !mine && REMOTE.includes(f.key) && (on ? sides.some(Boolean) : sides.every((ok, i) => ok || (i ? inn : out) === true));
          cells[f.key].push({ from: u, to: v, on, live: on && linked, why, mine, ...(REMOTE.includes(f.key) ? { edit } : {}) });
        }
      }
    }
    return { features: this.features.map((f) => f.key), devices, cells };
  }
}

module.exports = { MeshEdges, meshEdges: (o) => new MeshEdges(o) };
