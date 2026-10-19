// Five computers, every pair paired through the real pairing protocol, real sockets on loopback.
'use strict';

const assert = require('assert');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair, linked, socketCount } = require('./lib/mesh.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function fullMesh(count) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push(await node(`N${i}`));
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) await pair(nodes[i], nodes[j]);
  }
  const pairs = [];
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) pairs.push([nodes[i], nodes[j]]);
  await waitFor(() => pairs.every(([x, y]) => linked(x, y)), 'every pair linked', 15000);
  return { nodes, pairs };
}

test('five computers: all 10 links up at the same time, one socket each, and they stay up', async () => {
  const { nodes, pairs } = await fullMesh(5);
  try {
    assert.strictEqual(nodes.reduce((n, x) => n + x.links.list().length, 0), 10, 'ten guest links in all (each pair dialled once)');
    assert.ok(pairs.every(([x, y]) => socketCount(x, y) === 1), 'one socket per pair');
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(pairs.every(([x, y]) => linked(x, y)), 'all still linked after 2.5 s');
    assert.strictEqual(nodes.reduce((n, x) => n + x.events.length, 0), 0, 'nothing closed');
  } finally {
    close(...nodes);
  }
});

test('five computers: each message reaches exactly the session of its sender, once', async () => {
  const { nodes } = await fullMesh(5);
  try {
    const n = nodes.length;
    // got[dst][src]: how many test.msg from src reached dst's session for src
    const got = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
    nodes.forEach((dst, d) => {
      nodes.forEach((src, s) => {
        if (s === d) return;
        dst.sessions.ensure(src.id).on('test.msg', () => { got[d][s]++; });
      });
    });
    let sent = 0;
    nodes.forEach((src, s) => {
      nodes.forEach((dst, d) => {
        if (s === d) return;
        assert.ok(src.sessions.get(dst.id).send({ t: 'test.msg', from: s, to: d }), `send ${s}->${d}`);
        sent++;
      });
    });
    await waitFor(() => nodes.every((_, d) => nodes.every((__, s) => s === d || got[d][s] === 1)), 'every message delivered', 8000);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(sent, n * (n - 1));
    for (let d = 0; d < n; d++) for (let s = 0; s < n; s++) {
      if (s !== d) assert.strictEqual(got[d][s], 1, `from ${s} to ${d} exactly once`);
    }
  } finally {
    close(...nodes);
  }
});

runTests(tests);
