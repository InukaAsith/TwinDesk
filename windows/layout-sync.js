// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The shared layout of the mesh (docs/mesh.md, "Shared layout"): where every device sits relative to
// the others, one map for the whole mesh, edited from any device and synced through its own Pool.
// The rules (place, view, neighbours) are in shared/layout.js; this file holds the stored layout,
// the sync and the person's edits. Plain Node: no Electron.
//
//   bus       hub.bus: on(type, fn(msg, fromId)), onPeer(event, fn(peerId)), send(peerId, msg)
//   mesh      shared/mesh.js Mesh (its peers are the pool's view; only mesh-capable ones get the layout)
//   selfId    this device's id
//   storage   { get() -> the stored layout (or null), set(layout) } : settings.layout
//   knownIds  () -> ids of the devices the layout is drawn for (the paired ones)
//   legacyEdges  optional () -> { left, right, top, bottom } : settings.kvm.edges, used once when no
//                layout is stored yet
//   onChange  () -> the layout changed (stored or seen)
'use strict';

const L = require('../shared/layout.js');
const { Pool } = require('../shared/mesh.js');

const TYPE = 'layout'; // the message: { t: 'layout', layout }

// A layout from a device, when it is well formed: a real edit (rev >= 1), at least one device, and
// every entry a valid cell. One bad entry makes the whole message ignored.
function accept(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = L.normalize(raw);
  const given = raw.cells && typeof raw.cells === 'object' && !Array.isArray(raw.cells) ? Object.keys(raw.cells).length : -1;
  const kept = Object.keys(n.cells).length;
  if (n.rev < 1 || kept < 1 || kept !== given) return null;
  return n;
}

class LayoutSync {
  constructor(opts) {
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.selfId = opts.selfId;
    this.storage = opts.storage;
    this.knownIds = opts.knownIds;
    this.onChange = opts.onChange || (() => {});
    this.pool = new Pool({ name: 'layout', selfId: this.selfId, peers: () => this._peers() });

    const stored = L.normalize(this.storage.get());
    this.layout = stored;
    if (stored.rev === 0 && opts.legacyEdges) {
      const edges = opts.legacyEdges();
      if (edges && Object.values(edges).some(Boolean)) {
        this.layout = L.fromEdges(this.selfId, edges);
        this.storage.set(this.layout);
      }
    }

    this.bus.on(TYPE, (m, from) => this._onLayout(m, from));
    this.bus.onPeer('welcome', (id) => this._onWelcome(id));
  }

  // The stored layout (plain data, a copy). rev 0 = nothing edited yet.
  get() {
    return this.layout.rev > 0 ? L.normalize(this.layout) : null;
  }

  // The layout as this device draws it now: the stored one for the devices that are known.
  view() {
    return L.view(this.layout, this._known());
  }

  // What the edges of device id (default: this device) lead to: { left, right, top, bottom }.
  neighbors(id = this.selfId) {
    return L.neighbors(this.view(), id);
  }

  // The device a pointer reaches when it leaves `id` through `side`, or null.
  across(side, id = this.selfId) {
    return L.across(this.view(), id, side);
  }

  // The side of `fromId` that leads to `toId`, or null.
  sideTo(toId, fromId = this.selfId) {
    return L.sideTo(this.view(), fromId, toId);
  }

  // Plain data for the editor: rev, who edited last, the cells shown and the grid to draw.
  state() {
    const v = this.view();
    return { rev: this.layout.rev, by: this.layout.by, cells: v.cells, grid: L.grid(v) };
  }

  // A person's edit: device id goes to cell (x, y); a device that was there moves to id's old cell.
  place(id, x, y) {
    if (!this._isKnown(id)) return false;
    const r = L.place(this.view(), id, x, y, this.selfId);
    if (!r.ok) return false;
    this._commit(r.layout);
    return true;
  }

  // A person's edit: take device id off the layout. A device that is forgotten still has its cell
  // until this runs, so it can be taken off.
  remove(id) {
    if (typeof id !== 'string' || !id || !this.layout.cells[id]) return false;
    const base = L.view(this.layout, [...this._known(), id]);
    this._commit(L.remove(base, id, this.selfId));
    return true;
  }

  _commit(layout) {
    this.layout = L.normalize(layout);
    this.storage.set(this.get());
    this._publish();
    this.onChange();
  }

  _adopt(layout) {
    this.layout = layout;
    this.storage.set(this.get());
    this.onChange();
  }

  _known() {
    const ids = [this.selfId, ...(this.knownIds() || [])].filter((x) => typeof x === 'string' && x);
    return ids;
  }

  _isKnown(id) {
    return typeof id === 'string' && id.length > 0 && this._known().includes(id);
  }

  // The pool's view of the mesh: the devices that speak the mesh (an old one-to-one app has no layout).
  _peers() {
    return this.mesh.peers().filter((e) => e.mesh).map((e) => ({ id: e.id, mesh: true, pool: true, send: (msg) => e.send(msg) }));
  }

  _publish() {
    this.pool.publish({ t: TYPE, layout: this.get() || L.empty() });
  }

  _onLayout(m, from) {
    const r = this.pool.receive(from, m);
    if (!r.fresh) return;
    const incoming = accept(m.layout);
    if (!incoming || !L.newer(incoming, this.layout)) return;
    this._adopt(incoming);
  }

  // A device came up: it gets our layout (so a late joiner converges). Nothing to send before an edit.
  _onWelcome(id) {
    const e = this.mesh.get(id);
    if (!e || !e.mesh || this.layout.rev < 1) return;
    this._publish();
  }
}

module.exports = LayoutSync;
