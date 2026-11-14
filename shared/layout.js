// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// TwinDesk shared layout: where every device sits relative to the others, one map for the whole
// mesh (docs/mesh.md, "Shared layout"). Pure JavaScript, no I/O, the same file on every platform
// that runs JS; the Kotlin app keeps a copy of the rules it needs.
//
// A layout is { rev, by, cells: { [deviceId]: { x, y } } }: every device holds one cell of an
// integer grid. The neighbour of a device on a side is the nearest device on the same row (left,
// right) or column (top, bottom): that is what its screen edge leads to. The same layout is on
// every device, so the same arrangement is seen wherever it is edited.
//
// Only a person's edit changes a stored layout (`place`, `remove`: rev + 1, `by` = the editing
// device). A device that appeared or went away after the last edit is handled by `view()`, which
// is computed the same way on every device from the same layout and the same set of known device
// ids, and is never stored or sent: that way devices cannot ping-pong automatic changes.
//
// No empty space between devices: the devices are one piece, each touching another by a side (a
// corner is not a way through: an edge only leads to a side). A device goes only next to another
// one (`targets`), and a part that came loose (a device moved away or taken off from between
// others) slides back until it touches the rest (`pack`), as screens do in display settings.
//
// world (#225, optional): where each device's monitors really sit, { [id]: { x, y } } in one plane
// (shared/layout-world.js). Once someone arranged the monitors, the edges follow it (where the
// monitors touch) and the grid is kept only for older apps, which drop `world`; a layout without it
// gets its world from the grid.
'use strict';

const World = require('./layout-world.js');

const SIDES = ['left', 'right', 'top', 'bottom'];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const LIMIT = 64; // |x| and |y| stay within this (untrusted input)
const MAX_CELLS = 10; // P.MAX_DEVICES plus this device

const isCoord = (n) => Number.isInteger(n) && Math.abs(n) <= LIMIT;

function empty() {
  return { rev: 0, by: '', cells: {} };
}

// The world of an untrusted layout, only for devices that have a cell; null when it has none.
function worldOf(value, cells) {
  if (!value || typeof value !== 'object' || !value.world) return null;
  const w = World.normalize(value.world);
  for (const id of Object.keys(w)) if (!cells[id]) delete w[id];
  return Object.keys(w).length ? w : null;
}

// An untrusted value (from a message or settings.json) made into a valid layout: unknown fields,
// bad coordinates and two devices on one cell are dropped (the smaller id keeps the cell).
function normalize(value) {
  const out = empty();
  if (!value || typeof value !== 'object') return out;
  if (Number.isInteger(value.rev) && value.rev >= 0 && value.rev < 2 ** 40) out.rev = value.rev;
  if (typeof value.by === 'string') out.by = value.by.slice(0, 64);
  const src = value.cells && typeof value.cells === 'object' && !Array.isArray(value.cells) ? value.cells : {};
  const taken = new Set();
  for (const id of Object.keys(src).sort()) {
    const c = src[id];
    if (!id || id.length > 64 || !c || !isCoord(c.x) || !isCoord(c.y)) continue;
    const key = `${c.x},${c.y}`;
    if (taken.has(key) || Object.keys(out.cells).length >= MAX_CELLS) continue;
    taken.add(key);
    out.cells[id] = { x: c.x, y: c.y };
  }
  const world = worldOf(value, out.cells);
  if (world) out.world = world;
  if (value.skip === false) out.skip = false; // offline computers stop the pointer (true, the default: it passes them)
  return out;
}

// The layout's own switches, carried by every edit: { skip: false } or {}.
const flags = (l) => (l && l.skip === false ? { skip: false } : {});

// A person's edit: pass offline computers (on, the default) or stop at them.
function setSkip(layout, on, by) {
  const l = normalize(layout);
  if ((l.skip !== false) === !!on) return { ok: false, layout: l };
  const { skip, ...rest } = l;
  return { ok: true, layout: { ...rest, rev: l.rev + 1, by: by || '', ...(on ? {} : { skip: false }) } };
}

// A stable string of a layout: equal layouts give equal strings (dedupe, tie-break, tests).
function canonical(layout) {
  const l = normalize(layout);
  const cells = Object.keys(l.cells).sort().map((id) => `${id}:${l.cells[id].x},${l.cells[id].y}`);
  const world = l.world ? Object.keys(l.world).sort().map((id) => `${id}:${l.world[id].x},${l.world[id].y}`) : [];
  return `${l.rev}|${l.by}|${cells.join(';')}${world.length ? '|' + world.join(';') : ''}${l.skip === false ? '|noskip' : ''}`;
}

// True when a is newer than b: the higher rev wins; at the same rev the larger `by`, then the
// larger canonical string, so every device picks the same one.
function newer(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x.rev !== y.rev) return x.rev > y.rev;
  if (x.by !== y.by) return x.by > y.by;
  return canonical(x) > canonical(y);
}

// The layout two devices agree on: the newer one.
function merge(a, b) {
  return newer(b, a) ? normalize(b) : normalize(a);
}

// The device ids on a row / column, sorted along it.
function line(layout, id, horizontal) {
  const me = layout.cells[id];
  if (!me) return [];
  return Object.keys(layout.cells)
    .filter((k) => (horizontal ? layout.cells[k].y === me.y : layout.cells[k].x === me.x))
    .sort((p, q) => (horizontal ? layout.cells[p].x - layout.cells[q].x : layout.cells[p].y - layout.cells[q].y));
}

// What each screen edge of device id leads to: { left, right, top, bottom }, device id or null.
function neighbors(layout, id) {
  const l = normalize(layout);
  const out = { left: null, right: null, top: null, bottom: null };
  if (!l.cells[id]) return out;
  const row = line(l, id, true);
  const col = line(l, id, false);
  const ri = row.indexOf(id);
  const ci = col.indexOf(id);
  out.left = ri > 0 ? row[ri - 1] : null;
  out.right = ri < row.length - 1 ? row[ri + 1] : null;
  out.top = ci > 0 ? col[ci - 1] : null;
  out.bottom = ci < col.length - 1 ? col[ci + 1] : null;
  return out;
}

// The device a pointer reaches when it leaves `fromId` through `side`, or null.
function across(layout, fromId, side) {
  return SIDES.includes(side) ? neighbors(layout, fromId)[side] : null;
}

// The side of `fromId` that leads to `toId` (adjacent in the layout), or null.
function sideTo(layout, fromId, toId) {
  const n = neighbors(layout, fromId);
  return SIDES.find((s) => n[s] === toId) || null;
}

function freeCell(layout, x, y) {
  return !Object.values(layout.cells).some((c) => c.x === x && c.y === y);
}

const STEPS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const touch = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

// The devices in one piece (each touching another by a side), largest piece first; at the same
// size the piece with the smallest id first. Each piece is an array of ids, sorted.
function pieces(cells) {
  const left = new Set(Object.keys(cells));
  const out = [];
  for (const start of Object.keys(cells).sort()) {
    if (!left.has(start)) continue;
    left.delete(start);
    const piece = [start];
    for (let i = 0; i < piece.length; i++) {
      for (const k of [...left]) {
        if (touch(cells[piece[i]], cells[k])) {
          left.delete(k);
          piece.push(k);
        }
      }
    }
    out.push(piece.sort());
  }
  return out.sort((p, q) => q.length - p.length || (p[0] < q[0] ? -1 : 1));
}

// The same cells with no empty space between devices: while there is more than one piece, the
// next piece moves the shortest way (sideways first) until it touches the first one without
// covering a device. keep: a device whose piece stays where it is (the one a person just put
// down); otherwise the largest piece stays. Deterministic, so every device gets the same.
function pack(cells, keep) {
  const out = {};
  for (const id of Object.keys(cells)) out[id] = { ...cells[id] };
  for (let round = 0; round < MAX_CELLS; round++) {
    const ps = pieces(out);
    if (ps.length < 2) break;
    const kept = keep && out[keep] ? ps.findIndex((p) => p.includes(keep)) : 0;
    const main = ps[kept];
    const loose = ps.find((p, i) => i !== kept);
    const fixed = Object.keys(out).filter((k) => !loose.includes(k));
    let best = null;
    for (let d = 1; d <= 4 * LIMIT && !best; d++) {
      const moves = [];
      for (let dx = -d; dx <= d; dx++) {
        const r = d - Math.abs(dx);
        moves.push([dx, r]);
        if (r) moves.push([dx, -r]);
      }
      moves.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || a[0] - b[0] || a[1] - b[1]);
      for (const [dx, dy] of moves) {
        const moved = loose.map((k) => ({ x: out[k].x + dx, y: out[k].y + dy }));
        if (moved.some((c) => !isCoord(c.x) || !isCoord(c.y))) continue;
        if (moved.some((c) => fixed.some((k) => out[k].x === c.x && out[k].y === c.y))) continue;
        if (!moved.some((c) => main.some((k) => touch(c, out[k])))) continue;
        best = [dx, dy];
        break;
      }
    }
    if (!best) break; // cannot happen within the limits; leave it as it is
    for (const k of loose) out[k] = { x: out[k].x + best[0], y: out[k].y + best[1] };
  }
  return out;
}

// True when the devices are one piece (no empty space between them).
function joined(layout) {
  return pieces(normalize(layout).cells).length < 2;
}

// The empty cells device id may be put on: next to another device by a side. A device on its own
// may go anywhere (an empty list: nothing to be next to). Sorted by row, then column.
function targets(layout, id) {
  const l = normalize(layout);
  const others = Object.keys(l.cells).filter((k) => k !== id);
  const seen = new Set();
  const out = [];
  for (const k of others) {
    for (const [dx, dy] of STEPS) {
      const x = l.cells[k].x + dx;
      const y = l.cells[k].y + dy;
      const key = `${x},${y}`;
      if (seen.has(key) || !isCoord(x) || !isCoord(y) || !freeCell(l, x, y)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

// The layout as every device computes it for the same set of known ids: devices that are gone
// are dropped, new ones are put at the right of row 0 (of the top row when row 0 is empty), in
// id order, and a part left apart by a device that is gone slides back (`pack`). Not stored, not
// sent. `ids` should hold every device of the mesh including this one.
function view(layout, ids) {
  const l = normalize(layout);
  const known = new Set(ids);
  const out = { rev: l.rev, by: l.by, cells: {} };
  if (l.world) out.world = { ...l.world };
  if (l.skip === false) out.skip = false;
  for (const id of Object.keys(l.cells)) if (known.has(id)) out.cells[id] = { ...l.cells[id] };
  for (const id of [...known].sort()) {
    if (out.cells[id] || Object.keys(out.cells).length >= MAX_CELLS) continue;
    const all = Object.values(out.cells);
    const row = all.some((c) => c.y === 0) || !all.length ? 0 : Math.min(...all.map((c) => c.y));
    const xs = all.filter((c) => c.y === row).map((c) => c.x);
    let x = xs.length ? Math.max(...xs) + 1 : 0;
    while (!freeCell(out, x, row)) x += 1;
    if (x > LIMIT) continue;
    out.cells[id] = { x, y: row };
  }
  out.cells = pack(out.cells);
  return out;
}

// A person's edit: put device id at cell (x, y). An occupied cell is swapped (the other device
// takes the cell `id` left, when it had one). An empty cell must be next to another device
// (`targets`); what came loose from the others slides back to them. Returns { ok, layout } (not
// ok: coordinates invalid, or an empty cell that touches no other device, a corner included).
function place(layout, id, x, y, by) {
  if (!id || !isCoord(x) || !isCoord(y)) return { ok: false, layout: normalize(layout) };
  const l = normalize(layout);
  const cells = { ...l.cells };
  const old = cells[id];
  const other = Object.keys(cells).find((k) => k !== id && cells[k].x === x && cells[k].y === y);
  if (other) {
    if (old) cells[other] = { x: old.x, y: old.y };
    else {
      let nx = x + 1;
      while (Object.values(cells).some((c) => c.x === nx && c.y === y)) nx += 1;
      cells[other] = { x: nx, y };
    }
  } else if (!old && Object.keys(cells).length >= MAX_CELLS) return { ok: false, layout: l };
  else if (!(old && old.x === x && old.y === y) && Object.keys(cells).some((k) => k !== id)
    && !targets(l, id).some((c) => c.x === x && c.y === y)) {
    return { ok: false, layout: l };
  }
  cells[id] = { x, y };
  return { ok: true, layout: { rev: l.rev + 1, by: by || '', cells: pack(cells, id), ...(l.world ? { world: { ...l.world } } : {}), ...flags(l) } };
}

// A person's edit on the monitor map (#225): the monitors of each device where `world` puts them (the
// whole map as the editor shows it, so the devices it placed from the grid keep their place too). Only
// devices with a cell; the grid stays for older apps.
function arrange(layout, world, by) {
  const l = normalize(layout);
  const w = World.normalize(world);
  for (const id of Object.keys(w)) if (!l.cells[id]) delete w[id];
  if (!Object.keys(w).length) return { ok: false, layout: l };
  return { ok: true, layout: { rev: l.rev + 1, by: by || '', cells: { ...l.cells }, world: w, ...flags(l) } };
}

// A person's edit: take device id off the map; the devices on either side of it close up.
function remove(layout, id, by) {
  const l = normalize(layout);
  if (!l.cells[id]) return l;
  const cells = { ...l.cells };
  delete cells[id];
  const out = { rev: l.rev + 1, by: by || '', cells: pack(cells), ...flags(l) };
  if (l.world) {
    const world = { ...l.world };
    delete world[id];
    if (Object.keys(world).length) out.world = world;
  }
  return out;
}

// The old per-device edges ({left, right, top, bottom}: device id) as a layout: this device in the
// middle, each of those devices on its side. For migrating settings.kvm.edges.
function fromEdges(selfId, edges) {
  const out = { rev: 1, by: selfId, cells: { [selfId]: { x: 0, y: 0 } } };
  const at = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  for (const side of SIDES) {
    const id = edges && typeof edges[side] === 'string' ? edges[side] : null;
    if (id && id !== selfId && !out.cells[id]) out.cells[id] = { x: at[side][0], y: at[side][1] };
  }
  return out;
}

// For the editor: the grid's bounds with one empty ring around it, and the cells.
function grid(layout) {
  const l = normalize(layout);
  const ids = Object.keys(l.cells);
  const xs = ids.map((i) => l.cells[i].x);
  const ys = ids.map((i) => l.cells[i].y);
  const minX = (xs.length ? Math.min(...xs) : 0) - 1;
  const maxX = (xs.length ? Math.max(...xs) : 0) + 1;
  const minY = (ys.length ? Math.min(...ys) : 0) - 1;
  const maxY = (ys.length ? Math.max(...ys) : 0) + 1;
  return { minX, maxX, minY, maxY, cells: ids.sort().map((id) => ({ id, x: l.cells[id].x, y: l.cells[id].y })) };
}

// An edit made on a view (`place`, `remove` on view(stored, known)) keeps the devices of the stored
// layout that the editing device doesn't know (it never saw them, so it can't mean to take them
// off): each goes back on its stored cell when that cell is still free. One whose cell was taken is
// left out, and the devices that know it put it back at the end of the first row (`view`).
function keepUnknown(edited, stored, known) {
  const e = normalize(edited);
  const s = normalize(stored);
  const ids = new Set(known);
  const cells = { ...e.cells };
  const world = e.world ? { ...e.world } : null;
  for (const id of Object.keys(s.cells).sort()) {
    if (ids.has(id) || cells[id] || Object.keys(cells).length >= MAX_CELLS) continue;
    if (freeCell({ cells }, s.cells[id].x, s.cells[id].y)) {
      cells[id] = { ...s.cells[id] };
      if (world && s.world && s.world[id] && !world[id]) world[id] = { ...s.world[id] };
    }
  }
  return { rev: e.rev, by: e.by, cells, ...(world ? { world } : {}), ...flags(e) };
}

// Which devices the mouse and keyboard of device selfId reach by crossing screen edges (docs/mesh.md,
// "Chains"). selfId takes every device of a chain itself, so a device is reached when it is next to a
// reached one by a side and selfId can drive it (`canDrive(id)`: connected to selfId); the chain goes
// on past it unless it ends chains (`endsChain(id)`: a phone). Returns { [id]: state }: 'self',
// 'reached', 'blocked' (next to a reached device, but selfId can't drive it: the pointer stops
// before it) or 'behind' (only past a blocked device, or not joined to selfId at all).
function reach(layout, selfId, canDrive, endsChain = () => false) {
  const l = normalize(layout);
  const out = {};
  if (!l.cells[selfId]) return out;
  for (const id of Object.keys(l.cells)) out[id] = 'behind';
  out[selfId] = 'self';
  const queue = [selfId];
  while (queue.length) {
    const id = queue.shift();
    if (id !== selfId && endsChain(id)) continue;
    const n = neighbors(l, id);
    for (const side of SIDES) {
      const to = n[side];
      if (!to || out[to] !== 'behind') continue;
      if (canDrive(to)) {
        out[to] = 'reached';
        queue.push(to);
      } else out[to] = 'blocked';
    }
  }
  return out;
}

module.exports = {
  SIDES, OPPOSITE, empty, normalize, canonical, newer, merge, neighbors, across, sideTo, view, place, arrange, remove, fromEdges, grid,
  pieces, pack, joined, targets, reach, keepUnknown, setSkip,
};
