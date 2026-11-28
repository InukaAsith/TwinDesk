// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's cursor lock (shared/cursorlock.js) with a computer AND a phone connected, set up as
// kvm-edges.test.js. Locked, the pointer stays where it is: at home no edge crosses, driving the device
// we drive is told (kvm.lock; the phone bridge keeps the pointer at the phone's edge), driven the edges
// aren't watched; going home any other way ends the lock.
// Run with: node mac/mesh/test/kvm-lock.test.js  (NODE_PATH as in CI; electron is stubbed here)
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// electron: only the calls made while the modules load and the bridge is built (app.getPath).
const electronStub = new Proxy(function stub() {}, {
  get(t, key) {
    if (key === Symbol.toPrimitive) return () => '';
    if (key === 'then') return undefined;
    if (key === 'getPath') return () => os.tmpdir();
    return electronStub;
  },
  apply() { return electronStub; },
  construct() { return electronStub; },
});
const realLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};

const P = require('../../../shared/protocol.js');
const { Peer } = require('../peer.js');
const { Kvm } = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { PhoneBridge } = require('../phone-bridge.js');
const store = require('../store.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node, close, waitFor, pair, linked, memoryStorage, hello } = require('./lib/mesh.js');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kvm-lock-')));

const T = P.T;
const NONE = { left: null, right: null, top: null, bottom: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECORDED = [T.KVM_TAKE, T.KVM_ACCEPT, T.KVM_RELEASE, T.KVM_HOME, T.KVM_LOCK, T.K_KEY_DOWN, T.K_KEY_UP];

// The helper as Kvm sees it: send() and request() are recorded, the test emits its events.
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

  stop() {}
}

// scrcpy's control of the phone: records every call (the pointer and the keys go here).
function fakeControl() {
  const calls = [];
  const rec = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    closed: false,
    mouse: rec('mouse'), key: rec('key'), tap: rec('tap'), scroll: rec('scroll'), backOrScreenOn: rec('backOrScreenOn'),
    stop() { this.closed = true; },
  };
}

// The computer, the phone and this Mac, with the Mac's Kvm and phone bridge wired as main.js wires them.
async function setup() {
  const phoneId = P.randomHex(16);
  const token = P.randomHex(32);
  const storage = memoryStorage();
  storage.write('paired.json', [{ id: phoneId, name: 'Phone', os: P.OS.ANDROID, tokenHash: P.sha256Hex(token), pairedAt: 1, lastSeen: 1 }]);
  const A = await node('A', { storage });
  const B = await node('B');
  await pair(B, A); // the computer is connected first: it is the selected device
  await waitFor(() => linked(A, B), 'B linked to A');

  const settings = {
    kvm: {
      pcSide: 'right', edges: { ...NONE, right: phoneId, top: B.id }, mouse: true, keyboard: true, driveOther: true, beDriven: true,
      linked: true, linkedBy: {}, resistancePx: 120, speed: 1, reverseScroll: false, gestures: true, hotkeySwitch: false,
    },
    keys: { swapCtrlCmd: true, hotkey: 'AltRight', lockKeys: 'F14' },
    phone: {},
  };
  const helper = new RecHelper();
  const control = fakeControl();
  const phoneFake = Object.assign(new EventEmitter(), { adb: null, info: { display: { w: 1080, h: 2400, dpi: 420 } } });
  const bridge = new PhoneBridge({ server: new Peer(A.hub.phoneRoute(), A.server), phone: phoneFake, getSettings: () => settings, clipboard: null });
  bridge.adb = { available: false, wake() {}, devices: async () => [], shell: async () => ({ out: '' }) }; // no adb here
  bridge.state = 'ready';
  bridge.control = control;
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, anyPeerDrag: false, peerDragOf: () => false, planDrag: () => null, startDrag: () => null, cancelDrag() {} });
  const drop = { dragIn: { dragging: false, armDrag() {}, onDriven() {}, cancel() {}, release() {} }, cancelDrag() {}, release() {}, armDrag() {} };
  // The shared layout, from the edges the settings had (migrated once: right = the phone, top = B).
  const layoutSync = new LayoutSync({
    bus: A.hub.bus, mesh: A.mesh, selfId: A.id,
    storage: { get: () => settings.layout, set: (l) => { settings.layout = l; } },
    knownIds: () => A.hub.peers().map((p) => p.id),
    legacyEdges: () => settings.kvm.edges,
    onChange: () => {},
  });
  const kvm = new Kvm({
    hub: A.hub, layoutSync, helper, getSettings: () => settings,
    clipboard: { sendIfChanged: () => true }, input: { releaseAll() {} }, drop, fileSend, save() {},
  });
  kvm.attachLocal(bridge);
  const locks = [];
  kvm.on('lock', (on, mode) => locks.push({ on, mode }));

  const phone = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token });
  assert.strictEqual(phone.reply.t, T.WELCOME, 'the phone is welcomed');
  await waitFor(() => A.hub.sessions.get(phoneId) && A.hub.sessions.get(phoneId).connected, 'the phone is connected');

  const got = { B: [], phone: [] };
  for (const t of RECORDED) B.hub.bus.on(t, (m, from) => got.B.push({ t, from, m }));
  const of = (who, t) => got[who].filter((x) => x.t === t);
  return { A, B, phoneId, phone: phone.client, settings, helper, control, bridge, kvm, of, got, locks };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const lastSent = (helper, name) => { for (let i = helper.sent.length - 1; i >= 0; i--) if (helper.sent[i].name === name) return helper.sent[i].args; return undefined; };
const key = (helper, t, code) => helper.emit('event', 'ev', { ev: { t, code } });

test('at home: locked, no side is watched and an edge is refused; unlocked, they are again', async () => {
  const s = await setup();
  const { A, B, kvm, helper, bridge } = s;
  try {
    kvm.config();
    assert.ok(lastSent(helper, 'kvmConfig').sides.length > 0, 'sides are watched');
    kvm.toggleLock(); // the global shortcut (main.js)
    assert.strictEqual(kvm.locked, true);
    assert.deepStrictEqual(s.locks.slice(-1)[0], { on: true, mode: 'home' });
    assert.deepStrictEqual(lastSent(helper, 'kvmConfig').sides, [], 'locked: nothing watched');
    assert.strictEqual(kvm.view.locked, true);
    helper.emit('event', 'edge', { side: 'top', offset: 0.5 });
    helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(s.of('B', T.KVM_TAKE).length, 0);
    assert.strictEqual(bridge.kvm, null, 'the phone got no take either');
    kvm.toggleLock(); // within the gap: the same press
    assert.strictEqual(kvm.locked, true);
    await sleep(350);
    kvm.toggleLock();
    assert.strictEqual(kvm.locked, false);
    assert.ok(lastSent(helper, 'kvmConfig').sides.length > 0, 'watched again');
    assert.strictEqual(A.hub.selectedId, B.id);
  } finally {
    s.phone.close();
    close(A, B);
  }
});

test('driving the phone (it has no lock key): this Mac’s F14 is used up, the phone bridge keeps the pointer at its edge; unlocked, the push goes home', async () => {
  const s = await setup();
  const { A, B, kvm, bridge, helper } = s;
  try {
    helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => bridge.kvm !== null && kvm.mode === 'driving', 'driving the phone');
    key(helper, T.K_KEY_DOWN, 'F14');
    key(helper, T.K_KEY_UP, 'F14');
    await waitFor(() => bridge.kvm && bridge.kvm.locked === true, 'the bridge is locked');
    assert.strictEqual(kvm.locked, true);
    assert.deepStrictEqual(s.locks.slice(-1)[0], { on: true, mode: 'driving' }, 'driving a phone: main shows the popup here');
    for (let i = 0; i < 4; i++) helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: -400, dy: 0 } }); // hard against the way back
    await sleep(150);
    assert.strictEqual(kvm.mode, 'driving', 'locked: still on the phone');
    assert.notStrictEqual(bridge.kvm, null);

    await sleep(350);
    key(helper, T.K_KEY_DOWN, 'F14');
    await waitFor(() => bridge.kvm && bridge.kvm.locked === false, 'the bridge is unlocked');
    for (let i = 0; i < 4; i++) helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: -400, dy: 0 } });
    await waitFor(() => kvm.mode === 'home', 'the push goes home');
    assert.strictEqual(kvm.locked, false);
  } finally {
    s.phone.close();
    close(A, B);
  }
});

test('driving the computer: F14 goes through to it as a key (its own key decides there); it locks and this Mac follows; going home ends the lock', async () => {
  const s = await setup();
  const { A, B, kvm, helper } = s;
  try {
    helper.emit('event', 'edge', { side: 'top', offset: 0.6 });
    await waitFor(() => s.of('B', T.KVM_TAKE).length === 1, 'B gets kvm.take', 3000);
    B.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: s.of('B', T.KVM_TAKE)[0].m.route });
    key(helper, T.K_KEY_DOWN, 'F14');
    key(helper, T.K_KEY_UP, 'F14');
    await waitFor(() => s.of('B', T.K_KEY_UP).length === 1, 'B gets F14 and its release');
    assert.deepStrictEqual(s.of('B', T.K_KEY_DOWN).map((x) => x.m.code), ['F14']);
    assert.strictEqual(kvm.locked, false, 'the pointer is on B: not this Mac’s key to use');
    B.hub.bus.send(A.id, { t: T.KVM_LOCK, on: true }); // B's own key
    await waitFor(() => kvm.locked === true, 'this Mac follows B');
    assert.strictEqual(s.of('B', T.KVM_LOCK).length, 0, 'no echo');
    kvm.home();
    await waitFor(() => s.of('B', T.KVM_RELEASE).length === 1, 'B gets kvm.release');
    assert.strictEqual(kvm.locked, false, 'home: the lock was for B');
  } finally {
    s.phone.close();
    close(A, B);
  }
});

test('driven by the computer: its Scroll Lock is this Mac’s F14: it locks here and is used up; locked, the edges are not watched and a return is ignored; the driver may unlock it', async () => {
  const s = await setup();
  const { A, B, kvm, helper } = s;
  try {
    B.hub.bus.send(A.id, { t: T.KVM_TAKE, route: 1, side: 'top', offset: 0.5, mouse: true, keyboard: true });
    await waitFor(() => kvm.mode === 'driven', 'this Mac is driven by B');
    assert.strictEqual(lastSent(helper, 'armReturn').on, true);
    const injectedKeys = () => helper.sent.filter((x) => x.name === 'inject' && x.args.ev.code).length;
    B.hub.bus.send(A.id, { t: T.K_KEY_DOWN, code: 'ScrollLock' });
    B.hub.bus.send(A.id, { t: T.K_KEY_UP, code: 'ScrollLock' });
    await waitFor(() => s.of('B', T.KVM_LOCK).length === 1, 'the driver is told');
    assert.strictEqual(kvm.locked, true);
    assert.strictEqual(injectedKeys(), 0, 'used up: never injected');
    assert.strictEqual(lastSent(helper, 'armReturn').on, false, 'locked: not watched');
    assert.deepStrictEqual(s.locks.slice(-1)[0], { on: true, mode: 'driven' });
    helper.emit('event', 'return', { side: 'top', offset: 0.5 });
    await sleep(150);
    assert.strictEqual(kvm.mode, 'driven');
    assert.strictEqual(s.of('B', T.KVM_HOME).length, 0, 'no way back while locked');
    B.hub.bus.send(A.id, { t: T.KVM_LOCK, on: false });
    await waitFor(() => kvm.locked === false, 'unlocked by the driver');
    assert.strictEqual(lastSent(helper, 'armReturn').on, true, 'watched again');
    assert.strictEqual(s.of('B', T.KVM_LOCK).length, 1, 'no echo');
  } finally {
    s.phone.close();
    close(A, B);
  }
});

runTests(tests);
