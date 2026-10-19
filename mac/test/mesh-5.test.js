// Five devices on real loopback sockets: a partial mesh (a chain, items are relayed) and a full mesh
// (every pair linked, items reach every device exactly once, no storm).
'use strict';

const assert = require('assert');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked } = require('./lib/mesh.js');
const { pooled } = require('./lib/pooled.js');

async function fiveNodes() {
  const out = [];
  for (const name of ['A', 'B', 'C', 'D', 'E']) out.push(await node(name));
  return out;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a chain of five: a copy at one end is relayed to the other end, once everywhere', async () => {
  const nodes = await fiveNodes();
  const [A, B, C, D, E] = nodes;
  try {
    await pair(A, B);
    await pair(B, C);
    await pair(C, D);
    await pair(D, E);
    await waitFor(() => linked(A, B) && linked(B, C) && linked(C, D) && linked(D, E), 'the chain up');
    const feats = nodes.map((n) => pooled(n));
    feats.forEach((f) => { f.others = feats.filter((g) => g !== f); });
    await waitFor(() => feats.every((f) => f.node.hub.peers().filter((p) => p.connected).length >= 1), 'every device sees a neighbour');

    feats[0].clipboard.text = 'end to end';
    feats[0].helper.copy('end to end');
    await waitFor(() => feats.slice(1).every((f) => f.clipboard.text === 'end to end'), 'the copy on every device');
    await new Promise((r) => setTimeout(r, 400));
    for (const f of feats.slice(1)) assert.deepStrictEqual(f.clipboard.writes, ['end to end'], `${f.node.name} applied it once`);
    assert.deepStrictEqual(feats[0].clipboard.writes, [], 'the origin applies nothing');
    const sent = feats.map((f) => f.clip.pool.stats().received);
    assert.ok(sent.every((x, i) => i === 0 || x >= 1), 'every device received the item');
  } finally {
    close(...nodes);
  }
});

test('a full mesh of five: every pair linked, a notification reaches every other device once', async () => {
  const nodes = await fiveNodes();
  try {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) await pair(nodes[i], nodes[j]);
    }
    const pairs = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) pairs.push([nodes[i], nodes[j]]);
    await waitFor(() => pairs.every(([x, y]) => linked(x, y)), 'all ten pairs linked');
    await new Promise((r) => setTimeout(r, 300));
    for (const n of nodes) {
      assert.strictEqual(n.hub.peers().filter((p) => p.connected).length, 4, `${n.name} is connected to four others`);
      const sockets = n.server.clients.size + n.links.list().filter((l) => l.authed).length;
      assert.strictEqual(sockets, 4, `${n.name} has one socket to each other device (dialled either way)`);
    }

    const feats = nodes.map((n) => pooled(n));
    feats.forEach((f) => { f.others = feats.filter((g) => g !== f); });
    await waitFor(() => feats.every((f) => f.others.every((g) => f.node.mesh.get(g.node.id) && f.node.mesh.get(g.node.id).notifPool === true)), 'notif policies');

    feats[2].helper.notif({ id: 'n-full', title: 'Full mesh', body: 'hello' });
    await waitFor(() => feats.every((f, i) => i === 2 || f.shown.length === 1), 'the notification on every other device');
    await new Promise((r) => setTimeout(r, 400));
    feats.forEach((f, i) => assert.strictEqual(f.shown.length, i === 2 ? 0 : 1, `${f.node.name} shows it once (or never on its own device)`));
  } finally {
    close(...nodes);
  }
});

runTests(tests);
