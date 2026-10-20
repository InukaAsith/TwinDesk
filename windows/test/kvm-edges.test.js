// The cursor edges (windows/kvm.js, windows/layout-sync.js) on real sockets: node A has a real Kvm with a
// fake helper (it records what it is told and lets the test emit helper events); B and C are other
// computers whose hub bus records the kvm messages they get. Real Server, Pairing, LinkManager, Mesh,
// Hub and LayoutSync on every node, paired with the real pairing protocol. The edges of A are the
// shared layout around A (docs/mesh.md, "Shared layout").
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
const LayoutSync = require('../layout-sync.js');
const { normalize, migrateKvm } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const NONE = { left: null, right: null, top: null, bottom: null };
const CELL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }; // where a side is, from A
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A computer: Server + Pairing (host side) + LinkManager (guest side) + Mesh + Hub + LayoutSync.
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
  const n = { name, id, port: server.port, server, pairing, links, mesh, hub, log: [], kvm: null, settings: normalize({}) };
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
  return n.kvm;
}

// Puts the devices on A's layout: `sides` maps a side of A to the device there (A itself at the middle).
function lay(A, sides) {
  assert.strictEqual(A.layoutSync.place(A.id, 0, 0), true);
  for (const side of Object.keys(sides)) {
    const [x, y] = CELL[side];
    assert.strictEqual(A.layoutSync.place(sides[side].id, x, y), true, `place ${sides[side].name} on ${side}`);
  }
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
    lay(A, { top: B, bottom: C });
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: B.id, bottom: C.id });
    await waitFor(() => got(B, T.KVM_LAYOUT).some((x) => x.m.pcSide === 'top'), 'B is told where A is');
    assert.strictEqual(got(C, T.KVM_LAYOUT).slice(-1)[0].m.pcSide, 'bottom', 'C is told its side last');

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
    lay(A, { top: B, bottom: C });
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
    lay(A, { top: B });

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
    // No layout yet: the paired devices sit in a row in id order (this PC among them), so the sides
    // watched are the row’s neighbours of this PC: left and/or right, never top or bottom.
    assert.ok(sides(A).length >= 1 && sides(A).every((s) => s === 'left' || s === 'right'), 'the default row only');
    lay(A, { top: B, bottom: C }); // the layout change re-sends the sides
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
    lay(A, { top: B, bottom: C });
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

test('kvm.layout from an older app does not change the layout: the shared layout is the one map', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    const kvm = kvmOn(A);
    const before = kvm.edges;
    B.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'bottom' });
    C.hub.bus.send(A.id, { t: T.KVM_LAYOUT, pcSide: 'left' });
    await sleep(150);
    assert.deepStrictEqual(kvm.edges, before, 'no edge was set by a message');
    assert.strictEqual(A.layoutSync.get(), null, 'nothing stored');
    snaps(A, B, C);
  } finally {
    closeAll(N);
  }
});

test('a device placed on another device’s cell takes it over and the other moves; a device taken off leaves its side', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: C });
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: B.id, bottom: C.id });
    assert.strictEqual(A.layoutSync.place(C.id, 0, -1), true, 'C goes on the top cell');
    assert.deepStrictEqual(kvm.edges, { ...NONE, top: C.id, bottom: B.id }, 'top is C now, and B took C’s old cell');
    assert.strictEqual(A.layoutSync.place(B.id, 99, 0), false, 'a cell out of range is refused');
    A.hub.forgetPeer(C.id); // as Forget does: unpaired, then taken off the layout
    kvm.forgetDevice(C.id);
    assert.strictEqual(A.layoutSync.get().cells[C.id], undefined, 'a forgotten device is taken off the layout');
    assert.deepStrictEqual(kvm.edges, { ...NONE, bottom: B.id }, 'the forgotten top is gone; B stays at the bottom');
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

test('a helper edge with no device behind it, and a device that is not connected, are refused at once', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B } = N;
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: N.C });
    A.helper.emit('event', 'edge', { side: 'left', offset: 0.5 }); // no device on the left
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 }); // no device on the right
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(A.helper.last('capture').on, false);
    A.links.get(B.id).ws.terminate();
    await waitFor(() => !A.hub.sessions.get(B.id).connected, 'B dropped');
    A.helper.emit('event', 'edge', { side: 'top', offset: 0.5 }); // B is on top, but not connected
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(A.helper.last('capture').on, false);
    snaps(A, B);
  } finally {
    closeAll(N);
  }
});

runTests(tests);
