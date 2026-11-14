// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
'use strict';

const assert = require('assert');
const L = require('../layout');

// ---- neighbours: the nearest device on the same row / column ----
{
  // Windows - Mac - Android in one row
  const l = { rev: 1, by: 'win', cells: { win: { x: 0, y: 0 }, mac: { x: 1, y: 0 }, and: { x: 2, y: 0 } } };
  assert.deepStrictEqual(L.neighbors(l, 'win'), { left: null, right: 'mac', top: null, bottom: null });
  assert.deepStrictEqual(L.neighbors(l, 'mac'), { left: 'win', right: 'and', top: null, bottom: null });
  assert.deepStrictEqual(L.neighbors(l, 'and'), { left: 'mac', right: null, top: null, bottom: null });
  assert.strictEqual(L.across(l, 'win', 'right'), 'mac');
  assert.strictEqual(L.across(l, 'mac', 'right'), 'and', 'a chain: the Mac leads on to the phone');
  assert.strictEqual(L.sideTo(l, 'mac', 'win'), 'left');
  assert.strictEqual(L.sideTo(l, 'win', 'and'), null, 'not adjacent');
  // a gap does not break the row, a different row does not connect
  const g = { rev: 1, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, c: { x: 1, y: 1 }, d: { x: 1, y: -3 } } };
  assert.strictEqual(L.across(g, 'a', 'right'), 'b');
  assert.strictEqual(L.across(g, 'c', 'right'), null);
  assert.strictEqual(L.across(g, 'c', 'top'), 'd', 'nearest on the column, however far');
  assert.strictEqual(L.across(g, 'd', 'bottom'), 'c');
  assert.deepStrictEqual(L.neighbors(g, 'unknown'), { left: null, right: null, top: null, bottom: null });
}

// ---- normalize: untrusted input ----
{
  assert.deepStrictEqual(L.normalize(null), L.empty());
  assert.deepStrictEqual(L.normalize('x'), L.empty());
  assert.deepStrictEqual(L.normalize([]), L.empty());
  const n = L.normalize({
    rev: 3, by: 'a', extra: 1,
    cells: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 1.5, y: 0 }, d: { x: 1000, y: 0 }, e: { x: NaN, y: 0 }, f: 'x', g: { x: -2, y: 4 } },
  });
  assert.deepStrictEqual(Object.keys(n.cells).sort(), ['a', 'g'], 'two on one cell: the smaller id keeps it; bad coordinates dropped');
  assert.strictEqual(n.rev, 3);
  assert.strictEqual(L.normalize({ rev: -1, cells: {} }).rev, 0);
  assert.strictEqual(L.normalize({ rev: 'x', cells: {} }).rev, 0);
  const many = {};
  for (let i = 0; i < 30; i++) many['d' + String(i).padStart(2, '0')] = { x: i, y: 0 };
  assert.strictEqual(Object.keys(L.normalize({ rev: 1, cells: many }).cells).length, 10, 'at most MAX_DEVICES cells');
}

// ---- view: the same on every device for the same ids, never depends on order ----
{
  const stored = { rev: 4, by: 'mac', cells: { mac: { x: 0, y: 0 }, win: { x: -1, y: 0 }, gone: { x: 1, y: 0 } } };
  const a = L.view(stored, ['mac', 'win', 'and', 'tab']);
  const b = L.view(stored, ['tab', 'and', 'win', 'mac']);
  assert.strictEqual(L.canonical(a), L.canonical(b));
  assert.ok(!a.cells.gone, 'a device that is gone leaves the map');
  assert.deepStrictEqual(a.cells.and, { x: 1, y: 0 }, 'new devices go to the right of row 0, in id order');
  assert.deepStrictEqual(a.cells.tab, { x: 2, y: 0 });
  assert.strictEqual(a.rev, 4, 'a view is not an edit: rev unchanged');
  assert.deepStrictEqual(L.view(L.empty(), ['b', 'a']).cells, { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
}

// ---- place / remove ----
{
  const l = L.view(L.empty(), ['a', 'b', 'c']);
  let r = L.place(l, 'c', 0, 1, 'a');
  assert.ok(r.ok);
  assert.deepStrictEqual(r.layout.cells.c, { x: 0, y: 1 });
  assert.strictEqual(r.layout.rev, 1);
  assert.strictEqual(r.layout.by, 'a');
  assert.strictEqual(L.across(r.layout, 'a', 'bottom'), 'c');
  // onto an occupied cell: the two swap
  r = L.place(r.layout, 'a', 1, 0, 'a');
  assert.deepStrictEqual(r.layout.cells.a, { x: 1, y: 0 });
  assert.deepStrictEqual(r.layout.cells.b, { x: 0, y: 0 }, 'the other device takes the cell that was left');
  // a device that was not on the map pushes the occupant aside
  r = L.place(L.view(L.empty(), ['a']), 'z', 0, 0, 'a');
  assert.deepStrictEqual(r.layout.cells.z, { x: 0, y: 0 });
  assert.deepStrictEqual(r.layout.cells.a, { x: 1, y: 0 });
  assert.ok(!L.place(l, 'a', 1.5, 0, 'a').ok);
  assert.ok(!L.place(l, 'a', 0, 9999, 'a').ok);
  const removed = L.remove(l, 'b', 'a');
  assert.ok(!removed.cells.b);
  assert.strictEqual(removed.rev, l.rev + 1);
  assert.strictEqual(L.remove(l, 'nobody', 'a').rev, l.rev, 'nothing to remove: no edit');
  // never two devices on one cell and never empty space between them, whatever is done
  let walk = L.view(L.empty(), ['a', 'b', 'c', 'd', 'e']);
  let moved = 0;
  for (let i = 0; i < 200; i++) {
    const ids = Object.keys(walk.cells);
    const res = L.place(walk, ids[i % ids.length], ((i * 7) % 5) - 2, ((i * 3) % 3) - 1, 'a');
    if (res.ok) {
      walk = res.layout;
      moved += 1;
    }
    const seen = new Set(Object.values(walk.cells).map((c) => `${c.x},${c.y}`));
    assert.strictEqual(seen.size, Object.keys(walk.cells).length, 'unique cells');
    assert.ok(L.joined(walk), 'one piece');
  }
  assert.ok(moved > 20, 'the walk did move devices');
}

// ---- no empty space: next to another device by a side, never only by a corner ----
{
  // A 3 x 3 grid numbered like a keypad (1 2 3 / 4 5 6 / 7 8 9): monitor 1 on 5, PC 2 wanted on 9.
  const cell = (n) => ({ x: (n - 1) % 3, y: Math.floor((n - 1) / 3) });
  const two = { rev: 1, by: 'm1', cells: { m1: cell(5), pc2: cell(6) } };
  const nine = L.place(two, 'pc2', cell(9).x, cell(9).y, 'm1');
  assert.ok(!nine.ok, 'a corner of monitor 1 is no way through: 9 is refused');
  assert.deepStrictEqual(nine.layout.cells.pc2, cell(6), 'nothing moved');
  assert.deepStrictEqual(L.targets(two, 'pc2').map((c) => `${c.x},${c.y}`).sort(), ['0,1', '1,0', '1,2'].sort(),
    'pc2 may go on 2, 4 or 8 (next to monitor 1), or stay on 6');
  assert.ok(L.place(two, 'pc2', cell(8).x, cell(8).y, 'm1').ok, '8 is under monitor 1');
  assert.ok(!L.place(two, 'pc2', 7, 1, 'm1').ok, 'a cell away from everyone is refused');
  assert.ok(L.place({ rev: 0, by: '', cells: { a: { x: 0, y: 0 } } }, 'a', 5, 5, 'a').ok, 'a device on its own may go anywhere');
  assert.ok(L.place(two, 'pc2', cell(6).x, cell(6).y, 'm1').ok, 'put back where it is');

  // a device moved away from between others: the rest close up (a b c d → a c d, b under a)
  const row = L.view(L.empty(), ['a', 'b', 'c', 'd']);
  const r = L.place(row, 'b', 0, 1, 'a');
  assert.ok(r.ok);
  assert.deepStrictEqual(r.layout.cells, { a: { x: 0, y: 0 }, b: { x: 0, y: 1 }, c: { x: 1, y: 0 }, d: { x: 2, y: 0 } });
  assert.strictEqual(L.across(r.layout, 'a', 'right'), 'c');
  // the device put down stays where it was put, the loose part comes to it
  const end = L.place(row, 'd', -1, 0, 'a'); // d to the left end: nothing comes loose
  assert.deepStrictEqual(end.layout.cells.d, { x: -1, y: 0 });
  assert.ok(L.joined(end.layout));

  // taken off from the middle: the two sides close up
  const rm = L.remove(L.view(L.empty(), ['a', 'b', 'c']), 'b', 'a');
  assert.deepStrictEqual(rm.cells, { a: { x: 0, y: 0 }, c: { x: 1, y: 0 } });
  const rm2 = L.remove(L.view(L.empty(), ['a', 'b', 'c', 'd', 'e']), 'b', 'a');
  assert.ok(L.joined(rm2) && Object.keys(rm2.cells).length === 4, 'the larger part stays, the other comes to it');
  assert.deepStrictEqual(rm2.cells.c, { x: 2, y: 0 }, 'c d e stay');
  assert.deepStrictEqual(rm2.cells.a, { x: 1, y: 0 }, 'a moved next to c');

  // a stored layout with gaps (an older app's, or devices that are gone) is shown in one piece
  const gappy = { rev: 3, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, c: { x: 2, y: 2 } } };
  const v = L.view(gappy, ['a', 'b', 'c']);
  assert.ok(L.joined(v), 'the view has no empty space');
  assert.strictEqual(L.canonical(v), L.canonical(L.view(gappy, ['c', 'b', 'a'])), 'the same on every device');
  assert.ok(!L.joined(gappy) && L.joined({ rev: 1, cells: { a: { x: 0, y: 0 } } }));
  // a new device goes to the right of row 0, or of the top row when row 0 is empty
  const high = L.view({ rev: 1, by: 'a', cells: { a: { x: 0, y: -1 } } }, ['a', 'z']);
  assert.deepStrictEqual(high.cells.z, { x: 1, y: -1 });
}

// ---- merge: all devices end with the same layout, whatever the order ----
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let round = 0; round < 200; round++) {
    const ids = ['d0', 'd1', 'd2', 'd3', 'd4'].slice(0, 2 + Math.floor(rnd() * 4));
    const copies = new Map(ids.map((id) => [id, L.view(L.empty(), ids)]));
    for (let step = 0; step < 30; step++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      if (rnd() < 0.5) {
        const target = ids[Math.floor(rnd() * ids.length)];
        const r = L.place(copies.get(id), target, Math.floor(rnd() * 5) - 2, Math.floor(rnd() * 3) - 1, id);
        if (r.ok) copies.set(id, r.layout);
      } else { // two devices exchange
        const other = ids[Math.floor(rnd() * ids.length)];
        const m = L.merge(copies.get(id), copies.get(other));
        copies.set(id, m);
        copies.set(other, m);
      }
    }
    for (let pass = 0; pass < 2; pass++) { // everyone hears everyone
      for (const a of ids) for (const b of ids) copies.set(a, L.merge(copies.get(a), copies.get(b)));
    }
    const first = L.canonical(copies.get(ids[0]));
    for (const id of ids) assert.strictEqual(L.canonical(copies.get(id)), first, `round ${round}: converged`);
  }
  // concurrent edits at the same rev: one wins on every device, the same one
  const base = L.view(L.empty(), ['a', 'b']);
  const x = L.place(base, 'a', 1, 1, 'a').layout; // under b
  const y = L.place(base, 'b', 0, 1, 'b').layout; // under a
  assert.strictEqual(L.canonical(L.merge(x, y)), L.canonical(L.merge(y, x)));
  assert.strictEqual(L.merge(x, y).by, 'b', 'at the same rev the larger author wins');
  // same rev and the same author but different cells (a device edited twice offline, or a bug):
  // still the same winner on every device
  const p = { rev: 5, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } };
  const q = { rev: 5, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } } };
  assert.strictEqual(L.canonical(L.merge(p, q)), L.canonical(L.merge(q, p)));
  assert.ok(L.newer(p, q) !== L.newer(q, p), 'exactly one of two different layouts is newer');
}

// ---- migration from the old per-device edges ----
{
  const l = L.fromEdges('mac', { left: 'win', right: 'and', top: null, bottom: null });
  assert.strictEqual(L.across(l, 'mac', 'left'), 'win');
  assert.strictEqual(L.across(l, 'mac', 'right'), 'and');
  assert.strictEqual(L.across(l, 'win', 'right'), 'mac', 'seen from the Windows PC the Mac is on its right');
  assert.deepStrictEqual(L.fromEdges('a', {}).cells, { a: { x: 0, y: 0 } });
  assert.deepStrictEqual(L.fromEdges('a', { left: 'a' }).cells, { a: { x: 0, y: 0 } }, 'never itself');
}

// ---- grid (for the editor) ----
{
  const g = L.grid({ rev: 1, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 2, y: 1 } } });
  assert.deepStrictEqual([g.minX, g.maxX, g.minY, g.maxY], [-1, 3, -1, 2], 'one empty ring around the devices');
  assert.deepStrictEqual(g.cells.map((c) => c.id), ['a', 'b']);
  assert.deepStrictEqual(L.grid(L.empty()).cells, []);
}

// ---- reach: what this device's mouse gets to through the chain ----
{
  // W1 - W2 - W3 - W4, W1 not connected to W3: the pointer stops at W2's edge and W4 is behind W3
  const row = { rev: 1, by: 'w1', cells: { w1: { x: 0, y: 0 }, w2: { x: 1, y: 0 }, w3: { x: 2, y: 0 }, w4: { x: 3, y: 0 } } };
  const conn = (ids) => (id) => ids.includes(id);
  assert.deepStrictEqual(L.reach(row, 'w1', conn(['w2', 'w4'])), { w1: 'self', w2: 'reached', w3: 'blocked', w4: 'behind' });
  assert.deepStrictEqual(L.reach(row, 'w1', conn(['w2', 'w3', 'w4'])), { w1: 'self', w2: 'reached', w3: 'reached', w4: 'reached' });
  // seen from W3 (connected to W2 and W4 only): both ways out, and W1 past W2 is blocked
  assert.deepStrictEqual(L.reach(row, 'w3', conn(['w2', 'w4'])), { w1: 'blocked', w2: 'reached', w3: 'self', w4: 'reached' });
  // a phone ends a chain: what is past it is behind
  assert.deepStrictEqual(L.reach(row, 'w1', conn(['w2', 'w3', 'w4']), (id) => id === 'w2'), { w1: 'self', w2: 'reached', w3: 'behind', w4: 'behind' });
  // another way round: W4 is reached under W1 and W2 when W3 is blocked
  const l2 = { rev: 1, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 1, y: 1 }, d: { x: 2, y: 1 } } };
  assert.deepStrictEqual(L.reach(l2, 'a', conn(['c', 'd'])), { a: 'self', b: 'blocked', c: 'behind', d: 'behind' });
  assert.deepStrictEqual(L.reach(l2, 'a', conn(['b', 'd'])), { a: 'self', b: 'reached', c: 'blocked', d: 'behind' });
  assert.deepStrictEqual(L.reach(l2, 'a', conn(['b', 'c', 'd'])), { a: 'self', b: 'reached', c: 'reached', d: 'reached' });
  assert.deepStrictEqual(L.reach(row, 'zz', () => true), {}, 'not on the layout: nothing');
}

// ---- keepUnknown: an edit keeps the devices only others know ----
{
  const stored = { rev: 4, by: 'b', cells: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 2, y: 0 }, d: { x: 3, y: 0 } } };
  // a knows a, b, c: it moves itself under b; d (unknown to a) stays where it was
  const r = L.place(L.view(stored, ['a', 'b', 'c']), 'a', 1, 1, 'a');
  assert.ok(r.ok);
  const kept = L.keepUnknown(r.layout, stored, ['a', 'b', 'c']);
  assert.deepStrictEqual(kept.cells.d, { x: 3, y: 0 }, 'd keeps its cell');
  assert.strictEqual(kept.rev, 5);
  assert.deepStrictEqual(L.view(kept, ['a', 'b', 'c', 'd']).cells, { a: { x: 1, y: 1 }, b: { x: 1, y: 0 }, c: { x: 2, y: 0 }, d: { x: 3, y: 0 } });
  // its cell taken by the edit: left out, and a device that knows it puts it at the end of row 0
  const r2 = L.place(L.view(stored, ['a', 'b', 'c']), 'a', 3, 0, 'a');
  const k2 = L.keepUnknown(r2.layout, stored, ['a', 'b', 'c']);
  assert.ok(!k2.cells.d || Object.keys(k2.cells).filter((id) => k2.cells[id].x === 3 && k2.cells[id].y === 0).length === 1, 'never two on a cell');
  assert.ok(L.view(k2, ['a', 'b', 'c', 'd']).cells.d, 'd is still drawn where it is known');
  // a device it knows and took off stays off
  assert.ok(!L.keepUnknown(L.remove(stored, 'c', 'a'), stored, ['a', 'b', 'c']).cells.c);
}

// world (#225): carried with the layout, cleaned, part of what is compared, kept through edits.
{
  const base = { rev: 3, by: 'a', cells: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } };
  assert.ok(!L.normalize(base).world, 'none until arranged');
  const w = L.normalize({ ...base, world: { a: { x: 0, y: 0 }, b: { x: 1920.4, y: -10 }, ghost: { x: 5, y: 5 }, bad: { x: 'no' } } });
  assert.deepStrictEqual(w.world, { a: { x: 0, y: 0 }, b: { x: 1920, y: -10 } }, 'only devices with a cell');
  assert.notStrictEqual(L.canonical(base), L.canonical(w));
  const r = L.arrange(base, { a: { x: 0, y: 0 }, b: { x: 0, y: 1080 } }, 'b');
  assert.ok(r.ok);
  assert.strictEqual(r.layout.rev, 4);
  assert.deepStrictEqual(r.layout.world.b, { x: 0, y: 1080 });
  assert.deepStrictEqual(r.layout.cells, base.cells, 'the grid stays for older apps');
  assert.ok(!L.arrange(base, { z: { x: 0, y: 0 } }, 'a').ok, 'unknown devices only: nothing');
  const moved = L.place(r.layout, 'b', 0, 1, 'a');
  assert.deepStrictEqual(moved.layout.world, r.layout.world, 'a grid edit keeps the world');
  const gone = L.remove(r.layout, 'b', 'a');
  assert.deepStrictEqual(gone.world, { a: { x: 0, y: 0 } });
  assert.deepStrictEqual(L.view(r.layout, ['a', 'b']).world, r.layout.world);
  const kept = L.keepUnknown(L.normalize({ rev: 5, by: 'a', cells: { a: { x: 0, y: 0 } }, world: { a: { x: 0, y: 0 } } }), r.layout, ['a']);
  assert.deepStrictEqual(kept.world.b, { x: 0, y: 1080 }, 'a device only others know keeps its place on the map');
}

console.log('layout: passed');
