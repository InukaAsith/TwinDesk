// The shared layout on this Mac (mac/layout-sync.js, shared/layout.js) on real sockets: every node has a
// real Server, Pairing, LinkManager, Mesh, Hub and LayoutSync, paired with the real pairing protocol.
// The same scenarios as windows/test/layout-sync.test.js.
// Run with: node mac/test/layout-sync.test.js  (NODE_PATH as in CI; electron is not needed here)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const L = require('../../shared/layout.js');
const LayoutSync = require('../layout-sync.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node: baseNode, close, waitFor, pair } = require('./lib/mesh.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Mac with the layout. Its settings.layout is kept in n.settings (as main.js keeps it).
async function node(name) {
  const n = await baseNode(name);
  n.extra = [];
  n.changes = 0;
  n.saved = 0;
  n.settings = { layout: null };
  n.ls = new LayoutSync({
    bus: n.hub.bus,
    mesh: n.mesh,
    selfId: n.id,
    storage: {
      get: () => n.settings.layout,
      set: (l) => { n.settings.layout = l; n.saved++; },
    },
    knownIds: () => [...n.hub.peers().map((p) => p.id), ...n.extra],
    onChange: () => { n.changes++; },
  });
  return n;
}

async function world(names, pairs) {
  const N = {};
  for (const name of names) N[name] = await node(name);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => pairs.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const all = (N) => Object.values(N);
const closeAll = (N) => close(...all(N));
const full = (names) => {
  const out = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) out.push([names[i], names[j]]);
  return out;
};

// The same view on every node (the arrangement the user sees).
const viewOf = (n) => JSON.stringify(n.ls.view());
const sameView = (N) => {
  const first = viewOf(all(N)[0]);
  return all(N).every((n) => viewOf(n) === first);
};
const sameStored = (N) => {
  const first = L.canonical(all(N)[0].ls.get());
  return all(N).every((n) => L.canonical(n.ls.get()) === first);
};
const fresh = (n) => n.ls.pool.stats().fresh;
const dups = (n) => n.ls.pool.stats().droppedDup;

test('an edit on A reaches B and C once, and every node shows the same view (3 computers)', async () => {
  const N = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  try {
    const { A, B, C } = N;
    assert.strictEqual(A.ls.place(A.id, 0, 0), true);
    assert.strictEqual(A.ls.place(B.id, 1, 0), true);
    assert.strictEqual(A.ls.place(C.id, 2, 0), true);
    await waitFor(() => sameView(N) && sameStored(N) && B.ls.get().rev === 3, 'every node has the layout');
    assert.strictEqual(B.ls.get().by, A.id, 'the editing device is recorded');
    assert.deepStrictEqual(B.ls.view().cells[C.id], { x: 2, y: 0 });
    assert.strictEqual(fresh(B), 3, 'B applied three items from A');
    assert.strictEqual(fresh(C), 3, 'C applied three items from A');
    assert.strictEqual(dups(B), 0);
    assert.strictEqual(dups(C), 0);
    assert.deepStrictEqual(B.ls.neighbors(), { left: A.id, right: C.id, top: null, bottom: null }, 'B: A on the left, C on the right');
    assert.deepStrictEqual(A.ls.neighbors(), { left: null, right: B.id, top: null, bottom: null });
    assert.strictEqual(C.ls.across('left'), B.id, 'C: left leads to B');
    assert.strictEqual(C.ls.across('right'), null);
    assert.ok(B.changes >= 1, 'B was told the layout changed');
  } finally {
    closeAll(N);
  }
});

test('an edit made on B is seen the same way everywhere', async () => {
  const N = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  try {
    const { A, B, C } = N;
    B.ls.place(A.id, 0, 0);
    B.ls.place(B.id, 1, 0);
    B.ls.place(C.id, 2, 0);
    await waitFor(() => sameView(N) && sameStored(N), 'the same view everywhere');
    for (const n of [A, B, C]) {
      const v = n.ls.view().cells;
      assert.ok(v[A.id].x < v[B.id].x && v[B.id].x < v[C.id].x, `${n.name} sees A, B, C left to right`);
    }
  } finally {
    closeAll(N);
  }
});

test('a late joiner converges: it gets the stored layout when it connects', async () => {
  const N = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  try {
    const { A, B, C } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    A.ls.place(C.id, 2, 0);
    await waitFor(() => sameStored(N), 'the three have the layout');
    const D = await node('D');
    N.D = D;
    await pair(D, A);
    await pair(D, B);
    await pair(D, C);
    await waitFor(() => [A, B, C].every((n) => n.hub.sessions.get(D.id) && n.hub.sessions.get(D.id).connected), 'D is connected to all');
    await waitFor(() => L.canonical(D.ls.get()) === L.canonical(A.ls.get()), 'D gets the stored layout');
    await waitFor(() => sameView(N), 'the same view on all four');
    assert.strictEqual(D.ls.get().rev, 3);
    assert.strictEqual(D.ls.neighbors(B.id).left, A.id, 'from D: B has A on its left');
    assert.strictEqual(D.ls.neighbors(B.id).right, C.id);
  } finally {
    closeAll(N);
  }
});

test('concurrent edits on two nodes at the same rev: one winner everywhere (the larger editor id)', async () => {
  const N = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  try {
    const { A, B, C } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    A.ls.place(C.id, 2, 0);
    await waitFor(() => sameStored(N) && A.ls.get().rev === 3, 'base layout');
    assert.strictEqual(A.ls.place(B.id, 0, 1), true);
    assert.strictEqual(C.ls.place(C.id, 5, 5), true);
    assert.strictEqual(A.ls.get().rev, 4);
    assert.strictEqual(C.ls.get().rev, 4);
    const winner = [A, C].sort((x, y) => (x.id > y.id ? -1 : 1))[0];
    await waitFor(() => sameStored(N) && sameView(N), 'every node agrees');
    assert.strictEqual(B.ls.get().by, winner.id, 'the larger editor id wins at the same rev');
    assert.strictEqual(A.ls.get().by, winner.id);
    assert.strictEqual(C.ls.get().by, winner.id);
  } finally {
    closeAll(N);
  }
});

test('a partial mesh (A and C have no direct link) still converges, through B', async () => {
  const N = await world(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  try {
    const { A, B, C } = N;
    A.extra = [C.id];
    C.extra = [A.id];
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    A.ls.place(C.id, 2, 0);
    await waitFor(() => sameStored(N), 'C has the layout through B');
    assert.strictEqual(C.ls.get().rev, 3);
    assert.strictEqual(fresh(C), 3, 'C got each of the three edits once, through B');
    assert.strictEqual(dups(C), 0);
    assert.ok(B.ls.pool.stats().relayed >= 3, 'B relayed the items to C');
    const sA = A.hub.sessions.get(C.id);
    assert.ok(!sA || !sA.connected, 'there is no direct A-C link');
  } finally {
    closeAll(N);
  }
});

test('a device that is forgotten leaves the view of the device that forgot it; the others keep it', async () => {
  const N = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  try {
    const { A, B, C } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    A.ls.place(C.id, 2, 0);
    await waitFor(() => sameStored(N), 'the layout everywhere');
    A.hub.forgetPeer(C.id);
    await waitFor(() => !A.ls.view().cells[C.id], 'C left A\'s view');
    assert.deepStrictEqual(A.ls.neighbors(), { left: null, right: B.id, top: null, bottom: null });
    assert.ok(B.ls.view().cells[C.id], 'B still has C');
    assert.strictEqual(A.ls.remove(C.id), true);
    assert.strictEqual(A.ls.get().cells[C.id], undefined);
    await waitFor(() => !B.ls.get().cells[C.id] && B.ls.get().rev === A.ls.get().rev, 'B takes the removal');
    assert.strictEqual(A.ls.remove(C.id), false, 'removing a device that is not there changes nothing');
    assert.strictEqual(A.ls.remove(crypto.randomUUID()), false);
  } finally {
    closeAll(N);
  }
});

test('a device that drops its link is still in the layout; when it is back the layout is unchanged', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  try {
    const { A, B } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    await waitFor(() => sameStored(N), 'layout on both');
    const before = viewOf(A);
    A.links.get(B.id).ws.terminate();
    await waitFor(() => !A.hub.sessions.get(B.id).connected, 'B dropped on A');
    assert.strictEqual(viewOf(A), before, 'the view does not change while B is away');
    await waitFor(() => A.hub.sessions.get(B.id).connected && B.hub.sessions.get(A.id).connected, 'B is back', 20000);
    assert.strictEqual(viewOf(A), before);
    assert.strictEqual(A.ls.get().rev, 2, 'no edit was made by the drop');
  } finally {
    closeAll(N);
  }
});

test('garbage layouts from a device are ignored as a whole: the view and the stored layout do not change', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  try {
    const { A, B } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    await waitFor(() => sameStored(N), 'the layout');
    const before = L.canonical(A.ls.get());
    const garbage = [
      undefined, null, 'layout', 42, [], {}, { rev: 'a', cells: {} },
      { rev: 0, cells: { [B.id]: { x: 9, y: 9 } } },
      { rev: -4, cells: { [B.id]: { x: 9, y: 9 } } },
      { rev: 7, cells: 'nope' },
      { rev: 7, cells: {} },
      { rev: 7, cells: { [B.id]: { x: 1.5, y: 0 } } },
      { rev: 7, cells: { [B.id]: { x: 'a', y: 0 } } },
      { rev: 7, cells: { [B.id]: null } },
      { rev: 7, cells: { [B.id]: { x: 1e9, y: 0 } } },
      { rev: 2 ** 41, cells: { [B.id]: { x: 1, y: 0 } } },
      { rev: 7, cells: { [B.id]: { x: 0, y: 0 }, [A.id]: { x: 0, y: 0 } } },
    ];
    garbage.forEach((g, i) => B.hub.bus.send(A.id, { t: 'layout', layout: g, o: B.id, s: 1000 + i, d: [], h: 0 }));
    await sleep(300);
    assert.strictEqual(L.canonical(A.ls.get()), before, 'A kept its layout');
    assert.deepStrictEqual(A.ls.view().cells[B.id], { x: 1, y: 0 });
    assert.strictEqual(B.ls.place(B.id, 2, 0), true);
    await waitFor(() => A.ls.view().cells[B.id] && A.ls.view().cells[B.id].x === 2, 'the next real edit arrives');
  } finally {
    closeAll(N);
  }
});

test('an older layout never replaces a newer one', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  try {
    const { A, B } = N;
    A.ls.place(A.id, 0, 0);
    A.ls.place(B.id, 1, 0);
    A.ls.place(B.id, 2, 0); // rev 3
    await waitFor(() => sameStored(N), 'rev 3 on both');
    B.hub.bus.send(A.id, { t: 'layout', layout: { rev: 2, by: A.id, cells: { [A.id]: { x: 5, y: 5 } } } });
    await sleep(200);
    assert.strictEqual(A.ls.get().rev, 3);
    assert.deepStrictEqual(A.ls.view().cells[B.id], { x: 2, y: 0 });
  } finally {
    closeAll(N);
  }
});

test('edits are refused for ids that are not in the mesh and for bad coordinates', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  try {
    const { A } = N;
    assert.strictEqual(A.ls.place(crypto.randomUUID(), 0, 0), false, 'an unknown device');
    assert.strictEqual(A.ls.place(A.id, 0.5, 0), false, 'not an integer');
    assert.strictEqual(A.ls.place(A.id, 1000, 0), false, 'out of range');
    assert.strictEqual(A.ls.place('', 0, 0), false);
    assert.strictEqual(A.ls.get(), null, 'nothing stored');
    assert.strictEqual(A.saved, 0);
  } finally {
    closeAll(N);
  }
});

test('settings from before the layout: kvm edges become a layout once; a stored layout is kept', async () => {
  const X = await node('X');
  const otherId = crypto.randomUUID();
  try {
    const mk = (storage, legacyEdges) => new LayoutSync({
      bus: X.hub.bus,
      mesh: X.mesh,
      selfId: X.id,
      storage,
      knownIds: () => [otherId],
      legacyEdges,
      onChange: () => {},
    });
    const store = { v: null, saved: 0 };
    const ls = mk({ get: () => store.v, set: (l) => { store.v = l; store.saved++; } }, () => ({ left: null, right: otherId, top: null, bottom: null }));
    assert.deepStrictEqual(ls.view().cells[otherId], { x: 1, y: 0 }, 'the other device is on the right, as the edge said');
    assert.strictEqual(ls.neighbors().right, otherId);
    assert.strictEqual(store.saved, 1, 'stored once');
    assert.strictEqual(store.v.rev, 1);

    const again = mk({ get: () => store.v, set: () => { store.saved++; } }, () => ({ left: otherId, right: null, top: null, bottom: null }));
    assert.strictEqual(again.neighbors().right, otherId, 'the stored layout wins over the old edges');
    assert.strictEqual(store.saved, 1);

    const empty = { v: null, saved: 0 };
    const none = mk({ get: () => empty.v, set: (l) => { empty.v = l; empty.saved++; } }, () => ({ left: null, right: null, top: null, bottom: null }));
    assert.strictEqual(empty.saved, 0);
    assert.strictEqual(none.get(), null);
  } finally {
    close(X);
  }
});

test('the same arrangement on five Macs, a full mesh: each edit arrives once everywhere', async () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const N = await world(names, full(names));
  try {
    const A = N.A;
    names.forEach((x, i) => A.ls.place(N[x].id, i, 0));
    await waitFor(() => sameStored(N) && sameView(N), 'five nodes agree');
    for (const x of names.slice(1)) {
      assert.strictEqual(fresh(N[x]), 5, `${x} applied five items`);
      assert.strictEqual(dups(N[x]), 0, `${x} dropped no duplicate`);
    }
    assert.deepStrictEqual(N.C.ls.neighbors(), { left: N.B.id, right: N.D.id, top: null, bottom: null });
    assert.strictEqual(N.E.ls.across('left'), N.D.id);
  } finally {
    closeAll(N);
  }
});

runTests(tests);
