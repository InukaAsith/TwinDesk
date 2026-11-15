// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/layout-world.js: the mesh's monitor map (#225). Run: node shared/test/layout-world.js
'use strict';
const assert = require('assert');
const W = require('../layout-world.js');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// The desk of #225: a PC with three monitors in a row, a laptop standing on its left (portrait), a
// laptop lying above the third monitor, and one more laptop at the right.
const displays = {
  pc: [{ id: '1', x: 0, y: 0, w: 1920, h: 1080 }, { id: '2', x: 1920, y: 0, w: 1920, h: 1080 }, { id: '3', x: 3840, y: 0, w: 1920, h: 1080 }],
  tall: [{ id: 'a', x: 0, y: 0, w: 1080, h: 1920 }],
  top: [{ id: 'b', x: 0, y: 0, w: 1440, h: 900 }],
  mac: [{ id: 'm', x: 0, y: 0, w: 1512, h: 982 }],
};
const ids = ['pc', 'tall', 'top', 'mac'];
const world = { pc: { x: 0, y: 0 }, tall: { x: -1080, y: -420 }, top: { x: 4080, y: -900 }, mac: { x: 5760, y: 0 } };

{
  const st = W.stretches(world, displays, ids, 'pc');
  assert.deepStrictEqual(st.top.map((s) => [s.dev, s.from, s.to]), [['top', 4080, 5520]], 'up: only over the third monitor');
  assert.deepStrictEqual(st.left.map((s) => [s.dev, s.from, s.to]), [['tall', 0, 1080]], 'left: the portrait laptop');
  assert.deepStrictEqual(st.right.map((s) => [s.dev, s.from, s.to]), [['mac', 0, 982]]);
  assert.deepStrictEqual(st.bottom, []);
  // From the first monitor up, nothing: the helper's zones leave that part of the top out (the bug of #225).
  const z = W.zonesText(world, displays, 'pc', st);
  assert.strictEqual(z, 'left:0.0000-1.0000,right:0.0000-0.9093,top:0.7083-0.9583', z);
}
{
  // Crossing keeps the place along the edge.
  const r = W.cross(world, displays, ids, 'pc', 'top', (4080 + 720) / 5760);
  assert.strictEqual(r.to, 'top');
  assert.ok(near(r.offset, 0.5), JSON.stringify(r));
  const back = W.cross(world, displays, ids, 'top', 'bottom', 0.5);
  assert.strictEqual(back.to, 'pc');
  assert.ok(near(back.offset, (4080 + 720) / 5760), JSON.stringify(back));
  // Off the stretch (rounding at its end): the nearest stretch, clamped into it.
  const off = W.cross(world, displays, ids, 'pc', 'top', 0.99);
  assert.strictEqual(off.to, 'top');
  // The portrait laptop: from its right edge, only where the PC is beside it.
  const t = W.stretches(world, displays, ids, 'tall');
  assert.deepStrictEqual(t.right.map((s) => [s.dev, s.from, s.to]), [['pc', 0, 1080]], 'not across the empty space to the laptop far up right');
}
{
  // A chain A | B | C: with B offline, A's right leads to C, and C's left to A; B back, as before.
  const d = { A: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], B: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], C: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }] };
  const w = { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 }, C: { x: 2000, y: 0 } };
  const all = ['A', 'B', 'C'];
  assert.strictEqual(W.cross(w, d, all, 'A', 'right', 0.5).to, 'B');
  const noB = (id) => id !== 'B';
  assert.strictEqual(W.cross(w, d, all, 'A', 'right', 0.5, noB).to, 'C');
  assert.strictEqual(W.cross(w, d, all, 'C', 'left', 0.5, noB).to, 'A');
  assert.strictEqual(W.zonesText(w, d, 'A', W.stretches(w, d, all, 'A', noB)), 'right:0.0000-1.0000');
  assert.deepStrictEqual(W.sidesOf(W.stretches(w, d, all, 'A', (id) => id === 'A')), [], 'alone: nowhere to go');
  assert.strictEqual(W.zonesText(w, d, 'A', W.stretches(w, d, all, 'A', (id) => id === 'A')), 'none');
}
{
  // Inner edges don't cross: two monitors on top of each other, a device beside only the lower one.
  const d = { pc: [{ id: '1', x: 0, y: 0, w: 1000, h: 500 }, { id: '2', x: 0, y: 500, w: 1000, h: 500 }], x: [{ id: '1', x: 0, y: 0, w: 400, h: 300 }] };
  const w = { pc: { x: 0, y: 0 }, x: { x: 1000, y: 600 } };
  const st = W.stretches(w, d, ['pc', 'x'], 'pc');
  assert.deepStrictEqual(st.right.map((s) => [s.dev, s.display, s.from, s.to]), [['x', '1', 600, 900]]);
  assert.deepStrictEqual(st.bottom, [], 'nothing below');
}
{
  // The grid of shared/layout.js as a world: a row, the middle of each cell.
  const w = W.fromCells({ pc: { x: 0, y: 0 }, mac: { x: 1, y: 0 }, phone: { x: 2, y: 0 } }, displays, (id) => id === 'phone');
  assert.deepStrictEqual(w.pc, { x: 0, y: 0 });
  assert.deepStrictEqual(w.mac, { x: 5760, y: 49 });
  assert.strictEqual(w.phone.x, 5760 + 1512);
  assert.strictEqual(W.cross(w, displays, ['pc', 'mac', 'phone'], 'pc', 'right', 0.5, undefined, (id) => id === 'phone').to, 'mac');
  // complete(): a stored world keeps its places; a device not in it goes to the right of everything.
  const c = W.complete({ pc: { x: 0, y: 0 } }, {}, displays, ['pc', 'mac'], () => false);
  assert.deepStrictEqual(c.mac, { x: 5760, y: 0 });
  const g = W.complete(null, { pc: { x: 0, y: 0 }, mac: { x: 0, y: 1 } }, displays, ['pc', 'mac']);
  assert.deepStrictEqual(g.mac, { x: 0, y: 1080 }, 'under it, from its left edge');
  assert.strictEqual(W.cross(g, displays, ['pc', 'mac'], 'pc', 'bottom', 0.1).to, 'mac');
}
{
  // Dropping: off the others, touching, aligned.
  const d = { pc: [{ id: '1', x: 0, y: 0, w: 1920, h: 1080 }], lap: [{ id: '1', x: 0, y: 0, w: 1440, h: 900 }] };
  const w = { pc: { x: 0, y: 0 }, lap: { x: 0, y: 0 } };
  assert.deepStrictEqual(W.drop(w, d, ['pc', 'lap'], 'lap', 1500, 30), { x: 1920, y: 0 }, 'pushed out to the right, top edges aligned');
  assert.deepStrictEqual(W.drop(w, d, ['pc', 'lap'], 'lap', 2400, 500), { x: 1920, y: 500 }, 'a gap closed');
  assert.deepStrictEqual(W.drop(w, d, ['pc', 'lap'], 'lap', 3000, -2000), { x: 1920 - 40, y: -900 }, 'far at a corner: slid to touch by MIN_TOUCH');
  assert.deepStrictEqual(W.drop(w, d, ['pc', 'lap'], 'lap', 260, -950), { x: 240, y: -900 }, 'above, centred within snap');
  const only = W.drop({ lap: { x: 5, y: 5 } }, d, ['lap'], 'lap', 77, 88);
  assert.deepStrictEqual(only, { x: 77, y: 88 }, 'alone: anywhere');
}
{
  // settle(): one piece, no holes, no overlaps.
  const d = { A: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], B: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], C: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }] };
  const all = ['A', 'B', 'C'];
  const one = (w) => W.groupsOf(w, d, all).length === 1;
  const noOverlap = (w) => { const m = W.placed(w, d, all); return m.every((a, i) => m.every((b, j) => i === j || Math.min(a.x + a.w, b.x + b.w) <= Math.max(a.x, b.x) || Math.min(a.y + a.h, b.y + b.h) <= Math.max(a.y, b.y))); };
  // Already one piece: nothing moves.
  const row = { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 }, C: { x: 2000, y: 0 } };
  assert.deepStrictEqual(W.settle(row, d, all), row);
  // B dragged out of the middle, onto A's top: C closes up to the others.
  const out = W.settle({ ...row, B: { x: 0, y: -800 } }, d, all, undefined, 'B');
  assert.ok(one(out) && noOverlap(out), JSON.stringify(out));
  assert.deepStrictEqual(out.B, { x: 0, y: -800 }, 'the dragged one stays');
  assert.deepStrictEqual(out.C, { x: 1000, y: 0 }, 'C beside A, where B was');
  // Islands far apart (the screenshot of #225's map): one piece.
  const islands = W.settle({ A: { x: 0, y: 0 }, B: { x: 9000, y: 300 }, C: { x: 20000, y: -500 } }, d, all);
  assert.ok(one(islands) && noOverlap(islands), JSON.stringify(islands));
  // A device whose real monitors came in bigger than the usual screen: off the one it now covers.
  const big = { ...d, A: [{ id: '1', x: 0, y: 0, w: 2560, h: 1440 }] };
  const grown = W.settle(row, big, all);
  assert.ok(W.groupsOf(grown, big, all).length === 1, JSON.stringify(grown));
  const m = W.placed(grown, big, all);
  assert.ok(m.every((a, i) => m.every((b, j) => i === j || Math.min(a.x + a.w, b.x + b.w) <= Math.max(a.x, b.x) || Math.min(a.y + a.h, b.y + b.h) <= Math.max(a.y, b.y))), JSON.stringify(grown));
  // The same on every device: the order ids come in doesn't matter.
  assert.deepStrictEqual(W.settle({ A: { x: 0, y: 0 }, B: { x: 9000, y: 300 }, C: { x: 20000, y: -500 } }, d, ['C', 'A', 'B']), islands);
}
{
  // Phones are leaves: never between two computers, never against another phone.
  const d = { A: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], B: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], p: [], q: [] };
  const phone = (id) => id === 'p' || id === 'q';
  const all = ['A', 'B', 'p', 'q'];
  const touching = (w, id) => { const m = W.placed(w, d, all, phone); const mine = m.filter((x) => x.dev === id); return [...new Set(m.filter((o) => o.dev !== id && mine.some((a) => (Math.min(a.y + a.h, o.y + o.h) - Math.max(a.y, o.y) >= 1 && (Math.abs(a.x + a.w - o.x) < 1 || Math.abs(o.x + o.w - a.x) < 1)) || (Math.min(a.x + a.w, o.x + o.w) - Math.max(a.x, o.x) >= 1 && (Math.abs(a.y + a.h - o.y) < 1 || Math.abs(o.y + o.h - a.y) < 1)))).map((o) => o.dev))].sort(); };
  // A phone dropped in the gap between A and B (it was A | p | B): B joins A, the phone goes outside.
  const w = W.settle({ A: { x: 0, y: 0 }, p: { x: 1000, y: 0 }, B: { x: 1412, y: 0 }, q: { x: 2412, y: 0 } }, d, all, phone);
  assert.deepStrictEqual(touching(w, 'A'), ['B', ...touching(w, 'A').filter((x) => x !== 'B')], 'the computers touch: ' + JSON.stringify(w));
  assert.strictEqual(touching(w, 'p').length, 1, 'p on one computer: ' + JSON.stringify(w));
  assert.strictEqual(touching(w, 'q').length, 1, 'q on one computer: ' + JSON.stringify(w));
  assert.ok(!phone(touching(w, 'p')[0]) && !phone(touching(w, 'q')[0]));
  // Dropping a phone right between them: it lands beside one of them, touching that one only.
  const row = { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 } };
  const at = W.drop(row, d, ['A', 'B', 'p'], 'p', 900, 0, 60, phone);
  assert.strictEqual(touching({ ...row, p: at }, 'p').length, 1, JSON.stringify(at));
}
{
  // An offline computer in the way: passed (skip on), or a red piece where it stops the pointer.
  const d = { A: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], B: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }], C: [{ id: '1', x: 0, y: 0, w: 1000, h: 800 }] };
  const w = { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 }, C: { x: 2000, y: 0 } };
  const all = ['A', 'B', 'C'];
  const noB = (id) => id !== 'B';
  const on = W.stretches(w, d, all, 'A', noB);
  assert.strictEqual(on.right[0].dev, 'C');
  assert.deepStrictEqual(on.blocked, []);
  const off = W.stretches(w, d, all, 'A', noB, undefined, false);
  assert.deepStrictEqual(off.right, [], 'skip off: nowhere through B');
  assert.deepStrictEqual(off.blocked.map((b) => [b.side, b.dev, b.from, b.to, b.at]), [['right', 'B', 0, 800, 1000]]);
  assert.strictEqual(W.cross(w, d, all, 'A', 'right', 0.5, noB, undefined, false), null);
  // Nothing past the offline one: red even with skip on.
  const end = W.stretches({ A: w.A, B: w.B }, d, ['A', 'B'], 'A', noB);
  assert.deepStrictEqual(end.blocked.map((b) => b.dev), ['B']);
  // The switch is in the shared layout and survives edits.
  const L = require('../layout.js');
  const l0 = { rev: 3, by: 'A', cells: { A: { x: 0, y: 0 }, B: { x: 1, y: 0 } } };
  const r = L.setSkip(l0, false, 'A');
  assert.ok(r.ok && r.layout.skip === false && r.layout.rev === 4);
  assert.strictEqual(L.normalize(r.layout).skip, false);
  assert.strictEqual(L.place(r.layout, 'B', 0, 1, 'A').layout.skip, false, 'kept by a grid edit');
  assert.strictEqual(L.arrange(r.layout, { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 } }, 'A').layout.skip, false, 'kept by a map edit');
  assert.ok(!L.setSkip(r.layout, false, 'A').ok, 'no change, no edit');
  assert.notStrictEqual(L.canonical(l0), L.canonical({ ...l0, skip: false }));
}
{
  // Untrusted input.
  assert.deepStrictEqual(W.normalize({ a: { x: 1.4, y: 2 }, b: { x: 'x', y: 1 }, c: { x: 1e9, y: 0 }, '': { x: 0, y: 0 } }), { a: { x: 1, y: 2 } });
  assert.deepStrictEqual(W.normalize([1, 2]), {});
}
console.log('layout-world: passed');
