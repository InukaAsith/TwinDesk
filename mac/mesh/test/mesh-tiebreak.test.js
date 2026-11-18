// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Two computers that hold each other as hosts (each dials the other): exactly one link, the
// smaller device id dials, the larger one waits INBOUND_WAIT_MS before dialling itself.
'use strict';

const assert = require('assert');
const P = require('../../../shared/protocol.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node, close, waitFor, pair, linked, socketCount } = require('./lib/mesh.js');

const LO = 'aaaaaaaa-0000-4000-8000-000000000001'; // smaller id
const HI = 'bbbbbbbb-0000-4000-8000-000000000002'; // larger id

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
    await new Promise((r) => setTimeout(r, 6000));
    assert.strictEqual(socketCount(lo, hi), 1, 'exactly one socket between them');
    assert.ok(linked(lo, hi), 'and it is up');
  } finally {
    close(lo, hi);
  }
});

test('session traffic and liveness use the same surviving link after a simultaneous dial', async () => {
  const { lo, hi } = await mutual({ inboundWaitMs: P.INBOUND_WAIT_MS });
  try {
    await waitFor(() => linked(lo, hi) && socketCount(lo, hi) === 1, 'one link up');
    const sa = lo.hub.sessions.get(HI);
    const sb = hi.hub.sessions.get(LO);
    assert.ok(sa && sb && sa.connected && sb.connected);
    assert.ok(lo.links.get(HI).authed !== hi.links.get(LO).authed, 'only one side keeps the guest socket');
    lo.hub.setBusy(HI, true);
    hi.hub.setBusy(LO, true);
    const rxA = sa.lastRx;
    const rxB = sb.lastRx;
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(sa.lastRx > rxA, 'the selected session lastRx advances on lo');
    assert.ok(sb.lastRx > rxB, 'the selected session lastRx advances on hi');
    assert.strictEqual(socketCount(lo, hi), 1, 'still one socket while keep-alive runs');
  } finally {
    close(lo, hi);
  }
});

test('when the one link drops, the smaller id dials and the larger one does not add a second socket', async () => {
  const { lo, hi } = await mutual();
  try {
    await waitFor(() => linked(lo, hi) && socketCount(lo, hi) === 1, 'one link');
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

runTests(tests);