// Tests for shared/screen-mesh.js: display model, placement and the per-target stream table.
// Run with: node shared/test/screen-mesh.js
'use strict';

const assert = require('assert');
const S = require('../screen-mesh.js');

// This PC as the user has it: primary 2560x1440 at (0,0), two monitors at x = -1920.
const PC = [
  { id: 'a', name: 'DELL 1', x: 0, y: 0, w: 2560, h: 1440, scale: 1, primary: true },
  { id: 'b', name: 'LG 1', x: -1920, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
  { id: 'c', name: 'LG 2', x: -1920, y: 1080, w: 1920, h: 1080, scale: 1, primary: false },
];

// ---- normalizeDisplays: untrusted reports ----
{
  assert.deepStrictEqual(S.normalizeDisplays(null), []);
  assert.deepStrictEqual(S.normalizeDisplays('x'), []);
  const n = S.normalizeDisplays([
    ...PC,
    { id: 'a', x: 5, y: 5, w: 100, h: 100 }, // duplicate id: dropped
    { id: 'e', x: 1.5, y: 0, w: 100, h: 100 }, // not an integer
    { id: 'f', x: 0, y: 0, w: 4, h: 100 }, // too small
    { id: 'g', x: 0, y: 0, w: 100, h: 100, scale: 9 }, // scale out of range: 1
    { id: '', x: 0, y: 0, w: 100, h: 100 },
    null,
  ]);
  assert.deepStrictEqual(n.map((d) => d.id), ['a', 'b', 'c', 'g']);
  assert.strictEqual(n[3].scale, 1);
  assert.strictEqual(n[1].x, -1920, 'negative positions are normal');
  assert.strictEqual(n.filter((d) => d.primary).length, 1);
  assert.strictEqual(n[0].primary, true);
  // no primary marked: the display at (0,0) is primary
  const np = S.normalizeDisplays([{ id: 'x', x: -10, y: 0, w: 100, h: 100 }, { id: 'y', x: 0, y: 0, w: 100, h: 100 }]);
  assert.deepStrictEqual(np.map((d) => d.primary), [false, true]);
  // at most MAX_DISPLAYS
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'd' + i, x: i * 100, y: 0, w: 100, h: 100 }));
  assert.strictEqual(S.normalizeDisplays(many).length, S.MAX_DISPLAYS);
  // a numeric id is accepted as text
  assert.strictEqual(S.normalizeDisplays([{ id: 3, x: 0, y: 0, w: 100, h: 100 }])[0].id, '3');
}

// ---- bounds and arrange: the page draws the OS arrangement ----
{
  assert.strictEqual(S.bounds([]), null);
  assert.deepStrictEqual(S.bounds(PC), { x: -1920, y: 0, w: 4480, h: 2160 });
  const boxes = S.arrange(PC, { w: 448, h: 216 });
  assert.strictEqual(boxes.length, 3);
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
  // one scale for all: the tighter of (448 - 8) / 4480 and (216 - 8) / 2160
  const k = Math.min(440 / 4480, 208 / 2160);
  assert.strictEqual(byId.a.w, Math.round(2560 * k));
  assert.strictEqual(byId.a.h, Math.round(1440 * k));
  assert.ok(byId.b.x >= 0 && byId.a.x > byId.b.x + byId.b.w - 1, 'primary sits right of the two monitors');
  assert.ok(byId.c.y > byId.b.y, 'the lower-left monitor is below the upper one');
  // boxes do not overlap each other
  for (const p of boxes) for (const q of boxes) if (p !== q) assert.ok(!S.overlaps(p, q), 'boxes must not overlap');
  // a wide view centres the arrangement vertically
  const wide = S.arrange(PC, { w: 1000, h: 1000 });
  assert.ok(Math.min(...wide.map((b) => b.y)) >= 0 && Math.max(...wide.map((b) => b.y + b.h)) <= 1000);
  assert.deepStrictEqual(S.arrange([], { w: 10, h: 10 }), []);
}

// ---- place: a new virtual display next to an existing one ----
{
  const size = { w: 1280, h: 720 };
  // right of the primary, top edges aligned
  assert.deepStrictEqual(S.place(PC, 'a', 'right', size), { x: 2560, y: 0, w: 1280, h: 720 });
  // left of the left-most monitor (x = -1920): goes to x = -3200
  assert.deepStrictEqual(S.place(PC, 'b', 'left', size), { x: -3200, y: 0, w: 1280, h: 720 });
  // above the primary: bottom edge on the primary's top (y = -720)
  assert.deepStrictEqual(S.place(PC, 'a', 'top', size), { x: 0, y: -720, w: 1280, h: 720 });
  // below the lower-left monitor, left edges aligned
  assert.deepStrictEqual(S.place(PC, 'c', 'bottom', size), { x: -1920, y: 2160, w: 1280, h: 720 });
  // occupied spot: left of the primary would overlap the LG monitors
  assert.strictEqual(S.place(PC, 'a', 'left', size), null, 'overlaps the monitors on the left');
  // unknown anchor, bad side, bad size
  assert.strictEqual(S.place(PC, 'zz', 'right', size), null);
  assert.strictEqual(S.place(PC, 'a', 'diagonal', size), null);
  assert.strictEqual(S.place(PC, 'a', 'right', { w: 1.5, h: 720 }), null);
  assert.strictEqual(S.place(PC, 'a', 'right', { w: 1, h: 720 }), null, 'too small');
}

// ---- nudge: slide along the edge ----
{
  const r = S.place(PC, 'a', 'right', { w: 1280, h: 720 });
  assert.deepStrictEqual(S.nudge(PC, 'a', 'right', r, 100), { ...r, y: 100 });
  assert.strictEqual(S.nudge(PC, 'a', 'right', r, 1.5), null);
  // slid into the anchor's column next to nothing else: fine; far off the range: refused
  assert.strictEqual(S.nudge(PC, 'a', 'right', r, 50000), null);
  // a top placement slides along x
  const t = S.place(PC, 'a', 'top', { w: 1280, h: 720 });
  assert.deepStrictEqual(S.nudge(PC, 'a', 'top', t, -200), { ...t, x: -200 });
}

// ---- stream table: each connected device gets its own choice ----
{
  const known = ['b', 'c', 'phone', 'mac'];
  // the Mac gets display 'a' (mirror), the phone gets a virtual display, 'c' gets nothing
  let r = S.setChoice({}, 'mac', { mode: 'mirror', displayId: 'a' }, ['mac', 'phone'], PC);
  assert.ok(r.ok, r.error);
  r = S.setChoice(r.table, 'phone', { mode: 'virtual', size: { w: 1920, h: 1080 } }, ['mac', 'phone'], PC);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(S.streams(r.table, ['mac', 'phone'], PC), [
    { deviceId: 'mac', mode: 'mirror', displayId: 'a' },
    { deviceId: 'phone', mode: 'virtual', size: { w: 1920, h: 1080 } },
  ]);
  // none removes the entry
  r = S.setChoice(r.table, 'mac', { mode: 'none' }, ['mac', 'phone'], PC);
  assert.deepStrictEqual(Object.keys(r.table), ['phone']);
  // a second virtual display is refused: one adapter per computer
  const v = S.setChoice(r.table, 'mac', { mode: 'virtual', size: { w: 800, h: 600 } }, ['mac', 'phone'], PC);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.error, 'virtual-limit');
  // a display that this PC does not have is refused
  const bad = S.setChoice({}, 'mac', { mode: 'mirror', displayId: 'nope' }, ['mac'], PC);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'display');
  // a device that is not connected cannot be given a stream
  assert.strictEqual(S.setChoice({}, 'gone', { mode: 'all' }, ['mac'], PC).error, 'device');
  // 'all' is the whole arrangement and needs no display id
  assert.deepStrictEqual(S.setChoice({}, 'mac', { mode: 'all' }, ['mac'], PC).table, { mac: { mode: 'all' } });
  // unknown mode
  assert.strictEqual(S.setChoice({}, 'mac', { mode: 'steal' }, ['mac'], PC).error, 'mode');
}

// ---- streams: devices that went away are dropped, never contacted ----
{
  const table = {
    mac: { mode: 'mirror', displayId: 'a' },
    gone: { mode: 'all' },
    phone: { mode: 'virtual', size: { w: 800, h: 600 } },
  };
  assert.deepStrictEqual(S.streams(table, ['mac', 'phone'], PC).map((s) => s.deviceId), ['mac', 'phone']);
  // a mirror whose display went away (unplugged) is dropped too
  const unplugged = PC.filter((d) => d.id !== 'a');
  assert.deepStrictEqual(S.streams(table, ['mac', 'phone'], unplugged).map((s) => s.deviceId), ['phone']);
  // two virtual choices in a stored table: the second one is dropped
  const twoVirtual = { p1: { mode: 'virtual', size: { w: 800, h: 600 } }, p2: { mode: 'virtual', size: { w: 800, h: 600 } } };
  assert.deepStrictEqual(S.streams(twoVirtual, ['p1', 'p2'], PC).map((s) => s.deviceId), ['p1']);
  assert.deepStrictEqual(S.streams(null, ['p1'], PC), []);
}

// ---- the pure module stays pure: no I/O, no globals ----
{
  const { MAX_DEVICES } = S;
  const full = {};
  for (let i = 0; i < MAX_DEVICES; i++) full['d' + i] = { mode: 'all' };
  const ids = Object.keys(full);
  assert.strictEqual(S.streams(full, ids, PC).length, MAX_DEVICES);
  assert.strictEqual(S.setChoice(full, 'd-new', { mode: 'all' }, ids, PC).error, 'device', 'not in knownIds');
  assert.strictEqual(S.setChoice(full, 'd-new', { mode: 'all' }, [...ids, 'd-new'], PC).error, 'full', 'ten targets already');
  assert.strictEqual(S.setChoice(full, 'd0', { mode: 'all' }, ids, PC).ok, true, 'changing an existing target is always allowed');
}

console.log('screen-mesh: all checks passed');
