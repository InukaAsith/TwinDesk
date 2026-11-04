// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor lock (shared/cursorlock.js) on real sockets, set up as kvm-edges.test.js: node A has a real Kvm
// with a recording helper, B and C are other computers whose hub bus records what they get. Locked, the
// pointer stays where it is: at home no edge crosses, driving the device we drive is told (kvm.lock),
// driven the edges aren't watched; going home or away any other way ends the lock. The lock key that
// counts is the one of the device the pointer is on.
// Run with: node linux/mesh/test/kvm-lock.test.js  (NODE_PATH as in CI)
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
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
const CELL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const n = { name, id, fp: cert.fp, port: server.port, server, pairing, links, mesh, hub, log: [], kvm: null, settings: normalize({ kvm: { mouse: true, keyboard: true } }) }; // saved settings with the cursor on (a fresh install has it off)
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
const closeAll = (N) => close(...Object.values(N));

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
  n.locks = [];
  n.kvm.onLock = (on, mode) => n.locks.push({ on, mode });
  return n.kvm;
}

function lay(A, sides) {
  assert.strictEqual(A.layoutSync.place(A.id, 0, 0), true);
  for (const side of Object.keys(sides)) {
    const [x, y] = CELL[side];
    assert.strictEqual(A.layoutSync.place(sides[side].id, x, y), true, `place ${sides[side].name} on ${side}`);
  }
}

const RECORDED = [T.KVM_TAKE, T.KVM_ACCEPT, T.KVM_RELEASE, T.KVM_HOME, T.KVM_LOCK, T.KVM_NEXT, T.K_KEY_DOWN, T.K_KEY_UP];
function record(n) {
  for (const t of RECORDED) n.hub.bus.on(t, (m, from) => n.log.push({ t, from, m }));
}
const got = (n, t) => n.log.filter((x) => x.t === t);
const sides = (A) => A.helper.last('kvmConfig').sides;
const key = (A, t, code) => A.helper.emit('event', 'ev', { ev: { t, code } });

async function driveVia(A, to, side, offset = 0.5) {
  const before = got(to, T.KVM_TAKE).length;
  A.helper.emit('event', 'edge', { side, offset });
  await waitFor(() => got(to, T.KVM_TAKE).length === before + 1, `${to.name} gets kvm.take`);
  const take = got(to, T.KVM_TAKE)[before];
  to.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: take.m.route });
  await waitFor(() => A.kvm.mode === 'driving', 'A drives after the accept');
  return take;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('at home: locked, no side is watched and an edge is refused; the lock key reaches the helper only while connected', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: C });
    assert.deepStrictEqual(sides(A), ['top', 'bottom']);
    assert.strictEqual(A.helper.last('kvmConfig').lockKeys, 'Scrolllock', 'connected: the helper watches the lock key');

    A.helper.emit('event', 'shortcut', { action: 'lock' }); // the helper saw Scroll Lock at home
    assert.strictEqual(kvm.locked, true);
    assert.deepStrictEqual(A.locks.slice(-1)[0], { on: true, mode: 'home' }, 'the popup is shown here');
    assert.deepStrictEqual(sides(A), [], 'locked at home: nothing is watched');
    assert.strictEqual(kvm.view().locked, true);
    A.helper.emit('event', 'edge', { side: 'top', offset: 0.5 }); // a late edge
    await sleep(100);
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(A.helper.last('capture').on, false, 'the capture the helper started is undone');
    assert.strictEqual(got(B, T.KVM_TAKE).length, 0, 'no take');
    assert.strictEqual(got(B, T.KVM_LOCK).length + got(C, T.KVM_LOCK).length, 0, 'at home nobody is told');

    A.helper.emit('event', 'shortcut', { action: 'lock' }); // within the gap: the same press, not another
    assert.strictEqual(kvm.locked, true);
    await sleep(350);
    A.helper.emit('event', 'shortcut', { action: 'lock' });
    assert.strictEqual(kvm.locked, false);
    assert.deepStrictEqual(sides(A), ['top', 'bottom'], 'unlocked: watched again');
    await driveVia(A, B, 'top');
    kvm.home();
  } finally {
    closeAll(N);
  }
});

test('driving: our lock key is not ours to use on B, it goes through as a key; B locks with its own key and A follows; kvm.next is ignored; going home ends the lock', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: C });
    const take = await driveVia(A, B, 'top');
    key(A, T.K_KEY_DOWN, 'ScrollLock');
    key(A, T.K_KEY_UP, 'ScrollLock');
    await waitFor(() => got(B, T.K_KEY_UP).length === 1, 'B gets the key and its release');
    assert.deepStrictEqual(got(B, T.K_KEY_DOWN).map((x) => x.m.code), ['ScrollLock'], 'the pointer is on B: B’s key decides');
    assert.strictEqual(kvm.locked, false, 'A did not lock');
    assert.strictEqual(got(B, T.KVM_LOCK).length, 0);

    // B saw its own lock key in A's keys and locked: it tells A, which follows (no echo).
    B.hub.bus.send(A.id, { t: T.KVM_LOCK, on: true });
    await waitFor(() => kvm.locked === true, 'A follows B');
    assert.deepStrictEqual(A.locks.slice(-1)[0], { on: true, mode: 'driving' }, 'driving a computer: its popup, not ours');
    await sleep(100);
    assert.strictEqual(got(B, T.KVM_LOCK).length, 0, 'no echo back to B');
    assert.strictEqual(got(C, T.KVM_LOCK).length, 0);

    // B's pointer reached its edge towards C anyway (an older B): A doesn't take C.
    B.hub.bus.send(A.id, { t: T.KVM_NEXT, route: take.m.route, to: C.id, side: 'top', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(kvm.partner, B.id, 'still driving B');
    assert.strictEqual(got(C, T.KVM_TAKE).length, 0);

    // The tray locks or unlocks from A too: B is told.
    kvm.setLocked(false);
    await waitFor(() => got(B, T.KVM_LOCK).length === 1, 'B is told');
    assert.strictEqual(got(B, T.KVM_LOCK)[0].m.on, false);

    // Locked again, then the hotkey / tray brings everything home: the lock ends with it.
    B.hub.bus.send(A.id, { t: T.KVM_LOCK, on: true });
    await waitFor(() => kvm.locked === true, 'locked by B');
    kvm.home();
    await waitFor(() => got(B, T.KVM_RELEASE).length === 1, 'B gets kvm.release');
    assert.strictEqual(kvm.locked, false, 'home: the lock was for B');
    assert.deepStrictEqual(sides(A), ['top', 'bottom'], 'and the edges cross again');
  } finally {
    closeAll(N);
  }
});

test('driven: our own lock key typed on the driver’s keyboard locks here and is used up; after a change only the new key does', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: C });
    B.hub.bus.send(A.id, { t: T.KVM_TAKE, route: 1, side: 'top', offset: 0.5, mouse: true, keyboard: true });
    await waitFor(() => kvm.mode === 'driven', 'A is driven by B');
    const injected = () => A.helper.sent.filter((x) => x.name === 'inject' && (x.args.ev.t === T.K_KEY_DOWN || x.args.ev.t === T.K_KEY_UP)).map((x) => x.args.ev.t + ' ' + x.args.ev.code);
    const typed = (t, code) => B.hub.bus.send(A.id, { t, code });

    typed(T.K_KEY_DOWN, 'ScrollLock');
    typed(T.K_KEY_DOWN, 'ScrollLock'); // autorepeat
    typed(T.K_KEY_UP, 'ScrollLock');
    await waitFor(() => got(B, T.KVM_LOCK).length === 1, 'the driver is told');
    assert.strictEqual(kvm.locked, true, 'A locked with its own key');
    assert.strictEqual(got(B, T.KVM_LOCK)[0].m.on, true);
    assert.strictEqual(A.helper.last('armReturn').on, false, 'not watched');
    assert.deepStrictEqual(injected(), [], 'the key is used up here, the app in front never gets it');
    assert.deepStrictEqual(A.locks.slice(-1)[0], { on: true, mode: 'driven' }, 'the popup is shown here');

    // A picks another key (its Cursor tab): Scroll Lock is a key like any other now, Ctrl+Alt+L locks.
    await sleep(350);
    typed(T.K_KEY_DOWN, 'ScrollLock');
    typed(T.K_KEY_UP, 'ScrollLock');
    await waitFor(() => kvm.locked === false, 'unlocked with the same key');
    A.settings.keys.lockKeys = 'Control+Alt+L';
    await sleep(350);
    typed(T.K_KEY_DOWN, 'ScrollLock');
    typed(T.K_KEY_UP, 'ScrollLock');
    await waitFor(() => injected().length === 2, 'Scroll Lock is injected');
    assert.strictEqual(kvm.locked, false);
    for (const [t, code] of [[T.K_KEY_DOWN, 'ControlLeft'], [T.K_KEY_DOWN, 'AltLeft'], [T.K_KEY_DOWN, 'KeyL'], [T.K_KEY_UP, 'KeyL'], [T.K_KEY_UP, 'AltLeft'], [T.K_KEY_UP, 'ControlLeft']]) typed(t, code);
    await waitFor(() => kvm.locked === true, 'the new key locks');
    await waitFor(() => injected().length === 6, 'the modifiers are injected');
    assert.ok(!injected().some((x) => x.endsWith(' KeyL')), 'L is used up');
  } finally {
    closeAll(N);
  }
});

test('driven: locked, the edges are not watched and a return is ignored; the driver is told; kvm.lock from another device is ignored', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    record(B); record(C);
    const kvm = kvmOn(A);
    lay(A, { top: B, bottom: C });
    B.hub.bus.send(A.id, { t: T.KVM_TAKE, route: 1, side: 'top', offset: 0.5, mouse: true, keyboard: true });
    await waitFor(() => kvm.mode === 'driven', 'A is driven by B');
    assert.strictEqual(A.helper.last('armReturn').on, true, 'the edges are watched');

    kvm.setLocked(true); // A's Cursor tab or tray
    assert.strictEqual(A.helper.last('armReturn').on, false, 'locked: not watched');
    await waitFor(() => got(B, T.KVM_LOCK).length === 1, 'the driver is told');
    assert.strictEqual(got(B, T.KVM_LOCK)[0].m.on, true);
    assert.deepStrictEqual(A.locks.slice(-1)[0], { on: true, mode: 'driven' }, 'the popup is shown here, where the pointer is');
    A.helper.emit('event', 'return', { side: 'top', offset: 0.5 }); // a return already on its way
    A.helper.emit('event', 'return', { side: 'bottom', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(kvm.mode, 'driven', 'still driven');
    assert.strictEqual(got(B, T.KVM_HOME).length + got(B, T.KVM_NEXT).length, 0, 'neither home nor on to C');

    C.hub.bus.send(A.id, { t: T.KVM_LOCK, on: false }); // not the driver
    await sleep(100);
    assert.strictEqual(kvm.locked, true, 'only the driver may unlock it');

    B.hub.bus.send(A.id, { t: T.KVM_LOCK, on: false }); // the driver's tray
    await waitFor(() => kvm.locked === false, 'unlocked by the driver');
    assert.strictEqual(A.helper.last('armReturn').on, true, 'watched again');
    assert.strictEqual(got(B, T.KVM_LOCK).length, 1, 'no echo');
    A.helper.emit('event', 'return', { side: 'top', offset: 0.5 });
    await waitFor(() => got(B, T.KVM_HOME).length === 1, 'the way back works again');
    assert.strictEqual(kvm.mode, 'home');
  } finally {
    closeAll(N);
  }
});

test('driven: this computer’s own mouse takes it back (local): the driver goes home with no offset, its pointer where it left; not while locked', async () => {
  const N = await world(['A', 'B'], [['A', 'B']]);
  try {
    const { A, B } = N;
    record(B);
    const kvm = kvmOn(A);
    lay(A, { top: B });
    B.hub.bus.send(A.id, { t: T.KVM_TAKE, route: 1, side: 'top', offset: 0.5, mouse: true, keyboard: true });
    await waitFor(() => kvm.mode === 'driven', 'A is driven by B');

    kvm.setLocked(true);
    A.helper.emit('event', 'local', {}); // one already on its way
    await sleep(150);
    assert.strictEqual(kvm.mode, 'driven', 'locked: still driven');
    kvm.setLocked(false);

    A.helper.emit('event', 'local', {});
    await waitFor(() => got(B, T.KVM_HOME).length === 1, 'B is sent home');
    assert.strictEqual(kvm.mode, 'home', 'A is ours again');
    assert.strictEqual(typeof got(B, T.KVM_HOME)[0].m.offset, 'undefined', 'no offset: B’s pointer comes back where it left');
    assert.strictEqual(A.helper.last('armReturn').on, false, 'nothing watched at home');
    A.helper.emit('event', 'local', {}); // late: ignored at home
    await sleep(100);
    assert.strictEqual(got(B, T.KVM_HOME).length, 1);
  } finally {
    closeAll(N);
  }
});

test('nothing connected: the lock is refused and the helper is not given the lock key', async () => {
  const N = await world(['A'], []);
  try {
    const { A } = N;
    const kvm = kvmOn(A);
    kvm.applyConfig();
    assert.strictEqual(A.helper.last('kvmConfig').lockKeys, '');
    kvm.setLocked(true);
    assert.strictEqual(kvm.locked, false);
    assert.strictEqual(A.locks.length, 0);
  } finally {
    closeAll(N);
  }
});

runTests(tests);
