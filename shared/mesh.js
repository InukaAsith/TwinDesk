// TwinDesk mesh core. The design is in docs/mesh.md: read it before changing this file.
//
// Pure JavaScript: no I/O, no timers, no dependencies (EventEmitter is built in). The same file is
// required by the Windows, Mac and Linux main processes, and re-implemented by hand in Kotlin for
// Android, so keep it small and keep the tests (shared/test/mesh-*.js) as the executable spec.
//
// Terms used below:
//   origin  the device where a pooled item starts (field `o`)
//   d       the origin's direct links at the moment it published (field `d`)
//   legacy  a peer that does not speak the mesh (`mesh: false`): it gets plain messages, no stamps
'use strict';

const { EventEmitter } = require('events');

const P = require('./protocol.js');

const STAMP_FIELDS = ['o', 's', 'd', 'h'];

// The message as an old app sees it: pool stamps removed. Never mutates its input.
function plain(msg) {
  const out = {};
  for (const k of Object.keys(msg)) {
    if (!STAMP_FIELDS.includes(k)) out[k] = msg[k];
  }
  return out;
}

// Pool: fan-out, dedupe and relay of pooled items (clipboard, notifications).
//
//   new Pool({ name, selfId, peers, seenLimit, maxHops })
//   peers() -> [{ id, mesh, pool, send(msg) -> boolean }]   (currently connected peers)
//     mesh: false  an old app: send it the plain message
//     pool: false  that peer switched the pool off: never send it pool items, never accept them
class Pool {
  constructor(opts) {
    this.name = opts.name;
    this.selfId = opts.selfId;
    this._peers = opts.peers;
    this.seenLimit = opts.seenLimit != null ? opts.seenLimit : P.POOL_SEEN_LIMIT;
    this.maxHops = opts.maxHops != null ? opts.maxHops : P.POOL_MAX_HOPS;
    this._seq = 0; // our own sequence numbers, per pool
    this._legacySeq = new Map(); // origin -> last number given to a legacy item from that peer
    this._seen = new Map(); // origin -> Set of sequence numbers, oldest first (insertion order)
    this._stats = {
      published: 0, received: 0, fresh: 0, droppedEcho: 0, droppedDup: 0, droppedOff: 0, relayed: 0,
    };
  }

  // Stamp a copy of msg as our own item and send it to every pool-capable peer.
  // Returns { msg: stamped copy, sent: ids of the peers whose send() returned true }.
  publish(msg) {
    this._seq += 1;
    const peers = this._peers();
    const stamped = Object.assign({}, plain(msg), {
      o: this.selfId,
      s: this._seq,
      d: peers.map((p) => p.id),
      h: 0,
    });
    this._markSeen(this.selfId, this._seq);
    this._stats.published += 1;
    const sent = [];
    for (const p of peers) {
      if (p.pool === false) continue;
      const ok = p.send(p.mesh ? stamped : plain(msg));
      if (ok) sent.push(p.id);
    }
    return { msg: stamped, sent };
  }

  // Handle an item that arrived from peer fromId.
  // Returns { fresh, msg, relayed }:
  //   fresh    true when the feature must apply the item (first time we see it, not our own)
  //   msg      the stamped message (a legacy item gets its stamp here)
  //   relayed  ids of the peers the item was forwarded to
  receive(fromId, msg) {
    this._stats.received += 1;
    const from = this._peers().find((p) => p.id === fromId);
    if (from && from.pool === false) {
      this._stats.droppedOff += 1;
      return { fresh: false, msg, relayed: [] };
    }

    let m = msg;
    if (m.o === undefined) {
      // A message without stamps comes from an old one-to-one peer, which is the origin of it.
      const s = (this._legacySeq.get(fromId) || 0) + 1;
      this._legacySeq.set(fromId, s);
      m = Object.assign({}, msg, { o: fromId, s, d: [fromId], h: 0 });
    }

    if (m.o === this.selfId) {
      this._stats.droppedEcho += 1;
      return { fresh: false, msg: m, relayed: [] };
    }
    if (this._hasSeen(m.o, m.s)) {
      this._stats.droppedDup += 1;
      return { fresh: false, msg: m, relayed: [] };
    }
    this._markSeen(m.o, m.s);
    this._stats.fresh += 1;

    // Relay. A peer is skipped when it is the sender, the origin, or one of the origin's direct
    // links (it got the item from the origin itself). A hop limit bounds the relay chain: an item
    // whose next hop would be above maxHops is not relayed any further.
    const relayed = [];
    const hops = (m.h || 0) + 1;
    if (hops <= this.maxHops) {
      const out = Object.assign({}, m, { h: hops });
      for (const p of this._peers()) {
        if (p.id === fromId || p.id === m.o || p.id === this.selfId) continue;
        if (p.pool === false) continue;
        if (m.d && m.d.includes(p.id)) continue;
        const ok = p.send(p.mesh ? out : plain(m));
        if (ok) {
          relayed.push(p.id);
          this._stats.relayed += 1;
        }
      }
    }
    return { fresh: true, msg: m, relayed };
  }

  // Counters for tests and debugging (a copy).
  stats() {
    return Object.assign({}, this._stats);
  }

  _hasSeen(origin, seq) {
    const set = this._seen.get(origin);
    return !!set && set.has(seq);
  }

  // Remember (origin, seq). Only the newest seenLimit numbers per origin are kept: the oldest one
  // is evicted when a newer one would make the set larger. So an item is accepted again only after
  // seenLimit newer items from the same origin have been remembered.
  _markSeen(origin, seq) {
    let set = this._seen.get(origin);
    if (!set) {
      set = new Set();
      this._seen.set(origin, set);
    }
    set.add(seq);
    while (set.size > this.seenLimit) {
      set.delete(set.values().next().value);
    }
  }
}

// Roster: who is connected to whom. Each device reports its own direct links (setSelf) and the
// links of its peers (setPeer, from mesh.roster messages).
class Roster {
  constructor({ selfId }) {
    this.selfId = selfId;
    this._links = new Map(); // id -> array of ids
    this._links.set(selfId, []);
  }

  setSelf(ids) {
    this.setPeer(this.selfId, ids);
  }

  setPeer(id, ids) {
    const unique = [];
    for (const x of ids || []) {
      if (!unique.includes(x)) unique.push(x);
    }
    this._links.set(id, unique);
  }

  // Forget a device and remove it from every other device's list.
  remove(id) {
    this._links.delete(id);
    for (const [k, list] of this._links) {
      this._links.set(k, list.filter((x) => x !== id));
    }
  }

  // The direct links of id (a copy), or null when nothing is known about it.
  direct(id) {
    const list = this._links.get(id);
    return list ? list.slice() : null;
  }

  // True when a lists b or b lists a.
  linked(a, b) {
    const la = this._links.get(a) || [];
    const lb = this._links.get(b) || [];
    return la.includes(b) || lb.includes(a);
  }

  snapshot() {
    const out = {};
    for (const [k, list] of this._links) out[k] = list.slice();
    return out;
  }
}

// Mesh: the registry of connected peers. Emits 'peerAdded' (entry), 'peerRemoved' (entry) and
// 'roster' (id, ids) whenever a device's direct links are learned or changed.
class Mesh extends EventEmitter {
  constructor({ selfId }) {
    super();
    this.selfId = selfId;
    this.roster = new Roster({ selfId });
    this._peers = new Map();
    this._pools = new Map();
    this._members = new Map(); // via id -> [{id, name, os}] from that peer's mesh.roster
  }

  // p: { id, name, os, send(msg) -> boolean, mesh (default false), pool (default true) }.
  // Returns false when the id is already there, is ours, or the registry is full (MAX_DEVICES).
  // The returned entry is live: set entry.pool = false to switch a peer's pool off.
  addPeer(p) {
    if (!p || !p.id || p.id === this.selfId || this._peers.has(p.id)) return false;
    if (this._peers.size >= P.MAX_DEVICES) return false;
    const entry = {
      id: p.id,
      name: p.name,
      os: p.os,
      send: p.send,
      mesh: !!p.mesh,
      pool: p.pool !== false,
    };
    this._peers.set(p.id, entry);
    this.roster.setSelf(this.directIds());
    this.emit('peerAdded', entry);
    this.emit('roster', this.selfId, this.directIds());
    return true;
  }

  removePeer(id) {
    const entry = this._peers.get(id);
    if (!entry) return false;
    this._peers.delete(id);
    this._members.delete(id);
    this.roster.remove(id);
    this.roster.setSelf(this.directIds());
    this.emit('peerRemoved', entry);
    this.emit('roster', this.selfId, this.directIds());
    return true;
  }

  get(id) {
    return this._peers.get(id) || null;
  }

  peers() {
    return Array.from(this._peers.values());
  }

  // The pool called name, created on first use (opts are used then, later calls return the same).
  pool(name, opts) {
    if (!this._pools.has(name)) {
      const config = Object.assign({}, opts || {}, {
        name,
        selfId: this.selfId,
        peers: () => this.peers(),
      });
      this._pools.set(name, new Pool(config));
    }
    return this._pools.get(name);
  }

  // Ids of the connected peers: our direct links.
  directIds() {
    return Array.from(this._peers.keys());
  }

  // peers: the direct links; members: their names and systems, so a device that is not linked to
  // them can still list them ("everyone in the mesh", see known()).
  rosterMessage() {
    return {
      t: 'mesh.roster',
      peers: this.directIds(),
      members: this.peers().map((e) => ({ id: e.id, name: e.name || '', os: e.os || '' })),
    };
  }

  // Everyone this device knows of: the direct peers and the peers of its peers (from their
  // mesh.roster `members`), each {id, name, os, direct, via: [ids that report it]}.
  known() {
    const out = new Map();
    for (const e of this._peers.values()) out.set(e.id, { id: e.id, name: e.name || '', os: e.os || '', direct: true, via: [] });
    for (const [via, list] of this._members) {
      if (!this._peers.has(via)) continue;
      for (const m of list) {
        if (m.id === this.selfId) continue;
        const cur = out.get(m.id);
        if (cur) {
          if (!cur.direct) cur.via.push(via);
          if (!cur.name && m.name) cur.name = m.name;
          if (!cur.os && m.os) cur.os = m.os;
        } else {
          out.set(m.id, { id: m.id, name: m.name || '', os: m.os || '', direct: false, via: [via] });
        }
      }
    }
    return Array.from(out.values());
  }

  // Consume a mesh.roster message from fromId. Returns true for any mesh.roster message (so the
  // caller does not treat it as something else); the roster is only updated for a connected peer.
  handle(fromId, msg) {
    if (!msg || msg.t !== 'mesh.roster') return false;
    if (this._peers.has(fromId)) {
      const ids = Array.isArray(msg.peers) ? msg.peers.filter((x) => typeof x === 'string') : [];
      this.roster.setPeer(fromId, ids);
      const members = [];
      for (const m of Array.isArray(msg.members) ? msg.members : []) {
        if (m && typeof m.id === 'string' && m.id) members.push({ id: m.id, name: String(m.name || '').slice(0, 64), os: String(m.os || '').slice(0, 16) });
      }
      this._members.set(fromId, members);
      this.emit('roster', fromId, ids);
    }
    return true;
  }
}

// Keep-alive timing for one link. Busy = selected, driving or driven.
function keepalive({ busy }) {
  return busy
    ? { intervalMs: P.PING_MS, timeoutMs: P.TIMEOUT_MS }
    : { intervalMs: P.IDLE_PING_MS, timeoutMs: P.IDLE_TIMEOUT_MS };
}

module.exports = { Pool, Roster, Mesh, keepalive };
