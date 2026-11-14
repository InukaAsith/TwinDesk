// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The shared layout of the mesh on this Mac (docs/mesh.md, "Shared layout"): the same file as
// windows/layout-sync.js, with the same behaviour and API. The rules (place, view, neighbours) are in
// shared/layout.js; this file holds the stored layout, the sync and the person's edits. Plain Node.
//
//   bus       hub.bus: on(type, fn(msg, fromId)), onPeer(event, fn(peerId)), send(peerId, msg)
//   mesh      shared/mesh.js Mesh (its peers are the pool's view; only mesh-capable ones get the layout)
//   selfId    this device's id
//   storage   { get() -> the stored layout (or null), set(layout) } : settings.layout
//   knownIds  () -> ids of the devices the layout is drawn for (the paired ones and those known
//             through them, so every device draws the same map and an edit keeps them all)
//   canDrive  optional (id) -> this device can drive it (connected): the editor's reach
//   endsChain optional (id) -> a chain stops at it (a phone)
//   online    optional (id) -> it is in the mesh now (connected here or through another device): the
//             monitor map's crossings pass through an offline device (shared/layout-world.js, #225)
//   myDisplays optional () -> this device's displays (shared/screen-mesh.js normalizeDisplays), sent
//             to every device (layout.displays) so each can draw everyone's monitors and cross by them
//   displaysStorage optional { get() -> { id: displays }, set(map) }: the others' monitors, kept for
//             when they are offline
//   legacyEdges  optional () -> { left, right, top, bottom } : settings.kvm.edges, used once when no
//                layout is stored yet
//   onChange  () -> the layout changed (stored or seen)
'use strict';

const L = require('../../shared/layout.js');
const W = require('../../shared/layout-world.js');
const { Pool } = require('../../shared/mesh.js');
const { normalizeDisplays } = require('../../shared/screen-mesh.js');

const TYPE = 'layout'; // the message: { t: 'layout', layout }
const DISPLAYS = 'layout.displays'; // { t, displays }: the sender's (pool origin `o`) monitors

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
    this.canDrive = opts.canDrive || (() => true);
    this.endsChain = opts.endsChain || (() => false);
    this.online = opts.online || (() => true);
    this.myDisplays = opts.myDisplays || (() => []);
    this.displaysStorage = opts.displaysStorage || null;
    this.onChange = opts.onChange || (() => {});
    this.pool = new Pool({ name: 'layout', selfId: this.selfId, peers: () => this._peers() });
    this.dpool = new Pool({ name: 'displays', selfId: this.selfId, peers: () => this._peers() });
    this.displays = {};
    const kept = this.displaysStorage ? this.displaysStorage.get() : null;
    if (kept && typeof kept === 'object') {
      for (const id of Object.keys(kept).slice(0, 64)) {
        const list = normalizeDisplays(kept[id]);
        if (id && id !== this.selfId && list.length) this.displays[id] = list;
      }
    }

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
    this.bus.on(DISPLAYS, (m, from) => this._onDisplays(m, from));
    this.bus.onPeer('welcome', (id) => this._onWelcome(id));
  }

  // ---- the monitor map (#225, shared/layout-world.js) ----

  // Every device's displays: ours now, the others' as they sent them (none: a usual screen).
  allDisplays() {
    return { ...this.displays, [this.selfId]: normalizeDisplays(this.myDisplays()) };
  }

  // Our displays changed (plugged, turned, scaled): every device gets them.
  displaysChanged() {
    this._publishDisplays();
    this.onChange();
  }

  _publishDisplays() {
    this.dpool.publish({ t: DISPLAYS, displays: normalizeDisplays(this.myDisplays()) });
  }

  _onDisplays(m, from) {
    const r = this.dpool.receive(from, m);
    if (!r.fresh || !r.msg || typeof r.msg.o !== 'string' || r.msg.o === this.selfId) return;
    const list = normalizeDisplays(m.displays);
    const id = r.msg.o;
    if (JSON.stringify(this.displays[id] || []) === JSON.stringify(list)) return;
    if (list.length) this.displays[id] = list;
    else delete this.displays[id];
    if (this.displaysStorage) this.displaysStorage.set({ ...this.displays });
    this.onChange();
  }

  _isPhone(id) {
    return id !== this.selfId && !!this.endsChain(id);
  }

  _present(id) {
    return id === this.selfId || !!this.online(id);
  }

  // The plane as it is now: the arranged world, or the one from the grid, for every known device.
  world() {
    const v = this.view();
    const ids = Object.keys(v.cells), displays = this.allDisplays(), phone = (id) => this._isPhone(id);
    // In one piece, no gaps, phones as leaves (#225); worked out again only when something changed.
    const key = JSON.stringify([v.world || null, v.cells, displays, ids.filter(phone)]);
    if (!this._worldMemo || this._worldMemo.key !== key) {
      this._worldMemo = { key, world: W.settle(W.complete(v.world, v.cells, displays, ids, phone), displays, ids, phone) };
    }
    const out = {};
    for (const id of Object.keys(this._worldMemo.world)) out[id] = { ...this._worldMemo.world[id] }; // a copy: move() edits it
    return out;
  }

  // Where the edges of device id lead: { left: [{ from, to, dev, … }], … } (shared/layout-world.js).
  stretches(id = this.selfId) {
    const v = this.view();
    const ids = Object.keys(v.cells);
    if (!ids.includes(id)) return { left: [], right: [], top: [], bottom: [] };
    return W.stretches(this.world(), this.allDisplays(), ids, id, (x) => this._present(x), (x) => this._isPhone(x), this.skips());
  }

  // For the helper: the sides with somewhere to go, and the zones along them (only where monitors touch).
  // only(dev): leave out stretches to devices it says no to (not connected, paused…).
  edgeConfig(only = () => true, id = this.selfId) {
    const all = this.stretches(id);
    const st = {};
    for (const side of W.SIDES) st[side] = all[side].filter((x) => only(x.dev));
    return { sides: W.sidesOf(st), zones: W.zonesText(this.world(), this.allDisplays(), id, st, (x) => this._isPhone(x)) };
  }

  // A crossing: device fromId's pointer left through `side` at `offset` (0–1, its helper's). { to, offset }
  // (the device, and where along its facing side the pointer comes in) or null.
  cross(side, offset, fromId = this.selfId) {
    const v = this.view();
    const ids = Object.keys(v.cells);
    if (!ids.includes(fromId)) return null;
    return W.cross(this.world(), this.allDisplays(), ids, fromId, side, offset, (x) => this._present(x), (x) => this._isPhone(x), this.skips());
  }

  // A person's edit on the monitor map: device id dropped with its top-left at (x, y) in the plane;
  // it goes where it may (off the others, touching one, aligned within `snap`). Returns where it went.
  move(id, x, y, snap) {
    if (!this._isKnown(id) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const world = this.world();
    const ids = Object.keys(world);
    const at = W.drop(world, this.allDisplays(), ids, id, x, y, Number.isFinite(snap) ? snap : 60, (k) => this._isPhone(k));
    Object.assign(world, W.settle({ ...world, [id]: at }, this.allDisplays(), ids, (k) => this._isPhone(k), id)); // the rest close up around it
    const r = L.arrange(this.view(), world, this.selfId);
    if (!r.ok) return null;
    this._commit(L.keepUnknown(r.layout, this.layout, this._known()));
    return at;
  }

  // Offline computers: passed through (on, the default) or the pointer stops at them (the Multi-device
  // tab's switch; in the layout, so every device follows the same rule).
  skips() {
    return this.layout.skip !== false;
  }

  setSkip(on) {
    const r = L.setSkip(this.layout, on, this.selfId);
    if (!r.ok) return false;
    this._commit(r.layout);
    return true;
  }

  // Back to the grid's arrangement: the world goes (the edges follow the grid again).
  resetWorld() {
    if (!this.layout.world) return false;
    const { world, ...rest } = L.normalize(this.layout);
    this._commit({ ...rest, rev: this.layout.rev + 1, by: this.selfId });
    return true;
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
  // From the monitor map (#225): on each side, the device with the longest stretch there (an offline
  // one passed through to the next). Where along the side matters: cross().
  neighbors(id = this.selfId) {
    const st = this.stretches(id);
    const out = { left: null, right: null, top: null, bottom: null };
    for (const side of W.SIDES) {
      const len = {};
      for (const x of st[side]) len[x.dev] = (len[x.dev] || 0) + (x.to - x.from);
      const best = Object.keys(len).sort((a, b) => len[b] - len[a] || (a < b ? -1 : 1))[0];
      out[side] = best || null;
    }
    return out;
  }

  // The device a pointer reaches when it leaves `id` through `side`, or null (the longest stretch).
  across(side, id = this.selfId) {
    return W.SIDES.includes(side) ? this.neighbors(id)[side] : null;
  }

  // The side of `fromId` that leads to `toId`, or null (the one with the longest stretch to it).
  sideTo(toId, fromId = this.selfId) {
    const st = this.stretches(fromId);
    let best = null, most = 0;
    for (const side of W.SIDES) {
      const len = st[side].filter((x) => x.dev === toId).reduce((n, x) => n + (x.to - x.from), 0);
      if (len > most) { most = len; best = side; }
    }
    return best;
  }

  // Plain data for the editor: rev, who edited last, the cells shown, the grid to draw and, per
  // device, the empty cells it may be put on ("x,y": next to another device, shared/layout.js) and
  // whether this device's mouse gets there (reach: self, reached, blocked, behind; L.reach).
  state() {
    const v = this.view();
    const targets = {};
    for (const id of Object.keys(v.cells)) targets[id] = L.targets(v, id).map((c) => c.x + ',' + c.y);
    const reach = L.reach(v, this.selfId, (id) => this.canDrive(id), (id) => this.endsChain(id));
    // The monitor map (#225): every device's monitors in the plane, and where each edge of ours leads.
    const world = this.world();
    const ids = Object.keys(world);
    const monitors = W.placed(world, this.allDisplays(), ids, (id) => this._isPhone(id));
    const online = {};
    for (const id of ids) online[id] = this._present(id);
    const st = this.stretches();
    const edges = [];
    for (const side of W.SIDES) for (const x of st[side]) edges.push({ side, from: x.from, to: x.to, at: x.at, dev: x.dev, gap: x.gap });
    // Red on the map: wherever a computer that isn't connected stops the pointer of one that is (ours
    // or another's edge: the mesh line it cuts), each piece once.
    const blocked = [], seen = new Set();
    for (const id of ids) {
      if (!this._present(id) || this._isPhone(id)) continue;
      for (const b of (id === this.selfId ? st : this.stretches(id)).blocked || []) {
        const k = [b.side, b.at, b.from, b.to].join();
        if (!seen.has(k)) { seen.add(k); blocked.push({ ...b, by: id }); }
      }
    }
    return { rev: this.layout.rev, by: this.layout.by, cells: v.cells, grid: L.grid(v), targets, reach,
      map: { arranged: !!this.layout.world, skip: this.skips(), world, monitors, online, edges, blocked, phones: ids.filter((id) => this._isPhone(id)) } };
  }

  // A person's edit: device id goes to cell (x, y); a device that was there moves to id's old cell.
  place(id, x, y) {
    if (!this._isKnown(id)) return false;
    const r = L.place(this.view(), id, x, y, this.selfId);
    if (!r.ok) return false;
    this._commit(L.keepUnknown(r.layout, this.layout, this._known())); // devices only others know stay on it
    return true;
  }

  // A person's edit: take device id off the layout. A device that is forgotten still has its cell
  // until this runs, so it can be taken off.
  remove(id) {
    if (typeof id !== 'string' || !id || !this.layout.cells[id]) return false;
    const base = L.view(this.layout, [...this._known(), id]);
    this._commit(L.keepUnknown(L.remove(base, id, this.selfId), this.layout, [...this._known(), id]));
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

  // A device came up: it gets our layout (so a late joiner converges; nothing to send before an edit)
  // and our monitors.
  _onWelcome(id) {
    const e = this.mesh.get(id);
    if (!e || !e.mesh) return;
    this._publishDisplays();
    if (this.layout.rev < 1) return;
    this._publish();
  }
}

module.exports = LayoutSync;
