// Tests for Pool in shared/mesh.js: fan-out, dedupe, relay, hop limit, legacy peers.
// Run with: node shared/test/mesh-pool.js
'use strict';

const assert = require('assert');
const { Pool } = require('../mesh.js');

// Deterministic PRNG (mulberry32) so a failing random graph can be replayed by its seed.
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// In-memory network. A node is a Pool (a device with the mesh) or a legacy leaf (an old one-to-one
// app: no Pool, it sends and receives plain messages and applies everything it gets).
// Messages wait in a queue; run() delivers them, in FIFO order or in an order chosen by pick().
class Net {
  constructor() {
    this.nodes = new Map();
    this.adj = new Map(); // id -> Set of neighbour ids
    this.queue = [];
    this.sends = 0;
  }

  addNode(id, legacy) {
    this.nodes.set(id, { id, legacy: !!legacy, pool: null, applied: new Map(), raw: [] });
    this.adj.set(id, new Set());
    return this;
  }

  link(a, b) {
    this.adj.get(a).add(b);
    this.adj.get(b).add(a);
    return this;
  }

  // Build the Pool of every non-legacy node. maxHops/seenLimit are explicit so the tests do not
  // depend on the protocol constants.
  start(opts) {
    for (const node of this.nodes.values()) {
      if (node.legacy) continue;
      node.pool = new Pool({
        name: 'clip',
        selfId: node.id,
        seenLimit: opts.seenLimit,
        maxHops: opts.maxHops,
        peers: () => this.peersOf(node.id),
      });
    }
    return this;
  }

  // What node id sees as its connected peers. mesh is false when the other side is legacy.
  peersOf(id) {
    return Array.from(this.adj.get(id)).map((other) => ({
      id: other,
      mesh: !this.nodes.get(other).legacy,
      pool: true,
      send: (msg) => this.enqueue(id, other, msg),
    }));
  }

  enqueue(from, to, msg) {
    this.sends += 1;
    this.queue.push({ from, to, msg });
    return true;
  }

  // Deliver one queued message. Returns false when the queue is empty.
  deliverAt(index) {
    const [e] = this.queue.splice(index, 1);
    if (!e) return false;
    const node = this.nodes.get(e.to);
    if (node.legacy) {
      node.raw.push(Object.keys(e.msg));
      node.applied.set(e.msg.item, (node.applied.get(e.msg.item) || 0) + 1);
      return true;
    }
    const r = node.pool.receive(e.from, e.msg);
    if (r.fresh) node.applied.set(r.msg.item, (node.applied.get(r.msg.item) || 0) + 1);
    return true;
  }

  // Deliver everything. pick(queueLength) returns the index to deliver next (default: FIFO).
  run(pick) {
    while (this.queue.length > 0) {
      const index = pick ? pick(this.queue.length) : 0;
      this.deliverAt(index);
    }
  }

  // Publish an item from node origin (a Pool node). Returns the sends it caused.
  publish(origin, item) {
    const before = this.sends;
    this.nodes.get(origin).pool.publish({ item });
    return { item, origin, sends: () => this.sends - before };
  }

  // Legacy leaf sends an item to its neighbour, as an old app does.
  legacySend(leaf, item) {
    const [neighbour] = this.adj.get(leaf);
    const before = this.sends;
    this.enqueue(leaf, neighbour, { item });
    return { item, origin: leaf, sends: () => this.sends - before };
  }

  // Every node except the origin applied the item exactly once; the origin applied nothing.
  assertExactlyOnce(entry, label) {
    for (const node of this.nodes.values()) {
      const got = node.applied.get(entry.item) || 0;
      const want = node.id === entry.origin ? 0 : 1;
      assert.strictEqual(got, want, `${label}: node ${node.id} applied ${entry.item} ${got} times, want ${want}`);
    }
  }
}

function fullMesh(n) {
  const net = new Net();
  for (let i = 0; i < n; i++) net.addNode('n' + i);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) net.link('n' + i, 'n' + j);
  return net;
}

function directedLinks(net) {
  let count = 0;
  for (const set of net.adj.values()) count += set.size;
  return count;
}

const OPTS = { seenLimit: 200, maxHops: 3 };
let itemNo = 0;
const nextItem = () => 'item' + (++itemNo);

// 1. Full mesh: every node applies once, origin never, n-1 sends per item.
{
  const r = rng(1);
  for (let n = 2; n <= 10; n++) {
    const net = fullMesh(n).start(OPTS);
    for (let k = 0; k < 30; k++) {
      const origin = 'n' + Math.floor(r() * n);
      const entry = net.publish(origin, nextItem());
      net.run();
      net.assertExactlyOnce(entry, `full mesh n=${n}`);
      assert.strictEqual(entry.sends(), n - 1, `full mesh n=${n}: sends per item`);
    }
  }
}

// 2. Partial meshes. Line, star, ring, and random connected graphs with a seeded PRNG.
// These use maxHops = 10 so that a line of 10 nodes is fully covered (see the hop test below).
{
  const wide = { seenLimit: 200, maxHops: 10 };

  // Line A-B-C-D: every node once, and the origin's item crosses each link once.
  {
    const net = new Net().addNode('A').addNode('B').addNode('C').addNode('D');
    net.link('A', 'B').link('B', 'C').link('C', 'D').start(wide);
    const e = net.publish('A', nextItem());
    net.run();
    net.assertExactlyOnce(e, 'line from end');
    assert.strictEqual(e.sends(), 3, 'line: 3 links, 3 sends');
    const f = net.publish('B', nextItem());
    net.run();
    net.assertExactlyOnce(f, 'line from middle');
  }

  // Star: centre C, leaves L1..L6.
  {
    const net = new Net().addNode('C');
    for (let i = 1; i <= 6; i++) net.addNode('L' + i).link('C', 'L' + i);
    net.start(wide);
    const e = net.publish('L3', nextItem());
    net.run();
    net.assertExactlyOnce(e, 'star from leaf');
    assert.strictEqual(e.sends(), 6, 'star from leaf: leaf->C, C->5 leaves');
  }

  // Ring of 7.
  {
    const net = new Net();
    const n = 7;
    for (let i = 0; i < n; i++) net.addNode('r' + i);
    for (let i = 0; i < n; i++) net.link('r' + i, 'r' + ((i + 1) % n));
    net.start(wide);
    for (let i = 0; i < n; i++) {
      const e = net.publish('r' + i, nextItem());
      net.run();
      net.assertExactlyOnce(e, 'ring origin r' + i);
      assert.ok(e.sends() <= directedLinks(net), 'ring: sends bounded by directed links');
    }
  }

  // Random connected graphs of 2..10 nodes: a random tree plus random extra links.
  let graphs = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const n = 2 + Math.floor(r() * 9);
    const net = new Net();
    for (let i = 0; i < n; i++) net.addNode('g' + i);
    for (let i = 1; i < n; i++) net.link('g' + i, 'g' + Math.floor(r() * i));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (r() < 0.2) net.link('g' + i, 'g' + j);
      }
    }
    net.start(wide);
    const links = directedLinks(net);
    for (let k = 0; k < 10; k++) {
      const origin = 'g' + Math.floor(r() * n);
      const e = net.publish(origin, nextItem());
      // Random delivery order: items reach nodes in any order the network likes.
      net.run((len) => Math.floor(r() * len));
      net.assertExactlyOnce(e, `random graph seed=${seed} n=${n}`);
      assert.ok(e.sends() <= links, `random graph seed=${seed}: sends ${e.sends()} > directed links ${links}`);
    }
    graphs += 1;
  }
  assert.strictEqual(graphs, 300);
}

// 3. Legacy peers (mesh:false, no stamps).
{
  // Mesh A-B-C with legacy leaf L attached to B.
  const net = new Net().addNode('A').addNode('B').addNode('C').addNode('L', true);
  net.link('A', 'B').link('B', 'C').link('B', 'L').start(OPTS);

  // An item from the legacy leaf reaches every mesh node once.
  const fromLeaf = net.legacySend('L', nextItem());
  net.run();
  for (const id of ['A', 'B', 'C']) {
    assert.strictEqual(net.nodes.get(id).applied.get(fromLeaf.item), 1, `legacy origin: ${id} applies once`);
  }
  assert.strictEqual(fromLeaf.sends(), 3, 'legacy origin: leaf->B, B->A, B->C');

  // An item from A reaches the legacy leaf once, and it arrives with no stamp fields.
  const toLeaf = net.publish('A', nextItem());
  net.run();
  net.assertExactlyOnce(toLeaf, 'item to legacy leaf');
  const stampKeys = net.nodes.get('L').raw.filter((keys) => keys.includes('item'));
  assert.strictEqual(stampKeys.length, 1, 'legacy leaf got exactly one item (the one from A)');
  for (const keys of stampKeys) {
    for (const f of ['o', 's', 'd', 'h']) {
      assert.ok(!keys.includes(f), `legacy leaf received a message with field ${f}`);
    }
  }
}

// 3b. Legacy items in a loop: a triangle A-B-C with the legacy leaf L on B. Two different items
// from L must each be applied once everywhere. Without the stamp given at B, both items would share
// one dedupe key and the second would be dropped.
{
  const net = new Net().addNode('A').addNode('B').addNode('C').addNode('L', true);
  net.link('A', 'B').link('B', 'C').link('A', 'C').link('B', 'L').start(OPTS);
  const first = net.legacySend('L', nextItem());
  net.run();
  net.assertExactlyOnce(first, 'legacy loop item 1');
  const second = net.legacySend('L', nextItem());
  net.run();
  net.assertExactlyOnce(second, 'legacy loop item 2');
}

// 4. Own echo, duplicates, window eviction, hop limit, pool:false.
{
  // 4a. Own echo is dropped.
  const sent = [];
  const peers = [
    { id: 'B', mesh: true, pool: true, send: (m) => (sent.push(['B', m]), true) },
  ];
  const pool = new Pool({ name: 'clip', selfId: 'A', peers: () => peers, seenLimit: 3, maxHops: 3 });
  const published = pool.publish({ item: 'mine' });
  assert.strictEqual(published.msg.o, 'A');
  assert.strictEqual(published.msg.s, 1);
  assert.deepStrictEqual(published.msg.d, ['B']);
  assert.strictEqual(published.msg.h, 0);
  assert.deepStrictEqual(published.sent, ['B']);
  const echo = pool.receive('B', published.msg);
  assert.strictEqual(echo.fresh, false, 'own echo is not fresh');
  assert.strictEqual(pool.stats().droppedEcho, 1);

  // 4b. Duplicate (o, s) is dropped; a different sequence number from the same origin is fresh.
  const dupMsg = { item: 'x', o: 'C', s: 1, d: ['C'], h: 0 };
  assert.strictEqual(pool.receive('B', dupMsg).fresh, true, 'first copy is fresh');
  assert.strictEqual(pool.receive('B', dupMsg).fresh, false, 'second copy is a duplicate');
  assert.strictEqual(pool.stats().droppedDup, 1);

  // 4c. Window eviction, seenLimit = 3: an item is accepted again only after 3 newer items.
  const w = new Pool({ name: 'clip', selfId: 'A', peers: () => [], seenLimit: 3, maxHops: 3 });
  const item = (s) => ({ item: 'w' + s, o: 'C', s, d: ['C'], h: 0 });
  assert.strictEqual(w.receive('X', item(1)).fresh, true);
  assert.strictEqual(w.receive('X', item(2)).fresh, true);
  assert.strictEqual(w.receive('X', item(3)).fresh, true);
  assert.strictEqual(w.receive('X', item(1)).fresh, false, 'still remembered after 2 newer');
  assert.strictEqual(w.receive('X', item(4)).fresh, true, 'newer item is fresh');
  assert.strictEqual(w.receive('X', item(1)).fresh, true, 'evicted after 3 newer: accepted again');
  // The window is per origin: another origin with the same numbers is not affected.
  assert.strictEqual(w.receive('X', { item: 'o', o: 'D', s: 4, d: ['D'], h: 0 }).fresh, true);

  // 4d. pool:false peers get nothing, relay nothing, and their pool items are ignored.
  const log = { B: [], C: [], D: [] };
  const off = new Pool({
    name: 'clip',
    selfId: 'A',
    seenLimit: 200,
    maxHops: 3,
    peers: () => [
      { id: 'B', mesh: true, pool: true, send: (m) => (log.B.push(m), true) },
      { id: 'C', mesh: true, pool: false, send: (m) => (log.C.push(m), true) },
      { id: 'D', mesh: false, pool: true, send: (m) => (log.D.push(m), true) },
    ],
  });
  const pub = off.publish({ item: 'p' });
  assert.deepStrictEqual(pub.sent, ['B', 'D'], 'publish skips the pool:false peer');
  assert.strictEqual(log.C.length, 0, 'pool:false peer received nothing on publish');
  const incoming = { item: 'q', o: 'E', s: 1, d: ['E'], h: 0 };
  const relayed = off.receive('B', incoming);
  assert.deepStrictEqual(relayed.relayed, ['D'], 'relay skips the pool:false peer');
  assert.strictEqual(log.C.length, 0, 'pool:false peer received nothing on relay');
  const fromOff = off.receive('C', { item: 'r', o: 'E', s: 2, d: ['E'], h: 0 });
  assert.strictEqual(fromOff.fresh, false, 'items from a pool:false peer are ignored');
  assert.strictEqual(off.stats().droppedOff, 1);
  // A relayed copy to a legacy peer carries no stamps.
  assert.ok(!('o' in log.D[1]) && !('s' in log.D[1]), 'legacy peer gets a plain message');
  assert.strictEqual(log.D[1].item, 'q');
}

// 4e. Hop limit, exactly: origin N0 on a line of 10 nodes, maxHops = 3.
// A relay happens only when h+1 <= maxHops. N1 gets h=0, N2 gets h=1, N3 gets h=2, N4 gets h=3.
// N4 would relay with h=4, which is above 3, so N5 never gets the item.
{
  const net = new Net();
  for (let i = 0; i < 10; i++) net.addNode('N' + i);
  for (let i = 0; i < 9; i++) net.link('N' + i, 'N' + (i + 1));
  net.start({ seenLimit: 200, maxHops: 3 });
  const e = net.publish('N0', nextItem());
  net.run();
  for (let i = 1; i <= 4; i++) {
    assert.strictEqual(net.nodes.get('N' + i).applied.get(e.item), 1, `hop limit: N${i} gets it`);
  }
  for (let i = 5; i < 10; i++) {
    assert.strictEqual(net.nodes.get('N' + i).applied.get(e.item) || 0, 0, `hop limit: N${i} is beyond reach`);
  }
  assert.strictEqual(e.sends(), 4, 'hop limit: 4 sends (N0..N4 links)');
}

// 5. (in the registry and roster tests) — not here.

// 6a. Two items from the same origin arrive out of order through different paths.
// Diamond: O-A-C and O-B-C. Item 2 reaches C through B before item 1 arrives.
{
  const net = new Net().addNode('O').addNode('A').addNode('B').addNode('C');
  net.link('O', 'A').link('O', 'B').link('A', 'C').link('B', 'C').start(OPTS);
  const first = net.publish('O', 'first');
  const second = net.publish('O', 'second');
  // Queue order: O->A(1), O->B(1), O->A(2), O->B(2). Pick O->B(2) first, then everything in FIFO.
  const pickSecondViaB = (queue) => queue.findIndex((e) => e.from === 'O' && e.to === 'B' && e.msg.item === 'second');
  const idx = pickSecondViaB(net.queue);
  net.deliverAt(idx);
  // B relayed item 2 to C; deliver that before anything else.
  net.deliverAt(net.queue.findIndex((e) => e.from === 'B' && e.to === 'C' && e.msg.item === 'second'));
  assert.strictEqual(net.nodes.get('C').applied.get('second'), 1, 'C has item 2 before item 1');
  assert.strictEqual(net.nodes.get('C').applied.get('first') || 0, 0, 'C does not have item 1 yet');
  net.run();
  net.assertExactlyOnce(first, 'out of order item 1');
  net.assertExactlyOnce(second, 'out of order item 2');
}

// 6b. d omits a peer that is in fact connected: the relay must still reach it.
{
  const sent = [];
  const pool = new Pool({
    name: 'clip',
    selfId: 'X',
    seenLimit: 200,
    maxHops: 3,
    peers: () => [
      { id: 'A', mesh: true, pool: true, send: (m) => (sent.push(['A', m]), true) },
      { id: 'B', mesh: true, pool: true, send: (m) => (sent.push(['B', m]), true) },
    ],
  });
  // The origin O says its links are only [A], but B is connected to X too.
  const r = pool.receive('A', { item: 'stale', o: 'O', s: 1, d: ['A'], h: 0 });
  assert.strictEqual(r.fresh, true);
  assert.deepStrictEqual(r.relayed, ['B'], 'B is relayed to even though d did not list it');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][1].h, 1, 'relay carries h+1');
  assert.strictEqual(sent[0][1].o, 'O', 'relay keeps the origin');
}

console.log('mesh-pool: passed');
