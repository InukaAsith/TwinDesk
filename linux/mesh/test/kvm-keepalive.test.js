// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The keep-alive wiring that a bug report caught: with three devices linked, the link that is
// driving or being driven must stay busy so it pings every PING_MS. Otherwise it falls back to the
// idle cadence (IDLE_PING_MS) and the other end's 2 s silence watch (KVM_SILENCE_MS) sends the input
// home over and over. Real Server, Pairing, LinkManager, Hub and Kvm on loopback; A drives B in a
// three-device mesh, and the busy flags on both ends follow the Kvm mode.
// Run with: node linux/mesh/test/kvm-keepalive.test.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const Kvm = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { normalize } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub, log: [], kvm: null, settings: normalize({ kvm: { mouse: true, keyboard: true } }) };
  n.layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => hub.peers().map((p) => p.id),
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  return n;
}

async function world(names, pairs) {
  const N = {};
  for (const name of names) N[name] = await hubNode(name);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => pairs.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const all = (N) => Object.values(N);

// A Kvm that records what it is told to send to the helper; the test emits its events.
class RecHelper extends EventEmitter {
  constructor() {
    super();
    this.running = true;
    this.error = '';
    this.sent = [];
  }

  send(name, args) {
    this.sent.push({ name, args });
  }

  stop() {}
}

function kvmOn(n) {
  n.helper = new RecHelper();
  n.kvm = new Kvm({
    hub: n.hub,
    layoutSync: n.layoutSync,
    helper: n.helper,
    clip: { sendIfChanged: () => true },
    fileDrop: { prepareDrag: () => null, beginDrag() {}, cancelRelease() {} },
    fileRecv: { onRelease() {} },
    dragRecv: null,
    settings: n.settings,
    save: () => {},
    onChange: () => {},
  });
  for (const t of [T.KVM_TAKE, T.KVM_RELEASE, T.KVM_HOME, T.KVM_ACCEPT, T.KVM_NEXT]) {
    n.hub.bus.on(t, (m, from) => n.log.push({ t, from, m }));
  }
  return n.kvm;
}

const got = (n, t) => n.log.filter((x) => x.t === t);

// A drives `to` through `side` of A (the helper saw the edge), and `to` accepts.
async function driveVia(A, to, side, offset = 0.5) {
  const before = got(to, T.KVM_TAKE).length;
  A.helper.emit('event', 'edge', { side, offset });
  await waitFor(() => got(to, T.KVM_TAKE).length === before + 1, `${to.name} gets kvm.take`);
  const take = got(to, T.KVM_TAKE)[before];
  to.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: take.m.route });
  await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === to.id, `A drives ${to.name}`);
  return take;
}

// The row A - B - C on A's layout, synced to every node.
async function row(N, cells = { A: [0, 0], B: [1, 0], C: [2, 0] }) {
  const { A } = N;
  for (const name of Object.keys(cells)) assert.strictEqual(A.layoutSync.place(N[name].id, ...cells[name]), true, `place ${name}`);
  await waitFor(() => all(N).every((n) => n.layoutSync.get() && n.layoutSync.get().rev === A.layoutSync.get().rev), 'the layout on every computer');
}

const busyOn = (n, id) => n.links.busyFlags.get(id) === true && n.server.busyFlags.get(id) === true;
const idleOn = (n, id) => !n.links.busyFlags.has(id) && !n.server.busyFlags.has(id); // back to the default

test('three devices: the link being driven stays busy (pings every PING_MS), and goes idle at home', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    await waitFor(() => B.layoutSync.neighbors().left === A.id, 'B sees A on its left');

    await driveVia(A, B, 'right');

    // A (driving) and B (driven) both mark their partner link busy on either end (guest and host).
    await waitFor(() => busyOn(A, B.id), 'A marks B busy');
    await waitFor(() => busyOn(B, A.id), 'B marks A busy');
    assert.strictEqual(A.kvm._busyId, B.id, 'the busy link on A is B');

    // A goes home (menu "Bring Mouse and Keyboard Back"): the link goes idle again, no leak.
    A.kvm.home();
    await waitFor(() => A.kvm.mode === 'home', 'A is home');
    await waitFor(() => idleOn(A, B.id), 'A unmarks B');
    assert.strictEqual(A.kvm._busyId, null, 'no busy link left on A');
  } finally {
    close(N.A, N.B, N.C);
  }
});

test('three devices: a chain hop moves the busy flag from the released device to the new one', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    await waitFor(() => B.layoutSync.neighbors().left === A.id && B.layoutSync.neighbors().right === C.id, 'B sits between A and C');

    await driveVia(A, B, 'right');
    await waitFor(() => busyOn(A, B.id), 'A marks B busy');

    // B's pointer leaves to the right: A releases B and takes C (kvm.next). The old link must go idle.
    B.helper.emit('event', 'return', { side: 'right', offset: 0.3 });
    await waitFor(() => got(C, T.KVM_TAKE).length === 1, 'C gets kvm.take');
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === C.id, 'A drives C');
    await waitFor(() => busyOn(A, C.id), 'A marks C busy');
    assert.strictEqual(A.kvm._busyId, C.id, 'the busy link on A is C');
    await waitFor(() => idleOn(A, B.id), 'A unmarks the released B');
  } finally {
    close(N.A, N.B, N.C);
  }
});

runTests(tests);
