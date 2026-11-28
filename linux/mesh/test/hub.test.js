// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The hub (windows/hub.js) on real sockets: real Server, Pairing and LinkManager per node, the real
// pairing protocol, a shared Mesh per node, and the pooled features (Clip, Notifs) over the hub's bus.
// Run with: node linux/mesh/test/hub.test.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../../../shared/protocol.js');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const Clip = require('../clip.js');
const Notifs = require('../notifs.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { HOST, close, waitFor, pair, pairPhone, helloPhone, hello, memoryStorage } = require('./lib/mesh.js');
const { FakeHelper, fakeNotificationFor } = require('./support/fake-net.js');

// A computer: Server + Pairing (host side) + LinkManager (guest side) + Mesh + Hub.
// seed: pairings.json entries written before the LinkManager reads them.
async function hubNode(name, { seed = [] } = {}) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  storage.write('pairings.json', seed);
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  return { name, id, fp: cert.fp, port: server.port, server, pairing, links, storage, mesh, hub };
}

const up = (a, b) => {
  const s = a.hub.sessions.get(b.id);
  return !!s && s.connected;
};
const linked = (a, b) => up(a, b) && up(b, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];

// Every hub's snapshot, as the UI calls it. The unguarded _snapshot() throws where snapshot() would hide it.
function snaps(...nodes) {
  for (const n of nodes) {
    n.hub._snapshot();
    const s = n.hub.snapshot();
    assert.ok(s && Array.isArray(s.peers), `${n.name}: snapshot has peers`);
    assert.ok(s.link && typeof s.link.state === 'string', `${n.name}: snapshot has a link state`);
    assert.ok(Array.isArray(n.hub.peers()), `${n.name}: peers()`);
  }
}

// Nodes by name, paired as `pairs` ([dialer, host] names), all links up before it returns.
async function world(names, pairs, { clip = false, notifs = false } = {}) {
  const N = {};
  for (const name of names) {
    N[name] = await hubNode(name);
    const n = N[name];
    n.counts = { clip: 0, notif: 0 };
    n.hub.bus.on(P.T.CLIP, () => { n.counts.clip += 1; });
    n.hub.bus.on(P.T.NOTIF, () => { n.counts.notif += 1; });
    if (clip) {
      n.clipboard = fakeClipboard();
      n.clipSettings = { enabled: true, send: true, receive: true, mode: 'switch', historySize: 20, maxKB: 256, skipConcealed: true };
      n.clip = new Clip({ bus: n.hub.bus, mesh: n.mesh, getSettings: () => n.clipSettings, onChange: () => {}, clipboard: n.clipboard });
    }
    if (notifs) {
      n.helper = new FakeHelper();
      n.settings = { notifs: { send: true, receive: true, muted: [], hideText: false } };
      n.notifs = new Notifs({
        bus: n.hub.bus,
        mesh: n.mesh,
        helper: n.helper,
        settings: n.settings,
        save: () => {},
        spawn: require('./support/fake-net.js').fakeMonitor().spawn, // no real dbus-monitor in tests
        selfIds: ['TwinDesk.test'],
        peerName: () => '',
        onChange: () => {},
        onClick: () => {},
        Notification: fakeNotificationFor(n),
        selfName: 'PC-' + name,
      });
    }
  }
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  await waitFor(() => pairs.every(([a, b]) => linked(N[a], N[b])), 'every pair linked on both sides');
  return N;
}

function fakeClipboard() {
  const cb = {
    text: '',
    writes: 0,
    readText: async () => cb.text,
    readBuffer: () => Buffer.alloc(0),
    writeText(t) {
      cb.text = t;
      cb.writes += 1;
    },
  };
  return cb;
}

const all = (N) => Object.values(N);
const close3 = (N) => close(...all(N));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('(a) three computers: each lists the other two as connected, and the rosters give every direct link', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    snaps(...all(N));
    for (const n of all(N)) {
      const others = all(N).filter((x) => x !== n).map((x) => x.id).sort();
      const peers = n.hub.peers();
      assert.deepStrictEqual(peers.map((p) => p.id).sort(), others, `${n.name} lists the two others`);
      for (const p of peers) {
        assert.strictEqual(p.state, 'connected');
        assert.strictEqual(p.connected, true);
        assert.strictEqual(p.os, P.OS.LINUX);
      }
      assert.strictEqual(n.mesh.peers().length, 2, `${n.name} has two mesh entries`);
    }
    // In a full triangle each device's direct links are the two others: its roster, as the others see it.
    await waitFor(() => all(N).every((n) => n.hub.peers().every((p) => Array.isArray(p.direct))), 'every roster');
    for (const n of all(N)) {
      for (const p of n.hub.peers()) {
        const expect = all(N).filter((x) => x.id !== p.id).map((x) => x.id).sort();
        assert.deepStrictEqual(p.direct.slice().sort(), expect, `${n.name} knows ${p.name}'s direct links`);
      }
    }
    snaps(...all(N));
    assert.ok(all(N).every((n) => n.hub.selectedId !== null), 'every node has a selected device');
    assert.strictEqual(all(N).filter((n) => n.hub.peers().some((p) => p.selected)).length, 3);
    console.log('  roster and selection: ok');
  } finally {
    close3(N);
  }
});

test('(a2) a partial mesh: the roster of a device with one link lists only that link', async () => {
  const N = await world(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  try {
    await waitFor(() => N.A.hub.peers().find((p) => p.id === N.B.id) && N.A.hub.peers().find((p) => p.id === N.B.id).direct, 'A knows the roster of B');
    const bOnA = N.A.hub.peers().find((p) => p.id === N.B.id);
    assert.deepStrictEqual(bOnA.direct.slice().sort(), [N.A.id, N.C.id].sort(), 'B is linked to A and C');
    const aOnB = N.B.hub.peers().find((p) => p.id === N.A.id);
    assert.deepStrictEqual(aOnB.direct, [N.B.id], 'A is linked to B only');
    assert.strictEqual(N.A.mesh.roster.linked(N.A.id, N.C.id), false, 'A and C are not linked');
    snaps(...all(N));
  } finally {
    close3(N);
  }
});

test('(b) the selection: the facade has no events (step 5), its status and snapshot follow the selected device; a drop moves on, nothing throws', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  try {
    const log = [];
    A.hub.on('selected', (id) => log.push(id ? ['selected', id] : 'none'));
    assert.throws(() => A.hub.facade.on('welcome', () => {}), /no events/, 'nothing routes through the selection');
    const busGot = [];
    A.hub.bus.on('test.ping', (m, from) => busGot.push([m.n, from]));

    assert.strictEqual(A.hub.select(B.id), true, 'B is connected, so it can be selected');
    assert.strictEqual(A.hub.selectedId, B.id, 'selectedId is the id');
    assert.strictEqual(A.hub.selected.id, B.id, 'selected is the session');
    assert.strictEqual(A.hub.select('no-such-device'), false, 'an unknown device is refused');
    log.length = 0;
    snaps(...all(N));

    // Selected or not, every device's message reaches the bus.
    C.hub.bus.send(A.id, { t: 'test.ping', n: 1 });
    await waitFor(() => busGot.some((x) => x[0] === 1), 'C message on the bus');
    B.hub.bus.send(A.id, { t: 'test.ping', n: 2 });
    await waitFor(() => busGot.some((x) => x[0] === 2), 'B message on the bus');
    assert.deepStrictEqual(busGot.map((x) => x[1]).sort(), [B.id, C.id].sort(), 'the bus gets both devices');
    snaps(...all(N));

    // Switch to C: 'selected'; the facade's view is C's.
    assert.strictEqual(A.hub.select(C.id), true);
    assert.deepStrictEqual(log, [['selected', C.id]], 'the hub says the selection changed');
    assert.strictEqual(A.hub.facade.status.state, 'connected');
    assert.strictEqual(A.hub.facade.peerOs, P.OS.LINUX);
    assert.strictEqual(A.hub.facade.snapshot().session.id, C.id, 'the facade snapshot names C');
    B.hub.bus.send(A.id, { t: 'test.ping', n: 3 });
    C.hub.bus.send(A.id, { t: 'test.ping', n: 4 });
    await waitFor(() => busGot.some((x) => x[0] === 4), 'C message after the switch');
    await waitFor(() => busGot.some((x) => x[0] === 3), 'B message after the switch');
    snaps(...all(N));

    // The selected device C drops (its socket is cut): the facade moves to B, nothing throws.
    A.links.get(C.id).ws.terminate();
    await waitFor(() => A.hub.selectedId === B.id, 'selection moves to B');
    assert.deepStrictEqual(log.slice(1), [['selected', B.id]], 'B selected');
    assert.ok(!A.hub.sessions.get(C.id).connected, 'C is down');
    snaps(...all(N));

    // C reconnects (its link dials again). The selection stays on B.
    await waitFor(() => up(A, C), 'C is back');
    assert.strictEqual(A.hub.selectedId, B.id, 'a returning device does not take the selection');
    assert.strictEqual(log.length, 2, 'no extra switch on reconnect');
    C.hub.bus.send(A.id, { t: 'test.ping', n: 5 });
    await waitFor(() => busGot.some((x) => x[0] === 5), 'C message after reconnect');
    snaps(...all(N));

    // Both devices drop: nothing is selected, nothing throws, the facade says not connected yet.
    A.links.get(B.id).ws.terminate();
    A.links.get(C.id).ws.terminate();
    await waitFor(() => A.hub.selectedId === null, 'nothing selected');
    assert.strictEqual(log[log.length - 1], 'none');
    assert.strictEqual(A.hub.facade.status.state, 'connecting', 'paired but not connected: connecting');
    assert.strictEqual(A.hub.facade.send({ t: 'test.ping' }), false, 'a send with nothing selected is refused');
    assert.strictEqual(A.hub.snapshot().session, null);
    snaps(...all(N));

    // The first device back, with nothing selected, is selected by itself.
    await waitFor(() => A.hub.selectedId !== null, 'something selected again');
    assert.deepStrictEqual(log[log.length - 1], ['selected', A.hub.selectedId], 'the device that came back is selected');
    snaps(...all(N));
  } finally {
    close3(N);
  }
});

test('(c) snapshot() after every step: a pending pairing request, a guest pairing, drops, reconnects, forgets; never throws', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  const D = await hubNode('D');
  try {
    snaps(...all(N), D);
    assert.strictEqual(D.hub.snapshot().peers.length, 0, 'nothing paired: no peers');
    assert.strictEqual(D.hub.facade.status.state, 'not_paired');

    // D (a guest) starts pairing with A: A shows a request, D shows the code.
    assert.strictEqual(D.hub.startPairing({ address: HOST, port: A.port, macName: A.name }), true);
    await waitFor(() => A.pairing.pending && A.pairing.pending.code && D.hub.snapshot().pairing && D.hub.snapshot().pairing.phase === 'code', 'the pairing codes');
    const req = A.hub.snapshot();
    assert.strictEqual(req.pairing.phase, 'request', 'A shows a pairing request');
    assert.strictEqual(req.pairing.code, A.pairing.pending.code);
    assert.strictEqual(req.peers.filter((p) => p.connected).length, 2, 'B and C still connected');
    const guest = D.hub.snapshot();
    assert.strictEqual(guest.pairing.phase, 'code');
    assert.match(guest.pairing.code, /^\d{6}$/);
    snaps(...all(N), D);

    // A allows, D confirms: D is now a guest of A and connected.
    A.pairing.respond(true);
    D.hub.confirmCode();
    await waitFor(() => up(A, D) && up(D, A), 'D connected to A');
    assert.ok(A.pairing.list().some((x) => x.id === D.id), 'A keeps D as a guest');
    assert.strictEqual(A.hub.peers().length, 3, 'A now lists B, C and D');
    assert.strictEqual(A.hub.snapshot().pairing, null, 'no request any more');
    snaps(...all(N), D);

    // B's link to A drops and comes back.
    A.links.get(B.id).ws.terminate();
    await waitFor(() => !up(A, B), 'B is down on A');
    snaps(...all(N), D);
    await waitFor(() => linked(A, B), 'B is back');
    snaps(...all(N), D);

    // Forget C on A (its guest link on A goes away), then forget guest D on A (D is told it was forgotten).
    A.hub.forgetPeer(C.id);
    await waitFor(() => !A.hub.peers().some((p) => p.id === C.id), 'C is gone from A');
    snaps(...all(N), D);
    A.hub.forgetGuest(D.id);
    await waitFor(() => !A.hub.peers().some((p) => p.id === D.id), 'D is gone from A');
    snaps(...all(N), D);
    await waitFor(() => D.hub.facade.status.state === 'not_paired', 'D is told it was forgotten');
    assert.strictEqual(D.hub.snapshot().peers.length, 0);
    snaps(...all(N), D);
  } finally {
    close3(N);
    close(D);
  }
});

test('(c2) snapshot() with a phone among computers, and when one selected device is going away', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  const { A, B } = N;
  const phoneId = crypto.randomUUID();
  let phone = null;
  try {
    phone = await pairPhone(A, { id: phoneId, name: 'Phone' });
    const welcome = await helloPhone(phone.client, { id: phoneId, name: 'Phone', token: phone.token });
    assert.strictEqual(welcome.t, P.T.WELCOME, 'the phone is welcomed');
    await waitFor(() => up(A, { id: phoneId, hub: A.hub }), 'the phone is connected to A');
    assert.strictEqual(A.hub.select(phoneId), true, 'the phone can be selected');
    snaps(A, B);
    const s = A.hub.snapshot();
    assert.strictEqual(s.session.os, P.OS.ANDROID, 'the snapshot names the phone as the selected device');
    assert.strictEqual(s.session.role, 'host');
    assert.strictEqual(s.peers.find((p) => p.id === phoneId).selected, true);
    // B (not selected) drops while the phone is selected: the selection stays on the phone.
    A.links.get(B.id).ws.terminate();
    await waitFor(() => !up(A, B), 'B is down on A');
    snaps(A, B);
    assert.strictEqual(A.hub.selectedId, phoneId, 'a drop of another device does not move the selection');
    assert.ok(A.hub.peers().find((p) => p.id === B.id).state !== 'connected', 'B is listed, not connected');
    snaps(A, B);
  } finally {
    if (phone) phone.client.close();
    close3(N);
  }
});

test('(d) Clip over the hub: a copy on A reaches B and C exactly once, nothing bounces back (all linked)', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE, { clip: true, notifs: true });
  const { A, B, C } = N;
  try {
    await waitFor(() => all(N).every((n) => all(N).filter((x) => x !== n).every((x) => n.mesh.get(x.id).notifPool === true)), 'notif policies');
    A.clipboard.text = 'copy on A';
    await A.clip.sendIfChanged('copy');
    await sleep(400);
    for (const n of [B, C]) {
      assert.strictEqual(n.clipboard.text, 'copy on A', `${n.name} has the text`);
      assert.strictEqual(n.clipboard.writes, 1, `${n.name} wrote it to the clipboard once`);
      assert.strictEqual(n.counts.clip, 1, `${n.name} received one clip message`);
      assert.strictEqual(n.clip.pool.stats().relayed, 0, `${n.name} relays nothing in a full mesh`);
    }
    assert.strictEqual(A.counts.clip, 0, 'nothing comes back to A');
    assert.strictEqual(A.clipboard.writes, 0, 'A never writes its own copy back');
    assert.strictEqual(A.clip.pool.stats().received, 0, 'A receives no pool item at all');

    // The other way round: C copies, A and B each get it once.
    const cBefore = C.counts.clip;
    const bBefore = B.counts.clip;
    C.clipboard.text = 'copy on C';
    await C.clip.sendIfChanged('copy');
    await sleep(400);
    assert.strictEqual(A.clipboard.text, 'copy on C');
    assert.strictEqual(B.clipboard.text, 'copy on C');
    assert.strictEqual(A.clipboard.writes, 1);
    assert.strictEqual(B.clipboard.writes, 2);
    assert.strictEqual(B.counts.clip - bBefore, 1, 'B received C\'s copy once');
    assert.strictEqual(C.counts.clip - cBefore, 0, 'nothing comes back to C');
    snaps(A, B, C);
  } finally {
    close3(N);
  }
});

test('(d2) Clip over the hub with the A-C link missing: a copy on A reaches C through B, once', async () => {
  const N = await world(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']], { clip: true });
  const { A, B, C } = N;
  try {
    assert.strictEqual(A.mesh.get(C.id), null, 'A and C are not linked');
    A.clipboard.text = 'through B';
    await A.clip.sendIfChanged('copy');
    await sleep(400);
    assert.strictEqual(B.clipboard.text, 'through B');
    assert.strictEqual(C.clipboard.text, 'through B', 'C gets it through B');
    assert.strictEqual(B.clipboard.writes, 1);
    assert.strictEqual(C.clipboard.writes, 1, 'C writes it once');
    assert.strictEqual(B.clip.pool.stats().relayed, 1, 'B relays it to C');
    assert.strictEqual(C.counts.clip, 1, 'C received one clip message');
    assert.strictEqual(A.counts.clip, 0, 'nothing comes back to A');
    assert.strictEqual(A.clipboard.writes, 0);
    snaps(A, B, C);
  } finally {
    close3(N);
  }
});

test('(d3) Notifs over the hub: a notification on A shows once on B and C; with A-C missing it shows once on C through B', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE, { notifs: true });
  const { A, B, C } = N;
  try {
    await waitFor(() => all(N).every((n) => all(N).filter((x) => x !== n).every((x) => n.mesh.get(x.id).notifPool === true)), 'notif policies');
    A.notifs._local({ id: 'n1', app: 'com.mail', appName: 'Mail', title: 'Hi', subtitle: '', body: 'Body', at: Date.now() });
    await sleep(400);
    for (const n of [B, C]) {
      assert.strictEqual(n.toasts.length, 1, `${n.name} shows it once`);
      assert.strictEqual(n.toasts[0].opts.title, 'Hi');
      assert.strictEqual(n.counts.notif, 1, `${n.name} received one notif message`);
    }
    assert.strictEqual(A.toasts.length, 0, 'A does not show its own notification');
    assert.strictEqual(A.counts.notif, 0, 'nothing comes back to A');
    snaps(A, B, C);
  } finally {
    close3(N);
  }
});

test('(d4) Notifs over the hub with A-C missing: C gets A\'s notification once, through B', async () => {
  const N = await world(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']], { notifs: true });
  const { A, B, C } = N;
  try {
    await waitFor(() => A.mesh.get(B.id).notifPool === true && C.mesh.get(B.id).notifPool === true, 'notif policies');
    A.notifs._local({ id: 'n2', app: 'com.chat', appName: 'Chat', title: 'Yo', subtitle: '', body: 'x', at: Date.now() });
    await sleep(400);
    assert.strictEqual(B.toasts.length, 1, 'B shows it once');
    assert.strictEqual(C.toasts.length, 1, 'C shows it once, relayed by B');
    assert.strictEqual(A.toasts.length, 0);
    assert.strictEqual(C.counts.notif, 1);
    snaps(A, B, C);
  } finally {
    close3(N);
  }
});

test('(e) hello and welcome carry mesh: 1; a phone without the field is a plain peer: welcomed, gets no roster, still works both ways', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  const { A, B } = N;
  const phoneId = crypto.randomUUID();
  let phone = null;
  try {
    phone = await pairPhone(A, { id: phoneId, name: 'Phone' });
    const welcome = await helloPhone(phone.client, { id: phoneId, name: 'Phone', token: phone.token });
    assert.strictEqual(welcome.mesh, 1, 'our welcome carries mesh: 1');
    await waitFor(() => up(A, { id: phoneId, hub: A.hub }), 'the phone is connected');
    assert.strictEqual(A.mesh.get(phoneId).mesh, false, 'the phone is not mesh-capable');
    const seen = [];
    A.hub.bus.on('test.ping', (m, from) => seen.push([m.n, from]));
    phone.client.send({ t: 'test.ping', n: 7 });
    await waitFor(() => seen.some((x) => x[0] === 7), 'the phone message');
    assert.deepStrictEqual(seen.find((x) => x[0] === 7), [7, phoneId], 'the bus names the phone as the sender');
    A.hub.bus.send(phoneId, { t: 'test.ping', n: 8 });
    await phone.client.until((m) => m.t === 'test.ping' && m.n === 8);
    // A is linked to B too, so A sends B a roster; the phone never gets one.
    await sleep(500);
    assert.strictEqual(phone.client.count('mesh.roster'), 0, 'the phone gets no roster');
    await waitFor(() => B.hub.peers().find((p) => p.id === A.id) && B.hub.peers().find((p) => p.id === A.id).direct, 'B has A\'s roster');
    const aOnB = B.hub.peers().find((p) => p.id === A.id);
    assert.ok(aOnB.direct.includes(phoneId), 'A\'s roster, as B sees it, lists the phone as a direct link');
    const phoneOnA = A.hub.peers().find((p) => p.id === phoneId);
    assert.strictEqual(phoneOnA.os, P.OS.ANDROID);
    assert.strictEqual(phoneOnA.direct, null, 'a plain peer has no roster');
    snaps(A, B);
  } finally {
    if (phone) phone.client.close();
    close3(N);
  }
});

test('(e2) a legacy computer (no mesh field in its welcome) is a one-to-one peer: no roster, the bus still works', async () => {
  const cert = loadTestCert();
  const LID = crypto.randomUUID();
  // The legacy computer: a plain server that answers hello with a welcome that has no mesh field.
  const L = new (require('../server.js').Server)({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => L.once('listening', resolve));
  const fromG = [];
  let lctx = null;
  L.on('preauth', (ctx, msg) => {
    fromG.push(msg);
    if (msg.t !== P.T.HELLO) return;
    lctx = ctx;
    L.authenticate(ctx, { deviceId: msg.id, name: msg.name, os: msg.os }, {
      t: P.T.WELCOME, v: P.PROTOCOL_VERSION, macId: LID, macName: 'Legacy', os: P.OS.WIN,
    });
  });
  L.on('message', (msg) => fromG.push(msg));
  const G = await hubNode('G', {
    seed: [{ macId: LID, macName: 'Legacy', address: HOST, port: L.port, fp: cert.fp, token: 'old-token', os: P.OS.WIN }],
  });
  const B = await hubNode('B');
  try {
    G.hub.start();
    await pair(G, B);
    await waitFor(() => up(G, { id: LID, hub: G.hub }), 'the legacy computer is connected to G');
    assert.strictEqual(fromG.find((m) => m.t === P.T.HELLO).mesh, 1, 'our hello carries mesh: 1');
    assert.strictEqual(G.mesh.get(LID).mesh, false, 'the legacy computer is not mesh-capable');
    assert.strictEqual(G.hub.sessions.get(LID).meshCapable, false);
    assert.strictEqual(G.hub.peers().find((p) => p.id === LID).direct, null, 'no roster for a legacy computer');
    const seen = [];
    G.hub.bus.on('test.ping', (m, from) => seen.push([m.n, from]));
    lctx.ws.send(JSON.stringify({ t: 'test.ping', n: 9 }));
    await waitFor(() => seen.some((x) => x[0] === 9), 'the legacy message on the bus');
    assert.deepStrictEqual(seen[0], [9, LID]);
    // G is linked to B as well: its roster goes to B and never to the legacy computer.
    await sleep(500);
    assert.strictEqual(fromG.filter((m) => m.t === 'mesh.roster').length, 0, 'the legacy computer never gets a roster');
    snaps(G, B);
  } finally {
    close(G, B);
    L.close();
  }
});

test('(f) a device that connects again with its id replaces its socket: the selected device restarts, the selection stays', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  const { A, B } = N;
  const phoneId = crypto.randomUUID();
  let phone = null;
  let second = null;
  try {
    phone = await pairPhone(A, { id: phoneId, name: 'Phone' });
    await helloPhone(phone.client, { id: phoneId, name: 'Phone', token: phone.token });
    await waitFor(() => A.hub.sessions.get(phoneId) && A.hub.sessions.get(phoneId).connected, 'the phone is connected');
    assert.strictEqual(A.hub.select(phoneId), true);
    const log = [];
    A.hub.bus.onPeer('closed', (pid) => pid === phoneId && log.push('closed'));
    A.hub.bus.onPeer('welcome', (pid) => pid === phoneId && log.push(['welcome', pid]));
    const removed = [];
    A.hub.on('peerRemoved', (id) => removed.push(id));

    second = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token: phone.token });
    assert.strictEqual(second.reply.t, P.T.WELCOME, 'the second connection is welcomed');
    await waitFor(() => log.length === 2, 'its features start again');
    assert.deepStrictEqual(log, ['closed', ['welcome', phoneId]], 'closed then welcome for the same device');
    assert.strictEqual(A.hub.selectedId, phoneId, 'the selection stays on the phone');
    assert.strictEqual(A.mesh.peers().length, 2, 'the phone is still one mesh entry, next to B');
    assert.strictEqual(A.mesh.get(phoneId).mesh, false);
    assert.ok(A.hub.sessions.get(phoneId).connected);
    snaps(A, B);
  } finally {
    if (phone) phone.client.close();
    if (second) second.client.close();
    close3(N);
  }
});

test('(g) a hub that gets its server late (attachHost): safe before, then the pending request and the dialled device appear', async () => {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const storage = memoryStorage();
  const links = new LinkManager({ device: { id, name: 'L' }, storage });
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name: 'L' }, links, mesh });
  assert.doesNotThrow(() => hub.snapshot(), 'snapshot before the host exists');
  assert.strictEqual(hub.snapshot().host.on, false, 'no host yet');
  assert.deepStrictEqual(hub.peers(), []);
  assert.strictEqual(hub.respondPair(true), undefined, 'respondPair without a pairing does nothing');

  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const pairing = new Pairing(server, { id, name: 'L', fp: cert.fp }, { storage });
  hub.attachHost(server, pairing);
  hub.attachHost(server, pairing); // again: nothing happens
  assert.strictEqual(hub.snapshot().host.on, true, 'listening once attached');
  const B = await hubNode('B');
  try {
    assert.ok(B.links.startPairing({ address: HOST, port: server.port, macName: 'L' }), 'B dials the late host');
    await waitFor(() => pairing.pending && pairing.pending.code, 'the pairing request reaches the late host');
    const req = hub.snapshot();
    assert.strictEqual(req.pairing.phase, 'request', 'the request is shown');
    assert.strictEqual(req.pairing.code, pairing.pending.code);
    snaps({ name: 'L', hub });
    pairing.respond(true);
    B.links.confirmCode();
    await waitFor(() => hub.sessions.get(B.id) && hub.sessions.get(B.id).connected, 'B connected to the late host');
    const peers = hub.peers();
    assert.deepStrictEqual(peers.map((p) => p.id), [B.id], 'B is listed');
    assert.ok(peers[0].connected && peers[0].selected, 'B is connected and selected (the first device)');
    assert.strictEqual(hub.facade.hosting, true, 'the facade sees the dialled device');
    snaps({ name: 'L', hub }, B);
  } finally {
    close(B);
    links.close();
    server.close();
  }
});

test('three devices: audio route stays on B when selection moves to C until the session ends', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const route = N.A.hub.audioRoute();
    const closed = [];
    route.on('closed', () => closed.push(1));
    N.A.hub.select(N.B.id);
    route.refresh();
    assert.strictEqual(route.targetId, N.B.id);
    N.A.hub.setAudioSticky('sound', N.B.id);
    route.refresh();
    assert.strictEqual(route.targetId, N.B.id);
    N.A.hub.select(N.C.id);
    assert.strictEqual(N.A.hub.selectedId, N.C.id);
    route.refresh();
    assert.strictEqual(route.targetId, N.B.id, 'sticky sound: still on B');
    assert.strictEqual(closed.length, 0, 'no closed while sound stays on B');
    N.A.hub.setAudioSticky('sound', null);
    route.refresh();
    assert.strictEqual(route.targetId, N.C.id, 'follows selection when the session ends');
    assert.strictEqual(closed.length, 1);
  } finally {
    close3(N);
  }
});

// Step 5: nothing routes through the selection. Selecting a device replays nothing and switches nothing off
// through the facade; the net hook hears the device it's bound to (hub.netId), whichever is selected. The
// links that move keep what they need themselves (shared/link-memory.js: h3, h2).
test('(h) selecting a device delivers and switches off nothing; the net hook hears its own device', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  try {
    const atB = [];
    B.hub.bus.on('cam.policy', (m, from) => from === A.id && atB.push(m.share));
    assert.strictEqual(A.hub.select(B.id), true);
    const tapped = [];
    A.hub.netTap = (m) => m.t === 'net.caps' && tapped.push(m.host);
    // C says what it can do to leave Bluetooth while B is selected: the net hook, on B, doesn't hear it.
    const onBus = [];
    A.hub.bus.on('net.caps', (m, from) => from === C.id && onBus.push(m.host));
    C.hub.bus.send(A.id, { t: 'net.caps', host: true, join: true, hotspot: false });
    await waitFor(() => onBus.length === 1, 'A heard C');
    assert.deepStrictEqual(tapped, [], 'the net hook is on the selected device (B)');
    // Bound to C (main.js does it while Wi-Fi is set up for C): it hears C, whichever is selected.
    A.hub.netId = C.id;
    C.hub.bus.send(A.id, { t: 'net.caps', host: false, join: true, hotspot: false });
    await waitFor(() => tapped.length === 1, 'the net hook hears C');
    assert.deepStrictEqual(tapped, [false]);
    A.hub.netId = undefined;

    // The facade told B our camera policy; selecting C sends B no goodbye and replays nothing.
    assert.strictEqual(A.hub.facade.send({ t: 'cam.policy', share: true }), true);
    await waitFor(() => atB.length === 1, 'B gets our policy');
    assert.strictEqual(A.hub.select(C.id), true);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(atB, [true], 'no goodbye through the facade: each feature on its own link says its own');
    assert.deepStrictEqual(tapped, [false], 'and no replay into the net hook');

    assert.strictEqual(A.hub.heard, undefined, 'no store of every device’s policies in the hub any more');
  } finally {
    close3(N);
  }
});

// hub.sticky (#313, Move windows): a link that follows the selection unless it's held; held, a visit to a
// third device leaves it with its device; let go, it moves, as a 'closed' and a 'welcome' with what was said.
test('(h3) the sticky link stays with its device while held, then follows the selection', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  try {
    let held = false;
    const link = A.hub.sticky(() => held, { remember: ['papp.policy'] });
    const got = [];
    link.on('welcome', (m) => got.push(['welcome', m.macId]));
    link.on('closed', () => got.push(['closed']));
    link.on('papp.policy', (m) => got.push(['papp.policy', m.accept]));
    assert.strictEqual(A.hub.select(B.id), true);
    assert.strictEqual(link.id, B.id, 'follows the selection');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got, [['welcome', B.id]], 'one welcome for B, made before or after B was selected');
    assert.strictEqual(link.current.deviceId, B.id);
    const atB = [];
    B.hub.bus.on('papp.windows', (m, from) => from === A.id && atB.push(m));
    const policyAtB = [];
    B.hub.bus.on('screen.policy', (m, from) => from === A.id && policyAtB.push(m.accept));
    assert.strictEqual(link.send({ t: 'screen.policy', accept: true }), true); // Monitor 2 watches B

    held = true; // a window moved to B
    const heardC = [];
    A.hub.bus.on('papp.policy', (m, from) => from === C.id && heardC.push(m));
    C.hub.bus.send(A.id, { t: 'papp.policy', accept: true }); // C takes windows (said while B has ours)
    await waitFor(() => heardC.length === 1, 'A heard C (the link keeps it, shared/link-memory.js)');
    got.length = 0;
    assert.strictEqual(A.hub.select(C.id), true); // the pointer visits C
    assert.strictEqual(link.id, B.id, 'held: still B');
    assert.deepStrictEqual(got, [], 'no closed: the windows stay on B');
    assert.strictEqual(link.send({ t: 'papp.windows', windows: [] }), true);
    await waitFor(() => atB.length === 1, 'what it sends still goes to B');
    assert.ok(!got.some((x) => x[0] === 'papp.policy'), 'C\'s messages don\'t reach it while it is on B');

    held = false; // the windows came back
    link.follow();
    assert.strictEqual(link.id, C.id, 'then it follows the selection');
    assert.deepStrictEqual(got, [['closed'], ['welcome', C.id], ['papp.policy', true]], 'closed for B, welcome for C, then what C said');
    await waitFor(() => policyAtB.length === 2, 'B hears we stopped watching');
    assert.deepStrictEqual(policyAtB, [true, false]);
    assert.strictEqual(link.snapshot().link.macName, 'C');
    link.moveTo(B.id); // Monitor 2 follows a device that starts sharing
    assert.strictEqual(link.id, B.id);
    assert.deepStrictEqual(got.slice(-2), [['closed'], ['welcome', B.id]]);
    // C drops: forgotten, so a later move there replays nothing from its old session.
    A.links.get(C.id).ws.terminate();
    await waitFor(() => !up(A, C), 'C down');
    await waitFor(() => up(A, C), 'C back');
    got.length = 0;
    link.moveTo(C.id);
    assert.deepStrictEqual(got, [['closed'], ['welcome', C.id]], 'nothing kept from C’s last session');
  } finally {
    close3(N);
  }
});

test('(h2) the audio route gets the audio.policy a device sent before the route moved to it, and the device it leaves hears accept: false', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  try {
    const route = A.hub.audioRoute();
    const got = [];
    route.on('client', (v) => got.push(['client', v.deviceId]));
    route.on('t:audio.policy', (m) => got.push(['audio.policy', m.accept]));
    const atB = [];
    B.hub.bus.on('audio.policy', (m, from) => from === A.id && atB.push(m.accept));
    A.hub.select(B.id);
    route.refresh();
    assert.strictEqual(route.targetId, B.id);

    const heardC = [];
    A.hub.bus.on('audio.policy', (m, from) => from === C.id && heardC.push(m));
    C.hub.bus.send(A.id, { t: 'audio.policy', accept: true });
    await waitFor(() => heardC.length === 1, 'A heard C (the route keeps it)');
    assert.strictEqual(route.send({ t: 'audio.policy', accept: true }), true);
    await waitFor(() => atB.length === 1, 'B gets our policy');

    got.length = 0;
    A.hub.select(C.id);
    assert.strictEqual(route.targetId, C.id);
    assert.deepStrictEqual(got, [['client', C.id], ['audio.policy', true]], 'C policy played after client');
    await waitFor(() => atB.length === 2, 'B hears accept: false');
    assert.deepStrictEqual(atB, [true, false]);
  } finally {
    close3(N);
  }
});

test('(h4) a scoped link hears its own device with the socket the message came on (#286: a screen detail counts only from the screen session\'s socket)', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  const { A, B, C } = N;
  try {
    const sock = (link) => (typeof link.screenSocket === 'function' ? link.screenSocket() : link.outbound());
    for (const [from, other] of [[B, C], [C, B]]) {
      const link = A.hub.scoped(from.id);
      const got = [];
      link.on(P.T.RTC_DETAIL, (m, ws) => got.push({ m, ws }));
      other.hub.bus.send(A.id, { t: P.T.RTC_DETAIL, session: 9, height: 1440 });
      from.hub.bus.send(A.id, { t: P.T.RTC_DETAIL, session: 7, height: 1080 });
      await waitFor(() => got.length === 1, `A's scoped link for ${from.name} hears it`);
      await sleep(100);
      assert.strictEqual(got.length, 1, `only ${from.name}'s detail, not ${other.name}'s`);
      assert.strictEqual(got[0].m.session, 7);
      const ws = sock(link);
      assert.ok(ws && ws.readyState === 1, `${from.name}: a live socket for its session`);
      assert.strictEqual(got[0].ws, ws, `${from.name}: the detail came on that socket`);
    }
  } finally {
    close3(N);
  }
});

async function main() {
  await runTests(tests);
}

main();
