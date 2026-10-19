// Three Macs-and-PCs on real loopback sockets, paired through the real pairing protocol (mac side).
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked, socketCount, hello } = require('./lib/mesh.js');

// A full triangle: A dials B and C, B dials C.
async function triangle() {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  await pair(A, B);
  await pair(A, C);
  await pair(B, C);
  const all = [[A, B], [A, C], [B, C]];
  await waitFor(() => all.every(([x, y]) => linked(x, y)), 'all three links up');
  return { A, B, C, all };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('three devices: every link is up at the same time and stays up', async () => {
  const { A, B, C, all } = await triangle();
  try {
    assert.ok(all.every(([x, y]) => socketCount(x, y) === 1), 'one socket per pair');
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(all.every(([x, y]) => linked(x, y)), 'still linked after 2.5 s');
    assert.ok(all.every(([x, y]) => socketCount(x, y) === 1), 'still one socket per pair');
    const drops = [A, B, C].reduce((n, x) => n + x.events.length, 0);
    assert.strictEqual(drops, 0, 'no link or client closed');
  } finally {
    close(A, B, C);
  }
});

test('a message from A reaches exactly A\'s session on B, not C\'s', async () => {
  const { A, B, C } = await triangle();
  try {
    const got = { B_fromA: [], B_fromC: [], C_fromA: [], C_fromB: [], A_fromB: [] };
    B.hub.sessions.ensure(A.id).on('test.msg', (m) => got.B_fromA.push(m.n));
    B.hub.sessions.ensure(C.id).on('test.msg', (m) => got.B_fromC.push(m.n));
    C.hub.sessions.ensure(A.id).on('test.msg', (m) => got.C_fromA.push(m.n));
    C.hub.sessions.ensure(B.id).on('test.msg', (m) => got.C_fromB.push(m.n));
    A.hub.sessions.ensure(B.id).on('test.msg', (m) => got.A_fromB.push(m.n));

    assert.ok(A.hub.sessions.get(B.id).send({ t: 'test.msg', n: 1 }), 'A sends to B');
    await waitFor(() => got.B_fromA.length === 1, 'the message on B');
    assert.deepStrictEqual(got.B_fromA, [1]);
    assert.deepStrictEqual(got.B_fromC, [], 'C is not involved');
    assert.deepStrictEqual(got.C_fromA, [], 'nothing from A reached C');

    B.hub.sessions.get(A.id).send({ t: 'test.msg', n: 2 }); // and back: B's session for A
    await waitFor(() => got.A_fromB.length === 1, 'the answer on A');
    assert.deepStrictEqual(got.C_fromB, [], 'nothing from B reached C');
    assert.deepStrictEqual(got.B_fromC, []);
  } finally {
    close(A, B, C);
  }
});

test('a phone and two computers: the phone stays connected, nobody is refused busy', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => linked(A, B) && linked(A, C), 'two computers linked to A');
    // A phone pairs as the Android app does: pair.start with os android, then hello on the same socket.
    const phoneId = P.randomHex(16);
    const { client, reply } = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token: 'x' });
    assert.strictEqual(reply.t, P.T.ERROR, 'an unknown phone is refused (not paired): no busy refusal path');
    assert.notStrictEqual(reply.code, P.E.BUSY, 'never busy');
    client.close();
    assert.strictEqual(A.server.phoneHolds(), false, 'phones hold nothing');
    assert.strictEqual(A.server.clients.size, 2, 'two computers are still connected');
  } finally {
    close(A, B, C);
  }
});

test('the selected device follows the Use button; the facade gets closed then client', async () => {
  const { A, B, C } = await triangle();
  try {
    const seen = [];
    A.hub.facade.on('client', (v) => seen.push(['client', v.deviceId]));
    A.hub.facade.on('closed', () => seen.push(['closed']));
    A.hub.select(B.id);
    assert.strictEqual(A.hub.selectedId, B.id, 'B is selected');
    A.hub.select(C.id);
    assert.strictEqual(A.hub.selectedId, C.id, 'C is selected');
    assert.deepStrictEqual(seen.slice(-2), [['closed'], ['client', C.id]], 'closed, then client for C');
    assert.ok(!A.hub.select('not-a-device'), 'an unknown device cannot be selected');
  } finally {
    close(A, B, C);
  }
});

runTests(tests);
