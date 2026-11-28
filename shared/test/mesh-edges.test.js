// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/mesh-edges.js, the matrix's data: every device tells the others its pairs (a pool), so each one
// sees, for every feature, which device sends it to which. A, B and C: A and B speak it, C is an older
// TwinDesk (says nothing; its cells come from what A and B say of their pairs with it).
// Run: node shared/test/mesh-edges.test.js
'use strict';

const assert = require('assert');
const { meshEdges } = require('../mesh-edges.js');

const features = [{ key: 'clipboard', dirs: { out: true, in: true } }, { key: 'files', dirs: { out: false, in: true } }];
const nodes = {};
function node(id, links, pairs) {
  const on = new Map();
  const peers = [];
  const bus = {
    on: (t, fn) => { if (!on.has(t)) on.set(t, []); on.get(t).push(fn); },
    onPeer: (ev, fn) => ev === 'welcome' && peers.push(fn),
    connectedIds: () => links,
  };
  const mesh = {
    peers: () => links.filter((x) => nodes[x] && nodes[x].speaks).map((x) => ({ id: x, mesh: true, send: (m) => { setImmediate(() => nodes[x].deliver(m, id)); return true; } })),
    known: () => ['A', 'B', 'C'].filter((x) => x !== id).map((x) => ({ id: x })),
  };
  const consent = { get: (peer, f, dir) => !!(((pairs[peer] || {})[f] || {})[dir]) };
  const e = meshEdges({ bus, mesh, selfId: id, consent, features, names: (x) => x, os: () => 'win', connected: (x) => links.includes(x) });
  nodes[id] = { e, speaks: true, deliver: (m, from) => { for (const fn of on.get(m.t) || []) fn(m, from); }, welcome: () => peers.forEach((fn) => fn('X')) };
  return e;
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const cell = (v, f, from, to) => v.cells[f].find((c) => c.from === from && c.to === to);

(async () => {
  // A: clipboard to B on, from B on; to C off. B: clipboard to A on, from A on; with C both on.
  const A = node('A', ['B', 'C'], { B: { clipboard: { out: true, in: true }, files: { in: true } }, C: { clipboard: { out: false, in: true }, files: { in: false } } });
  const B = node('B', ['A', 'C'], { A: { clipboard: { out: true, in: true }, files: { in: true } }, C: { clipboard: { out: true, in: true }, files: { in: true } } });
  nodes.C = { speaks: false }; // an older TwinDesk: no pool
  A.tick();
  B.tick();
  await flush();

  const v = A.view();
  assert.deepStrictEqual(v.devices.map((d) => [d.id, d.self, d.said]), [['A', true, true], ['B', false, true], ['C', false, false]]);
  // A's own cells: its row is what it sends (out), its column what it takes (in).
  assert.deepStrictEqual(cell(v, 'clipboard', 'A', 'B'), { from: 'A', to: 'B', on: true, live: true, why: null, mine: 'out' });
  assert.strictEqual(cell(v, 'clipboard', 'A', 'C').on, false);
  assert.deepStrictEqual(cell(v, 'clipboard', 'A', 'C').why, { key: '{from} doesn’t send it to {to}' });
  assert.strictEqual(cell(v, 'clipboard', 'C', 'A').mine, 'in');
  // B → C: B's pair (out on) and C's side, which C doesn't say: B's own pair says it (both ends agree).
  const bc = cell(v, 'clipboard', 'B', 'C');
  assert.strictEqual(bc.mine, '', 'neither end is A: read-only');
  assert.deepStrictEqual([bc.on, bc.live, bc.why], [true, true, null], 'from B’s word alone, and B is connected to C');
  // C → B: B takes C's (B's in), and C's out is the same pair seen from C: on.
  assert.strictEqual(cell(v, 'clipboard', 'C', 'B').on, true);
  // Files: A has no "send files" switch (out without one is always on): A → B on (B takes them).
  assert.strictEqual(cell(v, 'files', 'A', 'B').on, true);
  assert.strictEqual(cell(v, 'files', 'B', 'A').on, true);
  assert.strictEqual(cell(v, 'files', 'B', 'C').on, true, 'B says both ends');
  // Two older devices: nobody says their pair. (D is only known through the roster.)
  const known = A.mesh.known;
  A.mesh.known = () => [...known(), { id: 'D' }];
  const dc = cell(A.view(), 'clipboard', 'C', 'D');
  assert.deepStrictEqual([dc.on, dc.why && dc.why.key], [false, 'Not known: {who} runs an older TwinDesk']);
  A.mesh.known = known;

  // B sees A's cells the same, from A's word.
  const w = B.view();
  assert.strictEqual(cell(w, 'clipboard', 'A', 'C').on, false);
  assert.strictEqual(cell(w, 'clipboard', 'A', 'B').mine, 'in', 'for B, A → B is its column');
  // A switches its clipboard to C on: B hears it on the next tick.
  nodes.A.e.consent.get = (peer, f, dir) => (peer === 'C' && f === 'clipboard' ? true : !!(({ B: { clipboard: { out: true, in: true }, files: { in: true } }, C: { files: { in: false } } }[peer] || {})[f] || {})[dir]);
  A.tick();
  await flush();
  assert.deepStrictEqual([cell(B.view(), 'clipboard', 'A', 'C').on, cell(B.view(), 'clipboard', 'A', 'C').live], [true, true], 'A sends now: on for B too');
  // Unchanged: nothing published again (until a minute).
  const before = A.pool.stats().published;
  A.tick();
  assert.strictEqual(A.pool.stats().published, before);
  console.log('mesh-edges: ok');
})().catch((e) => { console.error(e); process.exit(1); });
