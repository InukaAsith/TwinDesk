// Joining everyone (mac/autojoin.js, shared/intro.js) on real loopback sockets: devices paired only
// to one hub node find each other without any pairing of their own.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../../shared/protocol.js');
const I = require('../../shared/intro.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked, socketCount, pairPhone, helloPhone, rawConnect } = require('./lib/mesh.js');
const { AutoJoin } = require('../autojoin.js');

// A node with the auto-join wired as main.js does (autoJoin: the setting; introduce: false = host/guest only).
async function member(name, { autoJoin = true, introduce = true } = {}) {
  const n = await node(name);
  n.settings = { autoJoin };
  n.hub.start();
  n.aj = new AutoJoin({
    hub: n.hub, mesh: n.mesh, pairing: n.pairing, links: n.links, identity: { macId: n.id, macName: name, fp: n.fp }, server: n.server,
    enabled: () => n.settings.autoJoin !== false, addrs: () => ['127.0.0.1'], introduce,
  });
  return n;
}

const knows = (n, id) => n.mesh.known().find((k) => k.id === id);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('two Macs paired only to a hub find each other; the list shows everyone before and after', async () => {
  const W = await member('W');
  const M = await member('M', { introduce: false });
  const Pn = await member('P', { introduce: false });
  M.settings.autoJoin = false; // refused first: only the hub's roster tells M about P
  Pn.settings.autoJoin = false;
  try {
    await pair(M, W);
    await pair(Pn, W);
    await waitFor(() => knows(M, Pn.id) && !knows(M, Pn.id).direct, 'M hears of P through W');
    const peer = M.hub.peers().find((p) => p.id === Pn.id);
    assert.ok(peer, 'the Devices list has P');
    assert.strictEqual(peer.state, 'via');
    assert.deepStrictEqual(peer.via, ['W']);
    assert.strictEqual(peer.name, 'P');
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!linked(M, Pn), 'autoJoin off: no direct link');
    assert.strictEqual(M.pairing.list().length + M.links.list().length, 1, 'nothing was stored');

    M.settings.autoJoin = true;
    Pn.settings.autoJoin = true;
    W.aj.state.clear();
    W.aj.run();
    await waitFor(() => linked(M, Pn), 'M and P linked by themselves');
    assert.strictEqual(socketCount(M, Pn), 1, 'one socket');
    assert.strictEqual(knows(M, Pn.id).direct, true, 'known() has P as direct now');
    assert.ok(!M.hub.peers().some((p) => p.state === 'via'), 'nobody is only "via" any more');
    assert.strictEqual(M.hub.peers().find((p) => p.id === Pn.id).connected, true);
    assert.ok(linked(M, W) && linked(Pn, W), 'the hub links stay up');
  } finally {
    close(W, M, Pn);
  }
});

test('the hub introduces by itself when two devices join', async () => {
  const W = await member('W');
  const M = await member('M', { introduce: false });
  const Pn = await member('P', { introduce: false });
  try {
    await pair(M, W);
    await pair(Pn, W);
    await waitFor(() => linked(M, Pn), 'M and P linked');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(linked(M, Pn) && socketCount(M, Pn) === 1);
    assert.strictEqual(knows(Pn, M.id).direct, true);
  } finally {
    close(W, M, Pn);
  }
});

test('a phone paired to the hub gets a grant for the Mac and can connect with it', async () => {
  const W = await member('W');
  const M = await member('M', { introduce: false });
  let ph = null;
  try {
    await pair(M, W);
    const p = await pairPhone(W, { name: 'Phone' });
    ph = p.client;
    const w = await helloPhone(ph, { id: p.id, token: p.token });
    assert.strictEqual(w.t, P.T.WELCOME);
    const grant = await ph.until((m) => m.t === I.GRANT);
    assert.ok(I.validGrant(grant), 'a valid grant');
    assert.strictEqual(grant.macId, M.id);
    assert.strictEqual(grant.port, M.port);
    assert.strictEqual(grant.fp, M.fp);
    assert.ok(M.pairing.list().some((x) => x.id === p.id), 'M stored a pairing for the phone');
    const again = await require('./lib/mesh.js').hello(M.port, { id: p.id, name: 'Phone', os: P.OS.ANDROID, token: grant.token });
    assert.strictEqual(again.reply.t, P.T.WELCOME, 'the phone gets in with the granted token');
    again.client.close();
    await waitFor(() => knows(M, p.id), 'M lists the phone');
  } finally {
    if (ph) ph.close();
    close(W, M);
  }
});

test('the Mac introduces too: it asks W for the phone that only it knows', async () => {
  const W = await member('W', { introduce: false });
  const M = await member('M');
  let ph = null;
  try {
    const p = await pairPhone(M, { name: 'Phone' });
    ph = p.client;
    assert.strictEqual((await helloPhone(ph, { id: p.id, token: p.token })).t, P.T.WELCOME);
    await pair(W, M);
    const grant = await ph.until((m) => m.t === I.GRANT);
    assert.strictEqual(grant.macId, W.id, 'W hosts: the phone cannot listen');
    assert.ok(W.pairing.list().some((x) => x.id === p.id));
    await waitFor(() => knows(W, p.id), 'W lists the phone through M');
    assert.strictEqual(knows(W, p.id).direct, false);
    assert.strictEqual(W.hub.peers().find((x) => x.id === p.id).state, 'via');
  } finally {
    if (ph) ph.close();
    close(W, M);
  }
});

test('forged and repeated introductions are ignored', async () => {
  const W = await member('W', { introduce: false });
  const M = await member('M', { introduce: false });
  let ph = null;
  try {
    await pair(M, W);
    const p = await pairPhone(M, { name: 'Phone' });
    ph = p.client;
    assert.strictEqual((await helloPhone(ph, { id: p.id, token: p.token })).t, P.T.WELCOME);
    const before = M.pairing.list().length;

    ph.send({ t: I.ASK, req: 'a1', for: p.id }); // for the asker itself
    ph.send({ t: I.ASK, req: 'a2', for: M.id }); // for the host itself
    ph.send({ t: I.ASK, for: 'x' }); // no req
    ph.send({ t: I.GRANT, req: 'g1', macId: 'ghost', fp: 'zz', token: 'nothex', port: 1, addrs: ['127.0.0.1'] }); // bad credential
    ph.send({ t: I.GRANT, req: 'g2', macId: crypto.randomUUID(), fp: 'a'.repeat(64), token: 'ab'.repeat(16), port: 4444, addrs: ['127.0.0.1'] }); // valid shape, from a phone: stored? (an introducer may be any device)
    ph.send({ t: I.REPLY, req: 'nope', ok: true, macId: 'm', fp: 'a'.repeat(64), token: 'ab', port: 4444, addrs: ['127.0.0.1'] }); // a reply nobody asked for
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(M.pairing.list().length, before, 'no pairing for self / asker / malformed asks');
    assert.ok(!ph.inbox.some((m) => m.t === I.REPLY && m.ok), 'no credential for a forged ask');
    assert.strictEqual(M.links.list().filter((l) => l.pairing.macId === 'ghost').length, 0, 'bad grant not stored');

    // The rate limit: one grant per guest per 10 s.
    const guestId = crypto.randomUUID();
    ph.send({ t: I.ASK, req: 'r1', for: guestId, name: 'Other', os: 'android' });
    const r1 = await ph.until((m) => m.t === I.REPLY && m.req === 'r1');
    assert.strictEqual(r1.ok, true);
    ph.send({ t: I.ASK, req: 'r2', for: guestId, name: 'Other', os: 'android' });
    const r2 = await ph.until((m) => m.t === I.REPLY && m.req === 'r2');
    assert.strictEqual(r2.ok, false, 'second grant within 10 s refused');

    // An unauthenticated socket cannot take part at all.
    const raw = await rawConnect(M.port);
    raw.send({ t: I.ASK, req: 'u1', for: guestId });
    await waitFor(() => raw.inbox.some((m) => m.t === P.T.ERROR), 'the stranger is refused');
    assert.ok(!raw.inbox.some((m) => m.t === I.REPLY));
    raw.close();
  } finally {
    if (ph) ph.close();
    close(W, M);
  }
});

test('addGrant: stored like a pairing, once, and the list is capped', async () => {
  const M = await node('M');
  try {
    const g = (i) => ({ macId: `id-${i}`, macName: `N${i}`, os: 'win', address: '10.0.0.1', port: 8443, fp: 'AB:'.repeat(31) + 'AB', token: 'ab'.repeat(16) });
    const added = [];
    M.links.on('add', (l) => added.push(l.pairing.macId));
    assert.strictEqual(M.links.addGrant(g(1)), true);
    assert.strictEqual(M.links.addGrant(g(1)), false, 'already a link');
    assert.strictEqual(M.links.addGrant({ ...g(2), token: 5 }), false, 'invalid');
    assert.deepStrictEqual(added, ['id-1']);
    assert.strictEqual(M.storage.read('hosts.json', []).length, 1);
    for (let i = 2; i < 30; i++) M.links.addGrant(g(i));
    assert.strictEqual(M.links.list().length, P.MAX_DEVICES);
  } finally {
    close(M);
  }
});

runTests(tests);
