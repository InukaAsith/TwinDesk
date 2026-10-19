// Server with many clients: primary choice, same-device replacement only, per-client keep-alive
// (busy 1 s / idle 5 s) with a fake clock, and no phone exclusivity.
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, hello } = require('./lib/mesh.js');

// A server whose clock is ours; the liveness timer is off (the tests call liveness(now)).
async function fakeServer(clock) {
  const n = await node('host', { now: () => clock.t, tick: false });
  // Paired devices: a token each (the pairing itself is covered by the mesh tests).
  n.devices = {};
  return n;
}

function pairedDevice(n, id, os = P.OS.WIN) {
  const token = P.randomHex(32);
  n.pairing.paired.push({ id, name: id, os, tokenHash: P.sha256Hex(token), pairedAt: 0, lastSeen: 0 });
  return token;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('keep-alive: a busy client pings every 1 s, an idle one every 5 s', async () => {
  const clock = { t: 1000000 };
  const n = await fakeServer(clock);
  try {
    const X = '11111111-0000-4000-8000-000000000001';
    const Y = '11111111-0000-4000-8000-000000000002';
    const tx = pairedDevice(n, X);
    const ty = pairedDevice(n, Y);
    const x = await hello(n.port, { id: X, name: 'X', token: tx });
    const y = await hello(n.port, { id: Y, name: 'Y', token: ty });
    assert.strictEqual(x.reply.t, P.T.WELCOME);
    assert.strictEqual(y.reply.t, P.T.WELCOME);
    n.server.setPrimary(X); // X is busy (the primary); Y is idle
    const t0 = clock.t;

    clock.t = t0 + 1000;
    n.server.liveness();
    await waitFor(() => x.client.count(P.T.PING) === 1, 'X ping at 1 s');
    assert.strictEqual(y.client.count(P.T.PING), 0, 'idle Y must not ping at 1 s');

    clock.t = t0 + 2000;
    n.server.liveness();
    await waitFor(() => x.client.count(P.T.PING) === 2, 'X ping at 2 s');
    assert.strictEqual(y.client.count(P.T.PING), 0);

    clock.t = t0 + 5000;
    n.server.liveness();
    await waitFor(() => y.client.count(P.T.PING) === 1, 'Y ping at 5 s');
    assert.strictEqual(x.client.count(P.T.PING), 3, 'X pings every second');
    x.client.close();
    y.client.close();
  } finally {
    close(n);
  }
});

test('keep-alive: nothing is pinged while something was sent in the interval', async () => {
  const clock = { t: 2000000 };
  const n = await fakeServer(clock);
  try {
    const Y = '22222222-0000-4000-8000-000000000002';
    const ty = pairedDevice(n, Y);
    const y = await hello(n.port, { id: Y, name: 'Y', token: ty });
    n.server.setPrimary(null);
    n.server.setBusy(Y, false);
    const t0 = clock.t;
    clock.t = t0 + 4000;
    n.server.send(n.server.clients.get(Y), { t: 'test.data' }); // an ordinary message resets the timer
    clock.t = t0 + 5000;
    n.server.liveness();
    await waitFor(() => y.client.inbox.some((m) => m.t === 'test.data'), 'the data message');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(y.client.count(P.T.PING), 0, 'no ping 1 s after a message on an idle link');
    clock.t = t0 + 9000;
    n.server.liveness();
    await waitFor(() => y.client.count(P.T.PING) === 1, 'the ping 5 s after the last message');
    y.client.close();
  } finally {
    close(n);
  }
});

test('many clients: a second device never replaces the first; the same device id replaces only itself', async () => {
  const clock = { t: 3000000 };
  const n = await fakeServer(clock);
  try {
    const A = '33333333-0000-4000-8000-00000000000a';
    const B = '33333333-0000-4000-8000-00000000000b';
    const C = '33333333-0000-4000-8000-00000000000c';
    const ta = pairedDevice(n, A);
    const tb = pairedDevice(n, B);
    const tc = pairedDevice(n, C);
    const a = await hello(n.port, { id: A, name: 'A', token: ta });
    const b = await hello(n.port, { id: B, name: 'B', token: tb });
    const c = await hello(n.port, { id: C, name: 'C', token: tc });
    assert.ok([a, b, c].every((x) => x.reply.t === P.T.WELCOME), 'all three are welcome at once');
    assert.strictEqual(n.server.clients.size, 3);
    const ctxB = n.server.clients.get(B);

    const a2 = await hello(n.port, { id: A, name: 'A again', token: ta });
    assert.strictEqual(a2.reply.t, P.T.WELCOME);
    const old = await a.client.until((m) => m.t === P.T.ERROR);
    assert.strictEqual(old.code, P.E.REPLACED, 'the old socket of A is replaced');
    assert.strictEqual(n.server.clients.size, 3, 'still three devices');
    assert.strictEqual(n.server.clients.get(B), ctxB, 'B untouched');
    assert.ok(n.server.clients.get(C), 'C untouched');
    assert.strictEqual(b.client.inbox.filter((m) => m.t === P.T.ERROR).length, 0, 'B got no error');
    a2.client.close();
    b.client.close();
    c.client.close();
  } finally {
    close(n);
  }
});

test('primary: the most recent non-Android client, an explicit choice, and no phone exclusivity', async () => {
  const clock = { t: 4000000 };
  const n = await fakeServer(clock);
  try {
    const W = '44444444-0000-4000-8000-00000000000w';
    const Z = '44444444-0000-4000-8000-00000000000z';
    const Q = '44444444-0000-4000-8000-00000000000q';
    const tw = pairedDevice(n, W);
    const tz = pairedDevice(n, Z);
    const tq = pairedDevice(n, Q, P.OS.ANDROID);
    const w = await hello(n.port, { id: W, name: 'W', token: tw });
    const q = await hello(n.port, { id: Q, name: 'Q', os: P.OS.ANDROID, token: tq });
    const z = await hello(n.port, { id: Z, name: 'Z', token: tz });
    assert.ok([w, q, z].every((x) => x.reply.t === P.T.WELCOME), 'a phone does not hold the session');
    assert.strictEqual(n.server.phoneHolds(), false);
    assert.strictEqual(n.server.phoneGrace, null);
    assert.strictEqual(n.server.current.deviceId, Z, 'the most recent non-Android client is the primary');
    n.server.setPrimary(W);
    assert.strictEqual(n.server.current.deviceId, W, 'setPrimary() chooses');
    n.server.setPrimary(null);
    assert.strictEqual(n.server.current.deviceId, Z, 'null goes back to the automatic choice');
    [w, q, z].forEach((x) => x.client.close());
  } finally {
    close(n);
  }
});

runTests(tests);
