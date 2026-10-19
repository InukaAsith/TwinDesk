'use strict';

// A chain of MAX_DEVICES devices (the worst case for relaying) is covered by the default hop limit.
const assert = require('assert');
const P = require('../protocol.js');
const { Mesh } = require('../mesh');

const N = P.MAX_DEVICES;
const nodes = [];
for (let i = 0; i < N; i++) nodes.push({ id: 'n' + i, mesh: new Mesh({ selfId: 'n' + i }), got: [] });
const byId = new Map(nodes.map((n) => [n.id, n]));
const pools = nodes.map((n) => n.mesh.pool('clip'));

// n(i) <-> n(i+1): each send is delivered to the other node's pool, which applies and relays.
function link(a, b) {
  for (const [from, to] of [[a, b], [b, a]]) {
    from.mesh.addPeer({ id: to.id, mesh: true, send: (msg) => { deliver(to, from.id, msg); return true; } });
  }
}
function deliver(node, fromId, msg) {
  const r = node.mesh.pool('clip').receive(fromId, msg);
  if (r.fresh) node.got.push(msg.text);
}
for (let i = 0; i + 1 < N; i++) link(nodes[i], nodes[i + 1]);

pools[0].publish({ t: 'clip', text: 'from-the-end' });
for (let i = 1; i < N; i++) assert.deepStrictEqual(nodes[i].got, ['from-the-end'], 'n' + i + ' got it exactly once');
assert.deepStrictEqual(nodes[0].got, [], 'the origin does not apply its own item');

// And from the middle, both ways.
for (const n of nodes) n.got.length = 0;
pools[4].publish({ t: 'clip', text: 'from-the-middle' });
for (let i = 0; i < N; i++) if (i !== 4) assert.deepStrictEqual(nodes[i].got, ['from-the-middle'], 'n' + i);
console.log('mesh-chain: passed');
