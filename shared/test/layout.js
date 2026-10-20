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
  // never two devices on one cell, whatever is done
  let walk = L.view(L.empty(), ['a', 'b', 'c', 'd', 'e']);
  for (let i = 0; i < 200; i++) {
    const ids = Object.keys(walk.cells);
    const res = L.place(walk, ids[i % ids.length], ((i * 7) % 5) - 2, ((i * 3) % 3) - 1, 'a');
    if (res.ok) walk = res.layout;
    const seen = new Set(Object.values(walk.cells).map((c) => `${c.x},${c.y}`));
    assert.strictEqual(seen.size, Object.keys(walk.cells).length, 'unique cells');
  }
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
  const x = L.place(base, 'a', 0, 1, 'a').layout;
  const y = L.place(base, 'b', 0, 1, 'b').layout;
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

console.log('layout: passed');
