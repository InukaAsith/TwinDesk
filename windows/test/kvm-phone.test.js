// A phone and a computer connected at the same time: input goes to the device behind the edge (the partner), not to the phone because a phone is connected.
// Computers A, B, C sit in a row in the shared layout (A - B - C) and are all linked (A drives through a
// link to each). A drives B; B's pointer leaves to the right, A releases B and takes C; C's pointer
// leaves to the left, A takes B again; B's pointer leaves to the left, back home. A phone at the end of
// a chain is taken through kvm.local and cannot pass the input on.
// Run with: node windows/test/kvm-chain.test.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Mesh } = require('../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const Kvm = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { normalize } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, pairPhone, helloPhone, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A computer: Server + Pairing + LinkManager + Mesh + Hub + LayoutSync. Extra ids for the layout (a phone
// this computer does not pair with, but places next to it) go in n.extra.
async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub, log: [], kvm: null, extra: [], settings: normalize({}) };
  n.layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => [...hub.peers().map((p) => p.id), ...n.extra],
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
const closeAll = (N) => close(...all(N));

// The helper of a computer as Kvm sees it: send() is recorded, and the test emits its events.
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

  last(name) {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].name === name) return this.sent[i].args;
    return undefined;
  }

  count(name) {
    return this.sent.filter((x) => x.name === name).length;
  }

  stop() {}
}

// A real Kvm on node n, with a recording helper and the kvm messages of its bus recorded.
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
  for (const t of [T.KVM_TAKE, T.KVM_RELEASE, T.KVM_HOME, T.KVM_ACCEPT, T.KVM_NEXT, T.K_MOVE]) {
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

// The row A B C on A's layout, and the same on every node (the layout is synced).
async function row(N, cells = { A: [0, 0], B: [1, 0], C: [2, 0] }) {
  const { A } = N;
  for (const name of Object.keys(cells)) {
    assert.strictEqual(A.layoutSync.place(N[name].id, ...cells[name]), true, `place ${name}`);
  }
  await waitFor(() => all(N).every((n) => n.layoutSync.get() && n.layoutSync.get().rev === A.layoutSync.get().rev), 'the layout on every computer');
}


// The phone bridge as the app has it: drives() answers for the PARTNER it is asked about. The old bridge
// ignored the question (true whenever a phone is connected); a call without an id gets that old answer.
function fakeBridge(A, phone, log, ready = true) {
  return {
    drivable: () => ready,
    drives: (id) => (id === undefined ? true : id === phone.id),
    handle: (m) => {
      log.push(m);
      if (m.t === T.KVM_TAKE) setImmediate(() => A.hub.sessions.get(phone.id).inject({ t: T.KVM_ACCEPT, route: m.route }));
    },
  };
}

test('a phone AND a computer connected: an edge to the computer takes the computer, an edge to the phone takes the phone, neither comes back', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  let phone = null;
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B);
    phone = await pairPhone(A, { name: 'Phone' });
    const w = await helloPhone(phone.client, { id: phone.id, token: phone.token });
    assert.strictEqual(w.t, P.T.WELCOME);
    await waitFor(() => A.hub.sessions.get(phone.id) && A.hub.sessions.get(phone.id).connected, 'the phone is connected to A');
    const localLog = [];
    A.kvm.local = fakeBridge(A, phone, localLog);
    assert.ok(A.layoutSync.place(A.id, 0, 0) && A.layoutSync.place(B.id, -1, 0) && A.layoutSync.place(phone.id, 1, 0), 'B left of A, the phone right');
    await waitFor(() => A.kvm.edges.left === B.id && A.kvm.edges.right === phone.id, 'A edges: left B, right the phone');

    // 1. towards the computer: the take reaches B, not the phone bridge
    const take = await driveVia(A, B, 'left');
    assert.strictEqual(localLog.filter((m) => m.t === T.KVM_TAKE).length, 0, 'the phone bridge got no take meant for B');
    assert.strictEqual(take.m.side, 'right', 'B sees the pointer arrive at its right');
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 800);
    assert.strictEqual(A.kvm.mode, 'driving', 'still driving B after the take timeout');
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 2, dy: 1 } });
    await waitFor(() => got(B, T.K_MOVE).length === 1, 'the move reaches B');
    assert.strictEqual(localLog.filter((m) => m.t === T.K_MOVE).length, 0, 'and not the phone');
    A.kvm.home();
    await waitFor(() => A.kvm.mode === 'home', 'home');

    // 2. towards the phone: the bridge gets the take and answers; B gets nothing
    const takesOfB = got(B, T.KVM_TAKE).length;
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => localLog.some((m) => m.t === T.KVM_TAKE), 'the phone is taken through the bridge');
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === phone.id, 'A drives the phone');
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 800);
    assert.strictEqual(A.kvm.mode, 'driving', 'still driving the phone after the take timeout');
    assert.strictEqual(got(B, T.KVM_TAKE).length, takesOfB, 'B got no take meant for the phone');
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 3, dy: 4 } });
    await waitFor(() => localLog.some((m) => m.t === T.K_MOVE), 'the move goes to the phone');
    assert.strictEqual(got(B, T.K_MOVE).length, 1, 'and not to B');
    snaps(N);
  } finally {
    if (phone) phone.client.close();
    closeAll(N);
  }
});

test('a computer drives B and B’s pointer reaches the phone: B passes the input to the phone itself, and takes it back when the phone hands the pointer back', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  let phone = null;
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B);
    phone = await pairPhone(B, { name: 'Phone' });
    await helloPhone(phone.client, { id: phone.id, token: phone.token });
    await waitFor(() => B.hub.sessions.get(phone.id) && B.hub.sessions.get(phone.id).connected, 'the phone is connected to B');
    const localLog = [];
    B.kvm.local = fakeBridge(B, phone, localLog);
    // A - B - phone in one row
    assert.ok(B.layoutSync.place(A.id, -1, 0) && B.layoutSync.place(B.id, 0, 0) && B.layoutSync.place(phone.id, 1, 0));
    await waitFor(() => A.kvm.edges.right === B.id && B.kvm.edges.right === phone.id, 'A - B - phone');

    await driveVia(A, B, 'right');
    await waitFor(() => B.kvm.mode === 'driven', 'B is driven by A');
    B.helper.emit('event', 'return', { side: 'right', offset: 0.4 });
    await waitFor(() => localLog.some((m) => m.t === T.KVM_TAKE), 'B takes the phone through its own bridge');
    const take = localLog.find((m) => m.t === T.KVM_TAKE);
    assert.strictEqual(take.side, 'left', 'the phone sees the pointer arrive at its left');
    assert.strictEqual(take.offset, 0.4);
    assert.strictEqual(got(A, T.KVM_NEXT).length, 0, 'A was not asked to take the phone: it may have no bridge to it');
    assert.strictEqual(B.helper.last('armReturn').on, false);
    assert.strictEqual(A.kvm.mode, 'driving', 'A keeps driving B');

    // A's input now goes to the phone, not into B
    const injects = B.helper.count('inject');
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 3, dy: 4 } });
    await waitFor(() => localLog.some((m) => m.t === T.K_MOVE), 'A’s move reaches the phone through B');
    assert.strictEqual(B.helper.count('inject'), injects, 'and is not injected into B');

    // the phone hands the pointer back: B is an ordinary driven PC again, at its right edge
    B.hub.sessions.get(phone.id).inject({ t: T.KVM_HOME, route: take.route, offset: 0.7 });
    await waitFor(() => B.helper.last('place') && B.helper.last('place').side === 'right', 'the pointer is back on B’s right edge');
    assert.strictEqual(B.helper.last('place').offset, 0.7);
    assert.strictEqual(B.helper.last('armReturn').on, true);
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 1, dy: 1 } });
    await waitFor(() => B.helper.count('inject') === injects + 1, 'A’s input goes into B again');

    // the driver takes B back while the phone is driven: the phone is released
    B.helper.emit('event', 'return', { side: 'right', offset: 0.5 });
    await waitFor(() => localLog.filter((m) => m.t === T.KVM_TAKE).length === 2, 'the phone is taken again');
    A.kvm.home();
    await waitFor(() => B.kvm.mode === 'home', 'B is home');
    assert.ok(localLog.some((m) => m.t === T.KVM_RELEASE), 'the phone gets kvm.release');
    snaps(N);
  } finally {
    if (phone) phone.client.close();
    closeAll(N);
  }
});

test('B cannot drive the phone itself (the bridge is not ready): B asks A to take it with kvm.next, as before', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  let phone = null;
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B);
    phone = await pairPhone(B, { name: 'Phone' });
    await helloPhone(phone.client, { id: phone.id, token: phone.token });
    await waitFor(() => B.hub.sessions.get(phone.id) && B.hub.sessions.get(phone.id).connected, 'the phone is connected to B');
    const localLog = [];
    B.kvm.local = fakeBridge(B, phone, localLog, false);
    assert.ok(B.layoutSync.place(A.id, -1, 0) && B.layoutSync.place(B.id, 0, 0) && B.layoutSync.place(phone.id, 1, 0));
    await waitFor(() => A.kvm.edges.right === B.id && B.kvm.edges.right === phone.id, 'A - B - phone');
    await driveVia(A, B, 'right');
    await waitFor(() => B.kvm.mode === 'driven', 'B is driven by A');
    B.helper.emit('event', 'return', { side: 'right', offset: 0.4 });
    await waitFor(() => got(A, T.KVM_NEXT).length === 1, 'A is asked to take the phone');
    assert.strictEqual(localLog.length, 0, 'B did not touch its bridge');
  } finally {
    if (phone) phone.client.close();
    closeAll(N);
  }
});

function snaps(N) {
  for (const n of Object.values(N)) {
    const s = n.hub.snapshot();
    assert.ok(s && Array.isArray(s.peers), `${n.name}: snapshot has peers`);
  }
}

runTests(tests);
