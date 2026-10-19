// The cursor edges (windows/kvm.js, shared/kvm-edges.js) on real sockets: node A has a real Kvm with a
// fake helper (it records what it is told and lets the test emit helper events); B and C are other
// computers whose hub bus records the kvm messages they get. Real Server, Pairing, LinkManager, Mesh
// and Hub on every node, paired with the real pairing protocol.
// Run with: node windows/test/kvm-edges.test.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
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
const { normalize, migrateKvm } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const NONE = { left: null, right: null, top: null, bottom: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A computer: Server + Pairing (host side) + LinkManager (guest side) + Mesh + Hub.
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
  return { name, id, port: server.port, server, pairing, links, mesh, hub, log: [] };
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

// Every hub's snapshot, as the UI calls it: must never throw.
function snaps(...nodes) {
  for (const n of nodes) {
    const s = n.hub.snapshot();
    assert.ok(s && Array.isArray(s.peers), `${n.name}: snapshot has peers`);
    assert.ok(s.link && typeof s.link.state === 'string', `${n.name}: snapshot has a link state`);
  }
}

// The helper of A as Kvm sees it: send() is recorded, and the test emits its events.
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

  stop() {}
}

// A real Kvm on node n (the one that drives), with a recording helper.
function kvmOn(n) {
  const settings = normalize({});
  n.helper = new RecHelper();
  n.settings = settings;
  n.kvm = new Kvm({
    hub: n.hub,
    helper: n.helper,
    clip: { sendIfChanged: () => true },
    fileDrop: { prepareDrag: () => null, beginDrag() {}, cancelRelease() {} },
    fileRecv: { onRelease() {} },
    dragRecv: null,
    settings,
    save: () => {},
    onChange: () => {},
  });
  return n.kvm;
}

// The kvm messages a computer gets (the bus of its hub sees them whoever sent them).
const RECORDED = [T.KVM_TAKE, T.KVM_ACCEPT, T.KVM_REFUSE, T.KVM_RELEASE, T.KVM_HOME, T.KVM_LAYOUT, T.KVM_LINK, T.K_MOVE, T.DRAG_POLICY];
function record(n) {
  for (const t of RECORDED) n.hub.bus.on(t, (m, from) => n.log.push({ t, from, m }));
}
const got = (n, t) => n.log.filter((x) => x.t === t);

const sides = (A) => A.helper.last('kvmConfig').sides;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A drives `to` through `side` of A (the helper saw the edge), and `to` accepts.
async function driveVia(A, to, side, offset = 0.5) {
  const before = got(to, T.KVM_TAKE).length;
  A.helper.emit('event', 'edge', { side, offset });
  await waitFor(() => got(to, T.KVM_TAKE).length === before + 1, `${to.name} gets kvm.take`);
  const take = got(to, T.KVM_TAKE)[before];
  to.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: take.m.route });
  await waitFor(() => A.kvm.mode === 'driving', 'A drives after the accept');
  return take;
}

test('top leads to B and bottom to C: each take goes to that device only; B accepts, input reaches B only, going home keeps the selection', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    assert.strictEqual(kvm.setEdge('top', B.id), true);
    assert.deepStrictEqual(A.settings.kvm.edges, { ...NONE, top: B.id });
    await waitFor(() => got(B, T.KVM_LAYOUT).some((x) => x.m.pcSide === 'top'), 'B is told where A is');
    assert.deepStrictEqual(got(C, T.KVM_LAYOUT), [], 'C is told nothing about the top edge');

    const take = await driveVia(A, B, 'top', 0.4);
    assert.strictEqual(take.m.side, 'bottom', 'B sees the take at its bottom: the side opposite to top');
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0, 'C gets no take');
    assert.strictEqual(A.hub.selectedId, B.id, 'crossing selects B');
    assert.strictEqual(kvm.partner, B.id);
    snaps(A, B, C);

    // Accepted: the take timeout does not send A home.
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 300);
    assert.strictEqual(kvm.mode, 'driving', 'accepted: still driving after the take timeout');

    // Input: A's helper events go to B only.
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 5, dy: 2 } });
    await waitFor(() => got(B, T.K_MOVE).length === 1, 'B gets k.move');
    assert.deepStrictEqual({ dx: got(B, T.K_MOVE)[0].m.dx, dy: got(B, T.K_MOVE)[0].m.dy }, { dx: 5, dy: 2 });
    assert.strictEqual(got(B, T.K_MOVE)[0].from, A.id);
    await sleep(100);
    assert.strictEqual(got(C, T.K_MOVE).length, 0, 'C gets no input');

    // Going home (hotkey or the Tray): kvm.release to B only; the selection stays on B.
    kvm.home();
    await waitFor(() => got(B, T.KVM_RELEASE).length === 1, 'B gets kvm.release');
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(A.helper.last('capture').on, false, 'capture is off at home');
    assert.strictEqual(A.hub.selectedId, B.id, 'going home keeps the selection');
    snaps(A, B, C);

    // Bottom leads to C: C takes, and B gets nothing new.
    assert.strictEqual(kvm.setEdge('bottom', C.id), true);
    await waitFor(() => got(C, T.KVM_LAYOUT).some((x) => x.m.pcSide === 'bottom'), 'C is told where A is');
    const takeC = await driveVia(A, C, 'bottom', 0.6);
    assert.strictEqual(takeC.m.side, 'top', 'C sees the take at its top');
    assert.strictEqual(got(B, T.KVM_TAKE).length, 1, 'B got only the first take');
    assert.strictEqual(A.hub.selectedId, C.id);
    kvm.home();
    await waitFor(() => got(C, T.KVM_RELEASE).length === 1, 'C gets kvm.release');
    assert.strictEqual(got(B, T.KVM_RELEASE).length, 1, 'B got no release for C');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('while driving B, an edge that leads to C is ignored: no take to C, still driving B', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    kvm.setEdge('top', B.id);
    kvm.setEdge('bottom', C.id);
    await driveVia(A, B, 'top');
    const before = A.helper.sent.length;
    A.helper.emit('event', 'edge', { side: 'bottom', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(kvm.mode, 'driving');
    assert.strictEqual(kvm.partner, B.id, 'still driving B');
    assert.strictEqual(A.hub.selectedId, B.id);
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0, 'no take to C');
    assert.strictEqual(A.helper.sent.slice(before).length, 0, 'the helper is not told anything');
    snaps(A, B, C);
    kvm.home();
    await waitFor(() => got(B, T.KVM_RELEASE).length === 1, 'B gets kvm.release');
  } finally {
    closeAll(N);
  }
});

test('B drops while A drives it: A goes home without errors; B drops while driving A: A goes home too', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    kvm.setEdge('top', B.id);

    // A drives B, B goes away.
    await driveVia(A, B, 'top');
    A.links.get(B.id).ws.terminate();
    await waitFor(() => kvm.mode === 'home', 'A home after B dropped');
    assert.match(kvm.message, /disconnected/);
    snaps(A, B, C);

    // B drives A (accepted, then B's input reaches A's helper), and B drops: A is home again.
    await waitFor(() => A.hub.sessions.get(B.id).connected, 'B is back');
    B.hub.bus.send(A.id, { t: T.KVM_TAKE, route: 1, side: 'top', offset: 0.5, mouse: true, keyboard: true });
    await waitFor(() => kvm.mode === 'driven', 'A is driven by B');
    await waitFor(() => got(B, T.KVM_ACCEPT).length >= 1, 'B gets kvm.accept');
    B.hub.bus.send(A.id, { t: T.K_MOVE, dx: 1, dy: 1 });
    await waitFor(() => A.helper.sent.some((x) => x.name === 'inject'), 'A injects the move of B');
    C.hub.bus.send(A.id, { t: T.K_MOVE, dx: 9, dy: 9 });
    await sleep(100);
    assert.strictEqual(A.helper.sent.filter((x) => x.name === 'inject').length, 1, 'input from C is not injected while B drives');
    A.links.get(B.id).ws.terminate();
    await waitFor(() => kvm.mode === 'home', 'A home after the driver dropped');
    assert.ok(A.helper.sent.some((x) => x.name === 'releaseAll'), 'A released what it had');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('applyConfig sends sides = the edges whose device is connected and linked; a drop, a return, a switch off', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    const kvm = kvmOn(A);
    kvm.applyConfig();
    assert.deepStrictEqual(sides(A), [], 'no edges: nothing watched');
    kvm.setEdge('top', B.id);
    kvm.setEdge('bottom', C.id);
    assert.deepStrictEqual(sides(A), ['top', 'bottom']);
    assert.strictEqual(A.helper.last('kvmConfig').side, 'top', 'the first side also drives the file strip');
    A.links.get(C.id).ws.terminate();
    await waitFor(() => !A.hub.sessions.get(C.id).connected, 'C dropped');
    assert.deepStrictEqual(sides(A), ['top'], 'C is down: its side is not watched');
    await waitFor(() => A.hub.sessions.get(C.id).connected, 'C is back');
    assert.deepStrictEqual(sides(A), ['top', 'bottom'], 'C is back: watched again');
    // B switches cursor sharing off (kvm.link from B): its side is no longer watched; C's still is.
    B.hub.bus.send(A.id, { t: T.KVM_LINK, on: false });
    await waitFor(() => JSON.stringify(sides(A)) === JSON.stringify(['bottom']), 'B off: only C watched');
    B.hub.bus.send(A.id, { t: T.KVM_LINK, on: true });
    await waitFor(() => JSON.stringify(sides(A)) === JSON.stringify(['top', 'bottom']), 'B on again');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('cursor sharing is per device: a device with it off is not crossed to, the others still are', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    kvm.setEdge('top', B.id);
    kvm.setEdge('bottom', C.id);
    assert.strictEqual(A.hub.select(B.id), true);
    C.hub.bus.send(A.id, { t: T.KVM_LINK, on: false }); // C switches its cursor sharing off, not the selected B
    await waitFor(() => A.settings.kvm.linkedBy[C.id] === false, 'C remembered as off');
    assert.strictEqual(kvm.linked, true, 'the switch of the selected device is still on');
    assert.deepStrictEqual(sides(A), ['top'], 'C is not watched');
    A.helper.emit('event', 'edge', { side: 'bottom', offset: 0.5 });
    await sleep(100);
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0, 'no take to C');
    assert.strictEqual(A.hub.selectedId, B.id, 'the selection did not move to C');
    await driveVia(A, B, 'top');
    kvm.home();
    C.hub.bus.send(A.id, { t: T.KVM_LINK, on: true });
    await waitFor(() => A.settings.kvm.linkedBy[C.id] === true, 'C back on');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('kvm.layout from a device sets its edge; a device never takes another device’s edge', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    const kvm = kvmOn(A);
    // B crosses on its left: it is on our right.
    B.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'left' });
    await waitFor(() => kvm.edges.right === B.id, 'B is on our right');
    // C crosses on its left as well: the right edge is B's, so C is refused.
    C.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'left' });
    await sleep(150);
    assert.deepStrictEqual(kvm.edges, { ...NONE, right: B.id }, 'C did not take B’s edge');
    // C crosses on its bottom: it is on our top.
    C.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'bottom' });
    await waitFor(() => kvm.edges.top === C.id, 'C is on our top');
    // B moves to our bottom: refreshed; the top stays C's.
    B.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'top' });
    await waitFor(() => kvm.edges.bottom === B.id, 'B moved to our bottom');
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: C.id, bottom: B.id });
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('two devices cannot share a side; a device on another side moves; clearing a side', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    const kvm = kvmOn(A);
    assert.strictEqual(kvm.setEdge('top', B.id), true);
    assert.strictEqual(kvm.setEdge('top', C.id), false, 'top is B’s: refused');
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: B.id });
    assert.strictEqual(kvm.setEdge('right', B.id), true, 'B moves to the right');
    assert.deepStrictEqual(kvm.edges, { ...NONE, right: B.id });
    assert.strictEqual(kvm.setEdge('top', C.id), true);
    assert.deepStrictEqual(kvm.edges, { ...NONE, right: B.id, top: C.id });
    assert.strictEqual(kvm.setEdge('right', null), true, 'clearing a side');
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: C.id });
    assert.strictEqual(kvm.setEdge('diagonal', C.id), false, 'a side that does not exist');
    kvm.forgetDevice(C.id);
    assert.deepStrictEqual(kvm.edges, NONE, 'a forgotten device leaves its edge');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('settings from before the edges: one paired device takes the side its pcSide gave it; with two, nothing', async () => {
  const N = await world(['A', 'B', 'C'], [['A', 'B']]);
  try {
    const { A, B } = N;
    assert.deepStrictEqual(A.hub.peers().map((p) => p.id), [B.id], 'one paired device');
    const legacy = normalize({ kvm: { pcSide: 'left' } });
    assert.strictEqual(migrateKvm(legacy, A.hub.peers().map((p) => p.id)), true);
    assert.deepStrictEqual(legacy.kvm.edges, { ...NONE, right: B.id }, 'pcSide left: the device is on our right');
    assert.strictEqual(legacy.kvm.pcSide, null, 'the legacy value is dropped once migrated');
    assert.strictEqual(migrateKvm(legacy, [B.id]), false, 'migrating again changes nothing');

    const two = normalize({ kvm: { pcSide: 'left' } });
    assert.strictEqual(migrateKvm(two, [B.id, crypto.randomUUID()]), false);
    assert.deepStrictEqual(two.kvm.edges, NONE, 'two devices: nothing is guessed');
    const set = normalize({ kvm: { pcSide: 'left', edges: { top: 'X' } } });
    assert.strictEqual(migrateKvm(set, [B.id]), false, 'edges already set: left alone');
    assert.deepStrictEqual(set.kvm.edges, { ...NONE, top: 'X' });
    snaps(A, B);
  } finally {
    closeAll(N);
  }
});

test('a stale helper edge with no device behind it, and a device that is not connected, are refused at once', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A } = N;
    const kvm = kvmOn(A);
    kvm.setEdge('left', crypto.randomUUID()); // a device that is not paired here
    A.helper.emit('event', 'edge', { side: 'left', offset: 0.5 });
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 }); // no device on the right
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(A.helper.last('capture').on, false);
    snaps(A);
  } finally {
    closeAll(N);
  }
});

runTests(tests);
