// Joining everyone (windows/autojoin.js, shared/intro.js) on real sockets: W (the hub both others are
// paired to), M (a computer) and P (a guest; its id is the larger one, so M is the host of the pair).
// Run with: node windows/test/autojoin.test.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const { Mesh } = require('../../shared/mesh.js');
const I = require('../../shared/intro.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const { AutoJoin } = require('../autojoin.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const IDS = { W: 'w-0001', M: 'm-0002', P: 'p-0003' };

async function hubNode(name, on = true) {
  const cert = loadTestCert();
  const id = IDS[name];
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  hub.start();
  const n = { name, id, port: server.port, server, pairing, links, storage, mesh, hub, on, seen: [] };
  n.aj = new AutoJoin({ hub, enabled: () => n.on, addrs: () => ['127.0.0.1'], log: () => {} });
  for (const t of [I.ASK, I.REPLY, I.GRANT]) hub.bus.on(t, (m, from) => n.seen.push([t, from, m]));
  return n;
}

const up = (a, b) => {
  const s = a.hub.sessions.get(b.id);
  return !!s && s.connected;
};
const linked = (a, b) => up(a, b) && up(b, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (...nodes) => { for (const n of nodes) n.aj.close(); close(...nodes); };

// M and P are paired to W only.
async function star(on = true) {
  const W = await hubNode('W', on);
  const M = await hubNode('M', on);
  const P = await hubNode('P', on);
  await pair(M, W);
  await pair(P, W);
  await waitFor(() => linked(M, W) && linked(P, W), 'M and P linked to W');
  return { W, M, P };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('M and P get a direct link without any code, and every device lists every device', async () => {
  const { W, M, P } = await star();
  try {
    await waitFor(() => linked(M, P), 'M-P linked by the introduction', 8000);
    assert.ok(M.pairing.list().some((x) => x.id === P.id), 'M (host) holds P');
    assert.ok(P.links.get(M.id), 'P (guest) dials M');
    await waitFor(() => P.mesh.known().find((k) => k.id === M.id && k.direct), 'M direct on P');
    await waitFor(() => [W, M, P].every((a) => [W, M, P].every((b) => a === b || a.mesh.known().some((k) => k.id === b.id))), 'known() lists everyone');
    const names = P.hub.peers({ indirect: true }).map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['M', 'W']);
    await sleep(1500);
    assert.ok(linked(M, P) && linked(M, W) && linked(P, W), 'all three links stay up');
    assert.strictEqual(M.seen.filter(([t]) => t === I.ASK).length, 1, 'one ask only');
  } finally {
    done(W, M, P);
  }
});

test('autoJoin off: no link, but the device is listed as "via"', async () => {
  const { W, M, P } = await star(false);
  try {
    await sleep(2500);
    assert.ok(!linked(M, P) && !P.links.get(M.id), 'no M-P link');
    assert.ok(!W.seen.length && !M.seen.length && !P.seen.length, 'no intro message at all');
    await waitFor(() => P.hub.peers({ indirect: true }).some((p) => p.id === M.id), 'M listed on P');
    const e = P.hub.peers({ indirect: true }).find((p) => p.id === M.id);
    assert.strictEqual(e.state, 'via');
    assert.strictEqual(e.connected, false);
    assert.deepStrictEqual(e.via, ['W']);
    assert.strictEqual(e.name, 'M');
    assert.ok(P.hub.snapshot().peers.some((p) => p.state === 'via'), 'in the snapshot');
    assert.ok(!P.hub.peers().some((p) => p.id === M.id), 'the plain list (layout, edges) stays the paired devices');
  } finally {
    done(W, M, P);
  }
});

test('the host switch alone also stops it: M off refuses the ask', async () => {
  const { W, M, P } = await star(false);
  try {
    W.on = true; P.on = true; // M stays off
    W.aj.schedule();
    await sleep(2500);
    assert.ok(!linked(M, P) && !M.pairing.list().some((x) => x.id === P.id), 'M made no pairing');
  } finally {
    done(W, M, P);
  }
});

test('forged replies and grants are ignored', async () => {
  const { W, M, P } = await star(true);
  try {
    await waitFor(() => linked(M, P), 'the real introduction first');
    // Forget the M-P link on both sides, and block the introducer from asking again.
    P.links.forget(M.id);
    M.pairing.forget(P.id);
    await waitFor(() => !linked(M, P), 'M-P gone');
    W.aj.state.set(`${M.id}>${P.id}`, Date.now());
    const cred = { macId: M.id, macName: 'M', os: 'win', fp: 'ab'.repeat(32), port: M.port, addrs: ['127.0.0.1'], token: 'cd'.repeat(32) };
    // 1. A reply for a request W never made.
    M.hub.sessions.get(W.id).send({ t: I.REPLY, req: 'nope', for: P.id, ok: true, ...cred });
    // 2. A reply for a pending request, from the wrong device (P instead of host M).
    W.aj.pending.add('r1', M.id, P.id);
    P.hub.sessions.get(W.id).send({ t: I.REPLY, req: 'r1', for: P.id, ok: true, ...cred, macId: 'evil' });
    // 3. The right host answers the consumed request: still nothing.
    M.hub.sessions.get(W.id).send({ t: I.REPLY, req: 'r1', for: P.id, ok: true, ...cred });
    // 4. Grants that are malformed, point at P itself or at the introducer.
    W.hub.sessions.get(P.id).send({ t: I.GRANT, req: 'x', ...cred, fp: 'short' });
    W.hub.sessions.get(P.id).send({ t: I.GRANT, req: 'y', ...cred, macId: P.id });
    W.hub.sessions.get(P.id).send({ t: I.GRANT, req: 'z', ...cred, macId: W.id });
    await sleep(1200);
    assert.strictEqual(P.links.list().length, 1, 'P still has only W');
    assert.ok(!P.links.get('evil') && !P.links.get(M.id), 'nothing added');
    assert.ok(!linked(M, P));
    // A well-formed grant from the introducer is stored (the introducer is trusted).
    const hold = P.links.list().length;
    W.hub.sessions.get(P.id).send({ t: I.GRANT, req: 'g', ...cred, macId: 'other-host' });
    await waitFor(() => P.links.get('other-host'), 'a valid grant stored');
    assert.strictEqual(P.links.list().length, hold + 1);
    // And with autoJoin off on P the same grant is ignored.
    P.on = false;
    W.hub.sessions.get(P.id).send({ t: I.GRANT, req: 'g2', ...cred, macId: 'third-host' });
    await sleep(600);
    assert.ok(!P.links.get('third-host'), 'ignored while off');
  } finally {
    done(W, M, P);
  }
});

test('host side: no grant for the asker or for itself, and one grant per guest per 10 s', async () => {
  const { W, M, P } = await star(false);
  try {
    M.on = true;
    const ask = (req, forId) => W.hub.sessions.get(M.id).send({ t: I.ASK, req, for: forId, name: 'Ghost', os: 'win' });
    const reply = (req) => W.seen.find(([t, , m]) => t === I.REPLY && m.req === req);
    ask('a1', W.id); // the asker itself
    ask('a2', M.id); // the host itself
    ask('a3', 'ghost');
    ask('a4', 'ghost');
    await waitFor(() => reply('a1') && reply('a2') && reply('a3') && reply('a4'), 'four replies');
    assert.strictEqual(reply('a1')[2].ok, false);
    assert.strictEqual(reply('a2')[2].ok, false);
    const r3 = reply('a3')[2];
    assert.strictEqual(r3.ok, true);
    assert.ok(I.validGrant(r3), 'the reply is a complete credential');
    assert.strictEqual(r3.macId, M.id);
    assert.strictEqual(r3.port, M.port);
    assert.deepStrictEqual(r3.addrs, ['127.0.0.1']);
    assert.strictEqual(reply('a4')[2].ok, false, 'second grant within 10 s refused');
    assert.ok(M.pairing.list().some((x) => x.id === 'ghost'));
    assert.ok(!M.pairing.list().some((x) => x.id === W.id || x.id === M.id));
  } finally {
    done(W, M, P);
  }
});

test('two devices only: nothing changes', async () => {
  const W = await hubNode('W');
  const M = await hubNode('M');
  try {
    await pair(M, W);
    await waitFor(() => linked(M, W), 'M-W linked');
    await sleep(1200);
    assert.ok(!W.seen.length && !M.seen.length, 'no intro message');
    assert.strictEqual(M.links.list().length, 1);
    assert.strictEqual(W.pairing.list().length, 1);
    assert.deepStrictEqual(W.hub.peers().map((p) => p.state), ['connected']);
    assert.ok(linked(M, W));
  } finally {
    done(W, M);
  }
});

runTests(tests);
