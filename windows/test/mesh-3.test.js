// Three computers, real sockets on loopback, paired through the real pairing protocol.
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair, linked, socketCount, pairPhone, helloPhone, hello } = require('./lib/mesh.js');

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

test('three computers: every link is up at the same time and stays up', async () => {
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
    B.sessions.ensure(A.id).on('test.msg', (m) => got.B_fromA.push(m.n));
    B.sessions.ensure(C.id).on('test.msg', (m) => got.B_fromC.push(m.n));
    C.sessions.ensure(A.id).on('test.msg', (m) => got.C_fromA.push(m.n));
    C.sessions.ensure(B.id).on('test.msg', (m) => got.C_fromB.push(m.n));
    A.sessions.ensure(B.id).on('test.msg', (m) => got.A_fromB.push(m.n));

    assert.ok(A.sessions.get(B.id).send({ t: 'test.msg', n: 1 }), 'A sends to B');
    await waitFor(() => got.B_fromA.length === 1, 'the message on B');
    assert.deepStrictEqual(got.B_fromA, [1]);
    assert.deepStrictEqual(got.B_fromC, [], 'C is not involved');
    assert.deepStrictEqual(got.C_fromA, [], 'nothing from A reached C');

    B.sessions.get(A.id).send({ t: 'test.msg', n: 2 }); // and back: B's session for A
    await waitFor(() => got.A_fromB.length === 1, 'the answer on A');
    assert.deepStrictEqual(got.C_fromB, [], 'nothing from B reached C');
    assert.deepStrictEqual(got.B_fromC, []);
  } finally {
    close(A, B, C);
  }
});

test('a phone (os android, hello as the Android app sends it) stays connected next to two computers', async () => {
  // Computers B and C dial A; a phone pairs with A as well.
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  let phone = null;
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => linked(A, B) && linked(A, C), 'two computers linked to A');
    phone = await pairPhone(A, { name: 'Phone' });
    const w = await helloPhone(phone.client, { id: phone.id, token: phone.token });
    assert.strictEqual(w.t, P.T.WELCOME, 'the phone is welcome (no busy)');
    await waitFor(() => A.server.clients.size === 3, 'three clients on A');
    const ctxB = A.server.clients.get(B.id);
    const ctxC = A.server.clients.get(C.id);
    assert.notStrictEqual(A.server.current.os, P.OS.ANDROID, 'the primary is a computer, not the phone');
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(A.server.clients.size, 3, 'all three still connected');
    assert.strictEqual(A.server.clients.get(B.id), ctxB, 'B not replaced');
    assert.strictEqual(A.server.clients.get(C.id), ctxC, 'C not replaced');
    assert.ok(phone.client.ws.readyState === 1, 'the phone socket is open');
    assert.strictEqual(phone.client.inbox.filter((m) => m.t === P.T.ERROR).length, 0, 'the phone got no error');
    assert.ok(linked(A, B) && linked(A, C), 'the computers are still linked');
  } finally {
    if (phone) phone.client.close();
    close(A, B, C);
  }
});

test('killing one link leaves the others alone, and the dialling side reconnects', async () => {
  const { A, B, C } = await triangle();
  try {
    const ctxAonC = C.server.clients.get(A.id);
    const ctxBonC = C.server.clients.get(B.id);
    A.links.get(B.id).ws.terminate(); // the A-B socket dies
    await waitFor(() => !linked(A, B), 'the A-B link to go down');
    assert.ok(linked(A, C) && linked(B, C), 'the other links stay up');
    assert.strictEqual(C.server.clients.get(A.id), ctxAonC, 'C kept its A socket');
    assert.strictEqual(C.server.clients.get(B.id), ctxBonC, 'C kept its B socket');
    await waitFor(() => linked(A, B), 'A to dial B again', 8000);
    assert.strictEqual(socketCount(A, B), 1, 'one socket again');
    const got = [];
    B.sessions.ensure(A.id).on('test.again', (m) => got.push(m.n));
    A.sessions.get(B.id).send({ t: 'test.again', n: 7 });
    await waitFor(() => got.length === 1, 'a message after the reconnect');
  } finally {
    close(A, B, C);
  }
});

test('a client with the same device id replaces only that device\'s socket', async () => {
  const { A, B, C } = await triangle();
  try {
    const token = A.storage.read('pairings.json', []).find((e) => e.macId === B.id).token;
    const ctxAonC = C.server.clients.get(A.id); // A's other socket, to C
    const oldA = B.server.clients.get(A.id); // A's socket to B
    const restarted = await hello(B.port, { id: A.id, name: 'A restarted', token });
    assert.strictEqual(restarted.reply.t, P.T.WELCOME, 'the same device id is welcome again');
    await waitFor(() => B.server.clients.get(A.id) !== oldA, 'the new A socket');
    await waitFor(() => oldA.ws.readyState === 3, 'the replaced A socket to close'); // 3 = CLOSED
    assert.strictEqual(C.server.clients.get(A.id), ctxAonC, 'A\'s socket to C untouched');
    assert.ok(linked(A, C) && linked(B, C), 'the other links are up');
    restarted.client.close();
  } finally {
    close(A, B, C);
  }
});

test('one pairing at a time: a second computer asking to pair is refused with BUSY, the first still completes', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    assert.ok(A.links.startPairing({ address: '127.0.0.1', port: B.port, macName: 'B' }));
    await waitFor(() => A.links.pairState() && A.links.pairState().phase === 'code' && B.pairing.pending && B.pairing.pending.code, 'A-B code');
    assert.ok(C.links.startPairing({ address: '127.0.0.1', port: B.port, macName: 'B' }));
    await waitFor(() => C.links.pairState() && C.links.pairState().phase === 'failed', 'C refused');
    assert.match(C.links.pairState().error, /already pairing/);
    C.links.cancelPair();
    assert.strictEqual(B.pairing.pending.code, A.links.pairState().code, 'A-B pairing still in progress');
    B.pairing.respond(true);
    A.links.confirmCode();
    await waitFor(() => A.links.get(B.id) && A.links.get(B.id).authed, 'A-B linked');
  } finally {
    close(A, B, C);
  }
});

runTests(tests);
