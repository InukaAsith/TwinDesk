// Chains of devices on the Mac (docs/mesh.md, "Shared layout"): real Kvm instances (mac/kvm.js) with fake
// helpers on real sockets. Computers A, B, C sit in a row in the shared layout (A - B - C) and are linked
// (A drives through a link to each). A is the owner (the Mac whose keyboard is used), B the middle device
// (driven, and it hands the input on) and C the end. The same code runs on every node, so each one can be
// any of the three. A phone at the end of a chain is taken through the phone bridge and cannot pass the input on.
// Run with: node mac/test/kvm-chain.test.js  (NODE_PATH as in CI; electron is not needed here)
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const store = require('../store.js');
const { Kvm } = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node: baseNode, close, waitFor, pair, hello, memoryStorage } = require('./lib/mesh.js');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kvm-chain-')));

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function settingsObj() {
  return {
    kvm: {
      pcSide: 'right', mouse: true, keyboard: true, driveOther: true, beDriven: true, linked: true, linkedBy: {},
      resistancePx: 120, speed: 1, reverseScroll: false, gestures: true, hotkeySwitch: false,
    },
    keys: { swapCtrlCmd: true, hotkey: 'AltRight' },
    phone: {},
    layout: null,
  };
}

// A computer: the real hub with its links, and a LayoutSync kept in its settings (as main.js keeps it).
async function node(name, opts = {}) {
  const n = await baseNode(name, opts);
  n.log = [];
  n.extra = [];
  n.settings = settingsObj();
  n.ls = new LayoutSync({
    bus: n.hub.bus,
    mesh: n.mesh,
    selfId: n.id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => [...n.hub.peers().map((p) => p.id), ...n.extra],
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  return n;
}

async function world(names, pairs) {
  const N = {};
  for (const name of names) N[name] = await node(name);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => pairs.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const all = (N) => Object.values(N);
const closeAll = (N) => close(...all(N));

// The helper of a computer as Kvm sees it: send() and request() are recorded, the test emits its events.
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

  request(name, args) {
    this.sent.push({ name, args });
    return Promise.resolve({});
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
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, planDrag: () => null, startDrag: () => null, cancelDrag() {} });
  const drop = { dragIn: { dragging: false, armDrag() {}, onDriven() {}, cancel() {}, release() {} }, cancelDrag() {}, release() {}, armDrag() {} };
  n.kvm = new Kvm({
    hub: n.hub,
    layoutSync: n.ls,
    helper: n.helper,
    getSettings: () => n.settings,
    clipboard: { sendIfChanged: () => true },
    input: { releaseAll() {} },
    drop,
    fileSend,
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
    assert.strictEqual(A.ls.place(N[name].id, ...cells[name]), true, `place ${name}`);
  }
  await waitFor(() => all(N).every((n) => n.ls.get() && n.ls.get().rev === A.ls.get().rev), 'the layout on every computer');
}

test('A - B - C in a row: B hands the input on to the right (C), C hands it back to the left (B), B goes home to A', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    await waitFor(() => B.ls.neighbors().left === A.id && B.ls.neighbors().right === C.id, 'B sees A on its left and C on its right');
    assert.deepStrictEqual(A.ls.neighbors(), { left: null, right: B.id, top: null, bottom: null });
    assert.deepStrictEqual(A.kvm.edges, { left: null, right: B.id, top: null, bottom: null }, 'the Mac edges come from the layout');

    // A drives B through A's right edge.
    const take = await driveVia(A, B, 'right', 0.4);
    assert.strictEqual(take.m.side, 'left', 'B sees the take at its left');
    assert.strictEqual(A.hub.selectedId, B.id);
    // B is driven: its return watch covers both sides with a device behind them (left: A, right: C).
    await waitFor(() => B.kvm.mode === 'driven', 'B is driven');
    assert.deepStrictEqual(B.helper.last('armReturn').sides, ['left', 'right'], 'B watches the way back and the edge to C');
    assert.strictEqual(B.helper.last('armReturn').on, true);

    // B's pointer leaves to the right: A releases B and takes C (the same offset, the side opposite to right).
    B.helper.emit('event', 'return', { side: 'right', offset: 0.3 });
    await waitFor(() => got(C, T.KVM_TAKE).length === 1, 'C gets kvm.take');
    const takeC = got(C, T.KVM_TAKE)[0].m;
    assert.strictEqual(takeC.side, 'left', 'C sees the take at its left: the side opposite to B’s right');
    assert.strictEqual(takeC.offset, 0.3, 'the same offset');
    await waitFor(() => got(B, T.KVM_RELEASE).length === 1, 'B gets kvm.release');
    assert.strictEqual(got(B, T.KVM_HOME).length, 0, 'B did not send kvm.home: it was passed on');
    await waitFor(() => B.kvm.mode === 'home', 'B is home');
    assert.strictEqual(B.helper.last('armReturn').on, false, 'B stops watching its edges');
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === C.id && A.hub.selectedId === C.id, 'A drives C');
    assert.strictEqual(A.kvm.keyboardOnly, false, 'the keyboard owner role is kept');
    assert.deepStrictEqual(C.helper.last('armReturn').sides, ['left'], 'C watches only its edge to B');

    // C's pointer leaves to the left, towards B (not the owner A): A takes B again, from the right.
    C.helper.emit('event', 'return', { side: 'left', offset: 0.6 });
    await waitFor(() => got(B, T.KVM_TAKE).length === 2, 'B is taken again');
    const takeB = got(B, T.KVM_TAKE)[1].m;
    assert.strictEqual(takeB.side, 'right', 'B sees the take at its right');
    assert.strictEqual(takeB.offset, 0.6);
    await waitFor(() => got(C, T.KVM_RELEASE).length === 1, 'C gets kvm.release');
    await waitFor(() => A.kvm.partner === B.id && A.hub.selectedId === B.id && A.kvm.mode === 'driving', 'A drives B again');
    await waitFor(() => C.kvm.mode === 'home', 'C is home');
    assert.strictEqual(got(C, T.KVM_HOME).length, 0);

    // B's pointer leaves to the left, back to A: kvm.home, and A is home.
    B.helper.emit('event', 'return', { side: 'left', offset: 0.2 });
    await waitFor(() => A.kvm.mode === 'home', 'A is home');
    await waitFor(() => B.kvm.mode === 'home', 'B is home');
    assert.strictEqual(got(A, T.KVM_HOME).length, 1, 'A got kvm.home from B');
    assert.strictEqual(A.hub.selectedId, B.id, 'going home keeps the selection');
    assert.strictEqual(A.helper.last('capture').on, false, 'A stops capturing');
    snaps(N);
  } finally {
    closeAll(N);
  }
});

test('kvm.next from the wrong device or to the wrong device is ignored: A keeps driving B', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    await driveVia(A, B, 'right');
    const route = A.kvm.route;
    const next = (from, body) => from.hub.bus.send(A.id, { t: T.KVM_NEXT, route, offset: 0.5, ...body });

    const wrong = [
      { to: A.id, side: 'right' }, // A is on B’s left, not on its right
      { to: C.id, side: 'left' }, // C is on B’s right, not on its left
      { to: C.id, side: 'top' }, // no device on top
      { to: B.id, side: 'right' }, // to itself
      { to: C.id, side: 'diagonal' }, // not a side
      { side: 'right' }, // no device named
      { to: C.id, side: 'right', route: route + 5 }, // a route A is not in
    ];
    for (const body of wrong) {
      next(B, body);
      await sleep(60);
      assert.strictEqual(A.kvm.partner, B.id, `ignored: ${JSON.stringify(body)}`);
      assert.strictEqual(got(C, T.KVM_TAKE).length, 0, `no take of C: ${JSON.stringify(body)}`);
      assert.strictEqual(A.kvm.mode, 'driving');
    }
    // The right one takes C (so the checks above were not passing for the wrong reason).
    next(B, { to: C.id, side: 'right' });
    await waitFor(() => got(C, T.KVM_TAKE).length === 1, 'the valid kvm.next takes C');

    // A drives C now. B is no longer driven by A, so a move asked by B is ignored: no release of C, no take.
    assert.strictEqual(A.kvm.partner, C.id);
    B.hub.bus.send(A.id, { t: T.KVM_NEXT, route: A.kvm.route, to: C.id, side: 'right', offset: 0.5 });
    await sleep(200);
    assert.strictEqual(A.kvm.partner, C.id, 'still driving C');
    assert.strictEqual(got(C, T.KVM_RELEASE).length, 0, 'C was not released');
    assert.strictEqual(got(B, T.KVM_TAKE).length, 1, 'no second take of B');
    assert.strictEqual(got(C, T.KVM_TAKE).length, 1, 'no second take of C');
    snaps(N);
  } finally {
    closeAll(N);
  }
});

test('kvm.next is ignored while nothing is driven (no chain without a drive)', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    B.hub.bus.send(A.id, { t: T.KVM_NEXT, route: 1, to: C.id, side: 'right', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(A.kvm.mode, 'home');
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0, 'nothing taken');
    snaps(N);
  } finally {
    closeAll(N);
  }
});

test('an edge with no device behind it does nothing: the helper is told to stop capturing', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    A.helper.emit('event', 'edge', { side: 'top', offset: 0.5 }); // nothing above A
    await sleep(120);
    assert.strictEqual(A.kvm.mode, 'home');
    assert.strictEqual(got(B, T.KVM_TAKE).length, 0);
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0);
    assert.strictEqual(A.helper.last('capture').on, false);
  } finally {
    closeAll(N);
  }
});

test('the device in the middle drops while driven: the owner goes home; a drop of it after the chain moved on leaves the owner on C', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N);
    await driveVia(A, B, 'right');
    A.links.get(B.id).ws.terminate();
    await waitFor(() => A.kvm.mode === 'home', 'A home when B dropped');
    assert.match(A.kvm.message, /disconnected/);
    snaps(N);

    // B is back, the chain runs to C, and then B drops: A keeps driving C.
    await waitFor(() => A.hub.sessions.get(B.id).connected && B.hub.sessions.get(A.id).connected, 'B is back', 20000);
    await driveVia(A, B, 'right');
    B.helper.emit('event', 'return', { side: 'right', offset: 0.5 });
    await waitFor(() => A.kvm.partner === C.id && A.kvm.mode === 'driving', 'A drives C');
    A.links.get(B.id).ws.terminate();
    await waitFor(() => !A.hub.sessions.get(B.id).connected, 'B dropped on A');
    assert.strictEqual(A.kvm.mode, 'driving', 'still driving C');
    assert.strictEqual(A.kvm.partner, C.id);
    A.kvm.home();
    await waitFor(() => A.kvm.mode === 'home', 'A home');
    snaps(N);
  } finally {
    closeAll(N);
  }
});

test('a phone at the end of a chain: taken through the phone bridge, and it cannot pass the input on', async () => {
  // The phone is paired with A (its record is in A’s storage, as an earlier pairing would have left it).
  const phoneId = P.randomHex(16);
  const token = P.randomHex(32);
  const storage = memoryStorage();
  storage.write('paired.json', [{ id: phoneId, name: 'Phone', os: P.OS.ANDROID, tokenHash: P.sha256Hex(token), pairedAt: 1, lastSeen: 1 }]);
  const A = await node('A', { storage });
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  let phone = null;
  try {
    await pair(B, A);
    await pair(C, A);
    await pair(B, C);
    await waitFor(() => all(N).every((x) => all(N).every((y) => x === y || (x.hub.sessions.get(y.id) && x.hub.sessions.get(y.id).connected))), 'the triangle is up');
    kvmOn(A); kvmOn(B); kvmOn(C);
    phone = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token });
    assert.strictEqual(phone.reply.t, T.WELCOME, 'the phone is welcomed');
    await waitFor(() => A.hub.sessions.get(phoneId) && A.hub.sessions.get(phoneId).connected, 'the phone is connected to A');
    B.extra = [phoneId];

    // The phone bridge: takes the input for the phone and answers the take (the reply hook, kvm.attachLocal).
    const localLog = [];
    const bridge = {
      drives: (id) => id === phoneId,
      handle: (m) => {
        localLog.push(m);
        if (m.t === T.KVM_TAKE) setImmediate(() => bridge.reply({ t: T.KVM_ACCEPT, route: m.route }));
      },
    };
    A.kvm.attachLocal(bridge);
    await row(N, { A: [0, 0], B: [1, 0], C: [0, 1] });
    assert.ok(A.ls.place(phoneId, 2, 0), 'the phone placed right of B');
    await waitFor(() => B.ls.neighbors().right === phoneId && B.ls.neighbors().left === A.id, 'B sees the phone on its right');

    await driveVia(A, B, 'right');
    B.helper.emit('event', 'return', { side: 'right', offset: 0.4 });
    await waitFor(() => localLog.some((m) => m.t === T.KVM_TAKE), 'the phone is taken through the bridge');
    const take = localLog.find((m) => m.t === T.KVM_TAKE);
    assert.strictEqual(take.side, 'left', 'the phone sees the take at its left');
    assert.strictEqual(take.offset, 0.4);
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === phoneId, 'A drives the phone');
    assert.strictEqual(A.hub.selectedId, phoneId);
    assert.strictEqual(got(B, T.KVM_RELEASE).length, 1, 'B was released');
    assert.strictEqual(B.kvm.mode, 'home');

    // Input goes to the phone through the bridge, not to B.
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 3, dy: 4 } });
    await waitFor(() => localLog.some((m) => m.t === T.K_MOVE), 'the move goes to the phone');
    assert.strictEqual(got(B, T.K_MOVE).length, 0);

    // The phone has no edges of its own: a kvm.next from it is ignored, even towards B (on its left).
    phone.client.send({ t: T.KVM_NEXT, route: take.route, to: B.id, side: 'left', offset: 0.5 });
    await sleep(200);
    assert.strictEqual(A.kvm.partner, phoneId, 'still driving the phone');
    assert.strictEqual(got(B, T.KVM_TAKE).length, 1, 'B was not taken again');
    assert.strictEqual(A.kvm.mode, 'driving');
    A.kvm.home();
    await waitFor(() => localLog.some((m) => m.t === T.KVM_RELEASE), 'the phone gets kvm.release through the bridge');
    assert.strictEqual(A.kvm.mode, 'home');
    snaps(N);
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
