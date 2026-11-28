// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/mesh-edges.js setCell: Notifications › Across devices, any cell from any device. A changes the
// B → C cell: B's out side and C's in side are set on B and C ('mesh.cell'). An owner whose own switch for
// that way is off (the page's top cards, consent.flat) refuses, and A's grid shows the cell closed.
// Run: node shared/test/mesh-cell.test.js
'use strict';

const assert = require('assert');
const { meshEdges } = require('../mesh-edges.js');

const features = [{ key: 'notifs', dirs: { out: true, in: true } }];
const nodes = {};
const ALL = ['A', 'B', 'C'];
function node(id, flat) {
  const on = new Map();
  const pairs = {};
  const bus = {
    on: (t, fn) => { if (!on.has(t)) on.set(t, []); on.get(t).push(fn); },
    onPeer: () => {},
    connectedIds: () => ALL.filter((x) => x !== id),
    send: (to, m) => { setImmediate(() => nodes[to].deliver(m, id)); return true; },
  };
  const mesh = {
    peers: () => ALL.filter((x) => x !== id).map((x) => ({ id: x, mesh: true, send: (m) => { setImmediate(() => nodes[x].deliver(m, id)); return true; } })),
    known: () => ALL.filter((x) => x !== id).map((x) => ({ id: x })),
  };
  const consent = {
    get: (peer, f, dir) => (pairs[peer] && pairs[peer][dir] !== undefined ? pairs[peer][dir] : flat[dir]),
    set: (peer, f, dir, v) => { pairs[peer] = { ...(pairs[peer] || {}), [dir]: v }; return true; },
    flat: (f, dir) => flat[dir],
    selectedId: () => '',
  };
  const e = meshEdges({ bus, mesh, selfId: id, consent, features, names: (x) => x, os: () => 'win', connected: (x) => x !== id });
  nodes[id] = { e, pairs, flat, deliver: (m, from) => { for (const fn of on.get(m.t) || []) fn(m, from); } };
  return e;
}
const flush = () => new Promise((r) => setTimeout(r, 30));
const cell = (e, from, to) => e.view().cells.notifs.find((c) => c.from === from && c.to === to);
const tickAll = async () => { for (const x of ALL) nodes[x].e.tick(); await flush(); };

(async () => {
  const A = node('A', { out: true, in: true });
  node('B', { out: true, in: true });
  node('C', { out: true, in: true });
  nodes.B.pairs.C = { out: false };
  await tickAll();
  assert.strictEqual(cell(A, 'B', 'C').on, false);
  assert.strictEqual(cell(A, 'B', 'C').edit, true, 'B and C accept changes');

  assert.strictEqual(A.setCell('B', 'C', 'notifs', true), true);
  await flush();
  assert.strictEqual(nodes.B.pairs.C.out, true, 'B now sends to C');
  await tickAll();
  assert.strictEqual(cell(A, 'B', 'C').on, true, 'A sees it on');

  // C turns its Show switch off: its column is closed to others; off still works through B.
  nodes.C.flat.in = false;
  nodes.C.pairs.B = { in: true };
  await tickAll();
  assert.strictEqual(A.setCell('B', 'C', 'notifs', false), true, 'off through the side still open');
  await flush();
  assert.strictEqual(nodes.B.pairs.C.out, false);
  assert.strictEqual(nodes.C.pairs.B.in, true, 'C kept its own side');
  await tickAll();
  assert.strictEqual(cell(A, 'B', 'C').edit, true, 'C still takes from B: on needs only B');
  nodes.C.pairs.B = { in: false };
  await tickAll();
  assert.strictEqual(cell(A, 'B', 'C').edit, false, 'on needs C, which is closed');
  assert.strictEqual(A.setCell('B', 'C', 'notifs', true), false);

  // A message from C asking B with B's Send off: refused.
  nodes.B.flat.out = false;
  nodes.B.deliver({ t: 'mesh.cell', peer: 'A', key: 'notifs', dir: 'out', on: false }, 'C');
  await flush();
  assert.notStrictEqual(nodes.B.pairs.A && nodes.B.pairs.A.out, false, 'B refused');
  console.log('mesh-cell: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
