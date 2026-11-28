// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: one graph per service (docs/mesh-graph.md). An edge `u → v` is u providing the service to
// v (u's sound plays on v). Every pair is a candidate; an edge is allowed when both devices can do it and
// the switches say yes, and active when the service's limits keep it. resolve() is a pure function of
// what it's given, so every device that knows the same things comes out with the same edges.
// Step 1 runs it in shadow (mesh-shadow.js): it changes nothing.
'use strict';

const COMPUTERS = ['mac', 'win', 'linux'];
const PHONES = ['android', 'ios'];
const ALL = [...COMPUTERS, ...PHONES];

// Each service's routing, the only place it's written. from/to: the kinds of device that may provide and
// take it; perOut: active edges one provider keeps; perIn: active edges one receiver takes.
// cursor: its own model (the pointer is one token on the layout, docs/mesh.md); listed for the docs only.
const SERVICES = {
  sound: { label: 'Sound', from: ALL, to: ALL, perOut: 6, perIn: Infinity },
  mic: { label: 'Microphone', from: ALL, to: COMPUTERS, perOut: 1, perIn: 1 },
  camera: { label: 'Camera', from: ALL, to: COMPUTERS, perOut: 1, perIn: 1 },
  screen: { label: 'Screen', from: ALL, to: ALL, perOut: 4, perIn: Infinity },
  clipboard: { label: 'Clipboard', from: ALL, to: ALL, perOut: Infinity, perIn: Infinity },
  notifs: { label: 'Notifications', from: ALL, to: ALL, perOut: Infinity, perIn: Infinity },
  files: { label: 'Files', from: ALL, to: ALL, perOut: Infinity, perIn: Infinity },
  terminal: { label: 'Terminal', from: COMPUTERS, to: COMPUTERS, perOut: Infinity, perIn: 1 },
  phone: { label: 'Phone', from: PHONES, to: COMPUTERS, perOut: 1, perIn: 1 },
  cursor: { label: 'Cursor', own: true },
};

// The order device x prefers the candidates in (docs/mesh-graph.md, Pruning): pinned, the input peer,
// the selection, then the id, so that ties come out the same everywhere.
function rankKey(g, x, c, svc) {
  const pin = g.pin ? g.pin(x, svc) : null;
  return [c === pin ? 0 : 1, c === (g.inputPeer ? g.inputPeer(x) : null) ? 0 : 1, c === (g.selected ? g.selected(x) : null) ? 0 : 1, String(c)];
}

function byRank(g, x, svc) {
  return (a, b) => {
    const ka = rankKey(g, x, a, svc), kb = rankKey(g, x, b, svc);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
}

// The edges of one service. g: {
//   nodes: [{id, os, name}],
//   allowed(svc, from, to) → true, or why not (a sentence),
//   inputPeer(id), selected(id), pin(id, svc) → a device id or null (each device's own),
//   from: only this provider's edges (a device knows its own rows), optional }.
// → [{svc, from, to, stage: 'candidate' | 'allowed' | 'active', reason}], sorted by from, then to.
function resolve(svc, g) {
  const s = SERVICES[svc];
  if (!s || s.own) throw new Error('no graph for ' + svc);
  const nodes = (g.nodes || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = (id) => (byId.get(id) && byId.get(id).name) || id;
  const edges = [];
  for (const u of nodes) {
    if (g.from && u.id !== g.from) continue;
    const mine = [];
    for (const v of nodes) {
      if (v.id === u.id) continue;
      const e = { svc, from: u.id, to: v.id, stage: 'candidate', reason: '' };
      if (!s.from.includes(u.os)) e.reason = `${name(u.id)} can't give it`;
      else if (!s.to.includes(v.os)) e.reason = `${name(v.id)} can't take it`;
      else {
        const a = g.allowed ? g.allowed(svc, u.id, v.id) : true;
        if (a === true) e.stage = 'allowed';
        else e.reason = String(a || 'off');
      }
      edges.push(e);
      if (e.stage === 'allowed') mine.push(e);
    }
    // The provider keeps its best perOut.
    mine.sort((a, b) => byRank(g, u.id, svc)(a.to, b.to));
    mine.forEach((e, i) => {
      if (i < s.perOut) e.stage = 'active';
      else e.reason = `${s.label} from ${name(u.id)} goes to ${mine.slice(0, s.perOut).map((k) => name(k.to)).join(', ')}`;
    });
  }
  // Each receiver takes its best perIn of what was kept for it.
  if (Number.isFinite(s.perIn)) {
    for (const v of nodes) {
      const into = edges.filter((e) => e.to === v.id && e.stage === 'active');
      into.sort((a, b) => byRank(g, v.id, svc)(a.from, b.from));
      into.forEach((e, i) => {
        if (i < s.perIn) return;
        e.stage = 'allowed';
        e.reason = `${name(v.id)} takes ${s.label.toLowerCase()} from ${into.slice(0, s.perIn).map((k) => name(k.from)).join(', ')}`;
      });
    }
  }
  return edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
}

// The input peer (docs/mesh-graph.md): the device whose mouse last reached this computer, or the one this
// computer's mouse last went to. A new one counts after dwellMs (a pointer passing through doesn't move
// sound and the mic); the pointer coming home doesn't clear it; take() counts at once (a click).
class InputPeer {
  constructor({ dwellMs = 2000 } = {}) {
    this.dwellMs = dwellMs;
    this.id = null;
    this.why = '';
    this.pending = null; // {id, since, why}
  }

  // kvm mode ('home' | 'driving' | 'driven') and partner, at time t. True when the input peer changed.
  note(mode, partner, t) {
    if (mode === 'home' || !partner) {
      this.pending = null;
      return false;
    }
    const why = mode === 'driven' ? 'it drives this computer' : 'this computer drives it';
    if (partner === this.id) {
      this.pending = null;
      this.why = why;
      return false;
    }
    if (!this.pending || this.pending.id !== partner) {
      this.pending = { id: partner, since: t, why };
      if (this.dwellMs > 0) return false;
    }
    if (t - this.pending.since < this.dwellMs) return false;
    return this.take(partner, why);
  }

  take(id, why) {
    this.pending = null;
    if (id === this.id) return false;
    this.id = id || null;
    this.why = why || '';
    return true;
  }

  // A device that left: it's no longer the input peer.
  forget(id) {
    if (this.pending && this.pending.id === id) this.pending = null;
    if (id && id === this.id) return this.take(null, '');
    return false;
  }
}

module.exports = { SERVICES, COMPUTERS, PHONES, resolve, InputPeer };
