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
'use strict';

const SIDES = ['left', 'right', 'top', 'bottom'];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const LIMIT = 64; // |x| and |y| stay within this (untrusted input)
const MAX_CELLS = 10; // P.MAX_DEVICES plus this device

const isCoord = (n) => Number.isInteger(n) && Math.abs(n) <= LIMIT;

function empty() {
  return { rev: 0, by: '', cells: {} };
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
  return out;
}

// A stable string of a layout: equal layouts give equal strings (dedupe, tie-break, tests).
function canonical(layout) {
  const l = normalize(layout);
  const cells = Object.keys(l.cells).sort().map((id) => `${id}:${l.cells[id].x},${l.cells[id].y}`);
  return `${l.rev}|${l.by}|${cells.join(';')}`;
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

// The layout as every device computes it for the same set of known ids: devices that are gone
// are dropped, new ones are put at the right of row 0, in id order. Not stored, not sent. `ids`
// should hold every device of the mesh including this one.
function view(layout, ids) {
  const l = normalize(layout);
  const known = new Set(ids);
  const out = { rev: l.rev, by: l.by, cells: {} };
  for (const id of Object.keys(l.cells)) if (known.has(id)) out.cells[id] = { ...l.cells[id] };
  for (const id of [...known].sort()) {
    if (out.cells[id] || Object.keys(out.cells).length >= MAX_CELLS) continue;
    const xs = Object.values(out.cells).filter((c) => c.y === 0).map((c) => c.x);
    let x = xs.length ? Math.max(...xs) + 1 : 0;
    while (!freeCell(out, x, 0)) x += 1;
    if (x > LIMIT) continue;
    out.cells[id] = { x, y: 0 };
  }
  return out;
}

// A person's edit: put device id at cell (x, y). An occupied cell is swapped (the other device
// takes the cell `id` left, when it had one). Returns { ok, layout } (not ok: coordinates invalid).
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
  cells[id] = { x, y };
  return { ok: true, layout: { rev: l.rev + 1, by: by || '', cells } };
}

// A person's edit: take device id off the map.
function remove(layout, id, by) {
  const l = normalize(layout);
  if (!l.cells[id]) return l;
  const cells = { ...l.cells };
  delete cells[id];
  return { rev: l.rev + 1, by: by || '', cells };
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

module.exports = {
  SIDES, OPPOSITE, empty, normalize, canonical, newer, merge, neighbors, across, sideTo, view, place, remove, fromEdges, grid,
};
