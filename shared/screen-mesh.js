// TwinDesk screen mesh: the display model of a computer, where a new virtual display goes, and which
// screen each connected device gets (docs/screen-mesh.md). Pure JavaScript, no I/O, the same file on
// every platform that runs JS.
//
// Coordinates are the OS's: the primary display's top-left is (0, 0) and other displays may sit at
// negative x or y (a monitor left of the primary is at x = -1920).
'use strict';

const SIDES = ['left', 'right', 'top', 'bottom'];
const MODES = ['none', 'mirror', 'virtual', 'all'];
const MAX_DISPLAYS = 8;
const MAX_DEVICES = 10; // P.MAX_DEVICES: the targets a table can hold
const VIRTUAL_LIMIT = 1; // one virtual display adapter per computer for now
const POS_LIMIT = 32768;
const MIN_SIZE = 16;
const MAX_SIZE = 16384;

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// An untrusted display report made into a clean list. Bad entries are dropped, duplicate ids keep
// the first, and at most MAX_DISPLAYS are kept. The first valid display marked primary wins; when
// none is marked, the one at (0, 0) is primary.
function normalizeDisplays(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    if (out.length >= MAX_DISPLAYS) break;
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' ? d.id.slice(0, 64) : typeof d.id === 'number' ? String(d.id) : '';
    if (!id || seen.has(id)) continue;
    if (!isInt(d.x, -POS_LIMIT, POS_LIMIT) || !isInt(d.y, -POS_LIMIT, POS_LIMIT)) continue;
    if (!isInt(d.w, MIN_SIZE, MAX_SIZE) || !isInt(d.h, MIN_SIZE, MAX_SIZE)) continue;
    const scale = typeof d.scale === 'number' && d.scale > 0 && d.scale <= 4 ? d.scale : 1;
    seen.add(id);
    out.push({
      id,
      name: typeof d.name === 'string' ? d.name.slice(0, 80) : id,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      scale,
      primary: d.primary === true,
    });
  }
  if (out.length && !out.some((d) => d.primary)) {
    const origin = out.find((d) => d.x === 0 && d.y === 0);
    (origin || out[0]).primary = true;
  }
  return out;
}

// The rectangle every display covers together: { x, y, w, h }. Empty list: null.
function bounds(displays) {
  if (!displays.length) return null;
  const x0 = Math.min(...displays.map((d) => d.x));
  const y0 = Math.min(...displays.map((d) => d.y));
  const x1 = Math.max(...displays.map((d) => d.x + d.w));
  const y1 = Math.max(...displays.map((d) => d.y + d.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Boxes for the page: every display as a rectangle inside a view of `box` pixels ({ w, h }), with
// the same uniform scale for all of them so the arrangement keeps its proportions, and the whole
// arrangement centred. Returns [{ id, x, y, w, h, primary }] in the input order.
function arrange(displays, box) {
  const b = bounds(displays);
  if (!b) return [];
  const k = Math.min((box.w - 8) / b.w, (box.h - 8) / b.h);
  const offX = (box.w - b.w * k) / 2;
  const offY = (box.h - b.h * k) / 2;
  return displays.map((d) => ({
    id: d.id,
    x: Math.round(offX + (d.x - b.x) * k),
    y: Math.round(offY + (d.y - b.y) * k),
    w: Math.max(1, Math.round(d.w * k)),
    h: Math.max(1, Math.round(d.h * k)),
    primary: d.primary,
  }));
}

// True when two rectangles share area (touching edges do not count).
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Where a new display of `size` ({ w, h }) goes on `side` of display `anchorId`, aligned to the
// anchor's near edge like the OS does by default (top edges line up for left and right, left edges
// for top and bottom). Returns { x, y, w, h } or null when the anchor is unknown, the side is wrong,
// the size is out of range, or the spot would overlap a display that is already there.
function place(displays, anchorId, side, size) {
  const anchor = displays.find((d) => d.id === anchorId);
  if (!anchor || !SIDES.includes(side)) return null;
  if (!isInt(size && size.w, MIN_SIZE, MAX_SIZE) || !isInt(size && size.h, MIN_SIZE, MAX_SIZE)) return null;
  const { w, h } = size;
  let rect;
  if (side === 'left') rect = { x: anchor.x - w, y: anchor.y, w, h };
  else if (side === 'right') rect = { x: anchor.x + anchor.w, y: anchor.y, w, h };
  else if (side === 'top') rect = { x: anchor.x, y: anchor.y - h, w, h };
  else rect = { x: anchor.x, y: anchor.y + anchor.h, w, h };
  if (!isInt(rect.x, -POS_LIMIT, POS_LIMIT) || !isInt(rect.y, -POS_LIMIT, POS_LIMIT)) return null;
  return displays.some((d) => overlaps(rect, d)) ? null : rect;
}

// Move a placed rectangle along its edge by `offset` pixels (positive: down for left/right, right
// for top/bottom). Returns the moved rectangle or null when it would overlap or leave the range.
function nudge(displays, anchorId, side, rect, offset) {
  if (!Number.isInteger(offset) || Math.abs(offset) > POS_LIMIT) return null;
  const moved = side === 'left' || side === 'right' ? { ...rect, y: rect.y + offset } : { ...rect, x: rect.x + offset };
  if (!isInt(moved.x, -POS_LIMIT, POS_LIMIT) || !isInt(moved.y, -POS_LIMIT, POS_LIMIT)) return null;
  const others = displays.filter((d) => d.id !== anchorId);
  return others.some((d) => overlaps(moved, d)) ? null : moved;
}

// The choices one device can make for its target. `choice` is { mode, displayId?, size? }. Returns
// { ok, choice, error } where choice is the normalised value; error names the reason.
function validChoice(choice, displays, virtualCount) {
  if (!choice || typeof choice !== 'object' || !MODES.includes(choice.mode)) return { ok: false, error: 'mode' };
  if (choice.mode === 'none') return { ok: true, choice: { mode: 'none' } };
  if (choice.mode === 'all') return { ok: true, choice: { mode: 'all' } };
  if (choice.mode === 'mirror') {
    const d = displays.find((x) => x.id === choice.displayId);
    return d ? { ok: true, choice: { mode: 'mirror', displayId: d.id } } : { ok: false, error: 'display' };
  }
  // virtual
  if (virtualCount >= VIRTUAL_LIMIT) return { ok: false, error: 'virtual-limit' };
  if (!isInt(choice.size && choice.size.w, MIN_SIZE, MAX_SIZE) || !isInt(choice.size && choice.size.h, MIN_SIZE, MAX_SIZE)) {
    return { ok: false, error: 'size' };
  }
  return { ok: true, choice: { mode: 'virtual', size: { w: choice.size.w, h: choice.size.h } } };
}

// The stream table: what each connected device gets from this computer.
// table: { [deviceId]: choice }. Returns a new table holding only the devices in knownIds, with
// `displays` and the virtual count applied. Devices that are gone are dropped (not an error).
function prune(table, knownIds, displays) {
  const known = new Set(knownIds);
  const out = {};
  let virtuals = 0;
  for (const id of Object.keys(table || {}).sort()) {
    if (!known.has(id) || Object.keys(out).length >= MAX_DEVICES) continue;
    const r = validChoice(table[id], displays, virtuals);
    if (!r.ok) continue;
    if (r.choice.mode === 'virtual') virtuals += 1;
    out[id] = r.choice;
  }
  return out;
}

// Set one device's choice. Returns { ok, table, error }. Choosing 'none' removes the entry.
function setChoice(table, deviceId, choice, knownIds, displays) {
  if (!knownIds.includes(deviceId)) return { ok: false, table: prune(table, knownIds, displays), error: 'device' };
  const rest = { ...(table || {}) };
  delete rest[deviceId];
  const others = prune(rest, knownIds, displays);
  const virtuals = Object.values(others).filter((c) => c.mode === 'virtual').length;
  const r = validChoice(choice, displays, virtuals);
  if (!r.ok) return { ok: false, table: prune(table, knownIds, displays), error: r.error };
  if (r.choice.mode === 'none') return { ok: true, table: others };
  if (Object.keys(others).length >= MAX_DEVICES) return { ok: false, table: others, error: 'full' };
  return { ok: true, table: { ...others, [deviceId]: r.choice } };
}

// The streams to run now, in device id order: [{ deviceId, mode, displayId?, size? }]. Devices with
// no stream are not in the list, so they are never contacted.
function streams(table, knownIds, displays) {
  const t = prune(table, knownIds, displays);
  return Object.keys(t).sort().map((deviceId) => ({ deviceId, ...t[deviceId] }));
}

module.exports = {
  SIDES, MODES, MAX_DISPLAYS, MAX_DEVICES, VIRTUAL_LIMIT,
  normalizeDisplays, bounds, arrange, overlaps, place, nudge, validChoice, prune, setChoice, streams,
};
