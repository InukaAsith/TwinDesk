// Two computers that hold each other as hosts (each dials the other): exactly one link, the
// smaller device id dials, the larger one waits INBOUND_WAIT_MS before dialling itself.
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair, linked, socketCount } = require('./lib/mesh.js');

const LO = 'aaaaaaaa-0000-4000-8000-000000000001'; // smaller id
const HI = 'bbbbbbbb-0000-4000-8000-000000000002'; // larger id

// Both pairings: LO dials HI, then HI dials LO. Each now holds the other as a host.
async function mutual(opts = {}) {
  const lo = await node('lo', { deviceId: LO, ...opts });
  const hi = await node('hi', { deviceId: HI, ...opts });
  await pair(lo, hi);
  await pair(hi, lo);
  return { lo, hi };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('two computers holding each other end with exactly one link', async () => {
  const { lo, hi } = await mutual();
  try {
    await waitFor(() => linked(lo, hi), 'the mutual pair to link');
    await new Promise((r) => setTimeout(r, 6000)); // longer than the wait: nothing doubles up
    assert.strictEqual(socketCount(lo, hi), 1, 'exactly one socket between them');
    assert.ok(linked(lo, hi), 'and it is up');
  } finally {
    close(lo, hi);
  }
});

test('when the one link drops, the smaller id dials and the larger one does not add a second socket', async () => {
  const { lo, hi } = await mutual();
  try {
    await waitFor(() => linked(lo, hi) && socketCount(lo, hi) === 1, 'one link');
    // Whichever side holds the socket, drop it. Then the smaller id must be the one to dial.
    const holder = hi.links.get(LO).authed ? hi : lo;
    holder.links.get(holder === hi ? LO : HI).ws.terminate();
    await waitFor(() => !linked(lo, hi), 'the link to go down');
    await waitFor(() => linked(lo, hi), 'the link to come back', 9000);
    await new Promise((r) => setTimeout(r, 5000));
    assert.strictEqual(socketCount(lo, hi), 1, 'one socket after the reconnect, too');
    assert.ok(lo.links.get(HI).authed, 'the smaller id dialled (its link is the one up)');
    assert.strictEqual(hi.links.get(LO).authed, false, 'the larger id did not dial a second socket');
  } finally {
    close(lo, hi);
  }
});

test('the larger id waits INBOUND_WAIT_MS and then dials itself when the smaller one does not dial', async () => {
  const { lo, hi } = await mutual();
  try {
    await waitFor(() => linked(lo, hi), 'the mutual pair to link');
    // lo stops dialling for good and drops the socket hi dialled (its server still answers):
    // hi has to wait, then dial by itself.
    lo.links.close();
    const t0 = Date.now();
    lo.server.clients.get(HI).ws.terminate();
    await waitFor(() => !linked(lo, hi), 'the link to go down');
    await waitFor(() => hi.links.get(LO).authed, 'hi to dial lo', 15000);
    const waited = Date.now() - t0;
    assert.ok(waited >= P.INBOUND_WAIT_MS - 700, `hi waited ${waited} ms, expected about ${P.INBOUND_WAIT_MS} ms`);
    assert.strictEqual(socketCount(lo, hi), 1, 'one socket, dialled by hi');
  } finally {
    close(lo, hi);
  }
});

runTests(tests);
