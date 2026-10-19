// The Mac's server with many clients (adaptive keep-alive with a fake clock) and the tie-break of two
// computers that hold each other (one socket, not two), on real loopback sockets.
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked, socketCount } = require('./lib/mesh.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('keep-alive: a busy client is pinged every PING_MS, an idle one every IDLE_PING_MS', async () => {
  const clock = { t: 1e12 };
  const A = await node('A', { now: () => clock.t, tick: false });
  const B = await node('B');
  try {
    await pair(B, A); // B dials A: A's server holds B as a client
    await waitFor(() => A.server.clients.has(B.id), 'B as a client of A');
    const ctx = A.server.clients.get(B.id);
    const pings = [];
    const orig = A.server.send.bind(A.server);
    A.server.send = (c, msg) => {
      if (msg.t === P.T.PING) pings.push(c.deviceId);
      return orig(c, msg);
    };

    A.server.setBusy(B.id, false);
    ctx.lastTx = clock.t;
    clock.t += P.PING_MS + 100;
    A.server.liveness(clock.t);
    assert.strictEqual(pings.length, 0, 'idle: no ping after one second');
    clock.t += P.IDLE_PING_MS;
    A.server.liveness(clock.t);
    assert.strictEqual(pings.length, 1, 'idle: a ping after IDLE_PING_MS');

    A.server.setBusy(B.id, true);
    ctx.lastTx = clock.t;
    ctx.lastRx = clock.t; // B answers in time (the busy timeout is shorter than the idle one)
    clock.t += P.PING_MS + 100;
    ctx.lastRx = clock.t;
    A.server.liveness(clock.t);
    assert.strictEqual(pings.length, 2, 'busy: a ping after PING_MS');
    assert.strictEqual(A.server.phoneHolds(), false, 'nothing holds the server');
  } finally {
    close(A, B);
  }
});

test('a computer that is busy is never refused: a second device is accepted while one is busy', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    await pair(B, A);
    await waitFor(() => linked(A, B), 'B linked to A');
    A.server.setBusy(B.id, true);
    await pair(C, A); // a second device pairs and connects while B is busy
    await waitFor(() => linked(A, C), 'C linked to A');
    assert.strictEqual(A.server.clients.size, 2, 'both clients are connected');
  } finally {
    close(A, B, C);
  }
});

test('two computers that hold each other keep one socket between them (tie-break)', async () => {
  // A and B pair in both directions: each is a guest of the other. The smaller id dials; the larger
  // one waits for the inbound link and drops its own.
  const small = await node('S', { deviceId: '00000000-0000-4000-8000-000000000001', inboundWaitMs: 300 });
  const large = await node('L', { deviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', inboundWaitMs: 300 });
  try {
    await pair(small, large);
    await pair(large, small);
    await waitFor(() => linked(small, large), 'the pair linked');
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(linked(small, large), 'still linked');
    assert.strictEqual(socketCount(small, large), 1, 'exactly one socket between them (never two)');
  } finally {
    close(small, large);
  }
});

runTests(tests);
