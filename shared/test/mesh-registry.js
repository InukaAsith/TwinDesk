// Tests for Mesh in shared/mesh.js: the peer registry, roster messages, events, pools wired to it,
// and a small network built from Mesh objects. Also keepalive timing.
// Run with: node shared/test/mesh-registry.js
'use strict';

const assert = require('assert');
const { Mesh, keepalive } = require('../mesh.js');

// The documented values (docs/mesh.md, protocol.js on feature/mesh). Written out here on purpose:
// the tests check the numbers the design promises, not whatever a constant file says.
const DOC = { MAX_DEVICES: 10, PING_MS: 1000, TIMEOUT_MS: 4000, IDLE_PING_MS: 5000, IDLE_TIMEOUT_MS: 15000 };

// Fake send: records what was sent to a peer and reports success.
function sink(log, id) {
  return (msg) => {
    log.push({ to: id, msg });
    return true;
  };
}

// 1. Registry basics, events, MAX_DEVICES.
{
  const m = new Mesh({ selfId: 'A' });
  const added = [];
  const removed = [];
  const rosters = [];
  m.on('peerAdded', (e) => added.push(e.id));
  m.on('peerRemoved', (e) => removed.push(e.id));
  m.on('roster', (id, ids) => rosters.push([id, ids]));

  const log = [];
  assert.strictEqual(m.addPeer({ id: 'B', name: 'b', os: 'win', send: sink(log, 'B'), mesh: true }), true);
  assert.strictEqual(m.addPeer({ id: 'C', name: 'c', os: 'mac', send: sink(log, 'C') }), true);
  assert.strictEqual(m.addPeer({ id: 'B', send: sink(log, 'B') }), false, 'same id twice is refused');
  assert.strictEqual(m.addPeer({ id: 'A', send: sink(log, 'A') }), false, 'our own id is refused');
  assert.deepStrictEqual(added, ['B', 'C'], 'peerAdded fired per accepted peer');
  assert.deepStrictEqual(m.directIds(), ['B', 'C']);
  assert.strictEqual(m.get('C').mesh, false, 'a peer without mesh:true is a legacy peer');
  assert.strictEqual(m.get('C').pool, true, 'pool defaults to on');
  assert.strictEqual(m.get('Z'), null);
  assert.strictEqual(m.peers().length, 2);
  assert.deepStrictEqual(m.rosterMessage(), { t: 'mesh.roster', peers: ['B', 'C'] });
  assert.deepStrictEqual(m.roster.direct('A'), ['B', 'C'], 'our own roster follows our links');

  assert.strictEqual(m.removePeer('C'), true);
  assert.strictEqual(m.removePeer('C'), false, 'removing twice does nothing');
  assert.deepStrictEqual(removed, ['C'], 'peerRemoved fired once');
  assert.strictEqual(m.get('C'), null);
  assert.deepStrictEqual(m.roster.direct('A'), ['B']);
  assert.ok(rosters.length >= 3, 'roster event fires on add and remove');
}

// 1b. The 11th peer is refused; a freed slot can be used again.
{
  const m = new Mesh({ selfId: 'A' });
  const max = DOC.MAX_DEVICES;
  for (let i = 1; i <= max; i++) {
    assert.strictEqual(m.addPeer({ id: 'p' + i, send: () => true }), true, `peer ${i} accepted`);
  }
  assert.strictEqual(m.addPeer({ id: 'p11', send: () => true }), false, 'the 11th peer is refused');
  assert.strictEqual(m.peers().length, max);
  assert.strictEqual(m.get('p11'), null);
  m.removePeer('p3');
  assert.strictEqual(m.addPeer({ id: 'p11', send: () => true }), true, 'a freed slot is usable');
}

// 2. Roster messages update the roster; removing a peer clears it everywhere.
{
  const m = new Mesh({ selfId: 'A' });
  const events = [];
  m.on('roster', (id, ids) => events.push([id, ids]));
  m.addPeer({ id: 'B', send: () => true, mesh: true });
  m.addPeer({ id: 'C', send: () => true, mesh: true });

  // B says it is linked to A, C and D. D is unknown to us, that is fine.
  assert.strictEqual(m.handle('B', { t: 'mesh.roster', peers: ['A', 'C', 'D'] }), true, 'consumed');
  assert.deepStrictEqual(m.roster.direct('B'), ['A', 'C', 'D']);
  assert.strictEqual(m.roster.linked('C', 'B'), true);
  assert.deepStrictEqual(events[events.length - 1], ['B', ['A', 'C', 'D']], 'roster event with the new links');

  // C reports the links it has; after that C is linked to B in our view.
  m.handle('C', { t: 'mesh.roster', peers: ['A', 'B'] });

  // Not a roster message: not consumed.
  assert.strictEqual(m.handle('B', { t: 'clip', text: 'hi' }), false);
  assert.strictEqual(m.handle('B', null), false);

  // A roster from a device that is not connected is consumed but changes nothing.
  assert.strictEqual(m.handle('Z', { t: 'mesh.roster', peers: ['A'] }), true);
  assert.strictEqual(m.roster.direct('Z'), null);

  // Garbage in peers is ignored rather than stored.
  m.handle('C', { t: 'mesh.roster', peers: ['A', 42, null] });
  assert.deepStrictEqual(m.roster.direct('C'), ['A']);

  // Removing B clears B everywhere: its own list, and C's and our links.
  m.removePeer('B');
  assert.strictEqual(m.roster.direct('B'), null);
  assert.ok(!m.roster.direct('C').includes('B'), 'C no longer lists B');
  assert.ok(!m.roster.direct('A').includes('B'), 'we no longer list B');
  for (const [id, list] of Object.entries(m.roster.snapshot())) {
    assert.ok(!list.includes('B'), `${id} still lists B`);
  }
}

// 3. Pools wired to the registry: publish reaches the connected peers, with stamps for mesh peers
//    and plain messages for legacy peers; pool:false is skipped; the pool's d is the direct links.
{
  const m = new Mesh({ selfId: 'A' });
  const log = [];
  m.addPeer({ id: 'B', send: sink(log, 'B'), mesh: true });
  m.addPeer({ id: 'C', send: sink(log, 'C'), mesh: false });
  m.addPeer({ id: 'D', send: sink(log, 'D'), mesh: true });
  m.get('D').pool = false; // the peer switched its pool off

  const clip = m.pool('clip', { seenLimit: 50, maxHops: 3 });
  assert.strictEqual(m.pool('clip'), clip, 'the same pool comes back by name');
  const r = clip.publish({ t: 'clip', text: 'copied' });
  assert.deepStrictEqual(r.sent, ['B', 'C']);
  assert.deepStrictEqual(log.map((x) => x.to), ['B', 'C']);
  assert.strictEqual(log[0].msg.o, 'A');
  assert.strictEqual(log[0].msg.s, 1);
  assert.deepStrictEqual(log[0].msg.d, ['B', 'C', 'D'], 'd lists every direct link, including the pool:false one');
  assert.strictEqual(log[1].msg.o, undefined, 'legacy peer gets no stamps');
  assert.strictEqual(log[1].msg.text, 'copied');
  assert.strictEqual('d' in log[1].msg, false);
}

// 4. A small network of Mesh objects, line A-B-C with one legacy leaf L on B. Each node has a
//    registry and a pool; the item from A reaches every node once; roster messages flow too.
{
  const nodes = {};
  const ids = ['A', 'B', 'C'];
  for (const id of ids) nodes[id] = { mesh: new Mesh({ selfId: id }), applied: [] };
  const linked = [['A', 'B'], ['B', 'C']];
  const wire = (x, y) => {
    nodes[x].mesh.addPeer({
      id: y,
      send: (msg) => {
        deliver(y, x, msg);
        return true;
      },
      mesh: true,
    });
  };
  const applied = {};
  function deliver(to, from, msg) {
    if (msg.t === 'mesh.roster') {
      nodes[to].mesh.handle(from, msg);
      return;
    }
    const r = nodes[to].mesh.pool('clip', { seenLimit: 50, maxHops: 3 }).receive(from, msg);
    if (r.fresh) {
      applied[to] = applied[to] || [];
      applied[to].push(r.msg.item);
    }
  }
  for (const [x, y] of linked) {
    wire(x, y);
    wire(y, x);
  }
  // Roster exchange after the links are up, as the link layer would do.
  for (const id of ids) {
    for (const peer of nodes[id].mesh.peers()) {
      peer.send(nodes[id].mesh.rosterMessage());
    }
  }
  assert.deepStrictEqual(nodes.A.mesh.roster.direct('B'), ['A', 'C'], 'A knows B links to A and C');
  assert.deepStrictEqual(nodes.C.mesh.roster.direct('B'), ['A', 'C'], 'C knows the same links of B');
  assert.strictEqual(nodes.A.mesh.roster.linked('A', 'C'), false, 'A and C are not linked directly');

  nodes.A.mesh.pool('clip', { seenLimit: 50, maxHops: 3 }).publish({ t: 'clip', item: 'x1' });
  assert.deepStrictEqual(applied.B, ['x1'], 'B applied it once');
  assert.deepStrictEqual(applied.C, ['x1'], 'C applied it once, through B');
  assert.strictEqual(applied.A, undefined, 'A did not apply its own item');
}

// 5. keepalive timing.
{
  assert.deepStrictEqual(keepalive({ busy: true }), { intervalMs: DOC.PING_MS, timeoutMs: DOC.TIMEOUT_MS });
  assert.deepStrictEqual(keepalive({ busy: false }), { intervalMs: DOC.IDLE_PING_MS, timeoutMs: DOC.IDLE_TIMEOUT_MS });
  assert.deepStrictEqual(keepalive({}), { intervalMs: DOC.IDLE_PING_MS, timeoutMs: DOC.IDLE_TIMEOUT_MS }, 'not busy by default');
}

console.log('mesh-registry: passed');
