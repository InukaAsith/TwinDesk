// The Mac's cursor edges with a computer AND a phone connected at the same time (docs/mesh.md,
// "Cursor and keyboard"). Real Server, Pairing, LinkManager, Hub and Kvm on loopback. The computer B
// is a real node (it dials this Mac). The phone is a raw client that is paired on this Mac (its record
// is seeded in the storage, as an earlier pairing would have left it) and says hello as an Android
// device. The phone bridge is the real PhoneBridge with a fake adb (no adb here), a fake phone (its
// screen size) and a fake scrcpy control (it records the pointer and key calls it gets).
// Run with: node mac/test/kvm-edges.test.js  (NODE_PATH as in CI; electron is stubbed here)
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

const P = require('../../shared/protocol.js');
const { Peer } = require('../peer.js');
const { Kvm } = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { PhoneBridge } = require('../phone-bridge.js');
const store = require('../store.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked, memoryStorage, hello } = require('./lib/mesh.js');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kvm-edges-')));

const T = P.T;
const NONE = { left: null, right: null, top: null, bottom: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECORDED = [T.KVM_TAKE, T.KVM_ACCEPT, T.KVM_REFUSE, T.KVM_RELEASE, T.KVM_HOME, T.KVM_LAYOUT, T.KVM_LINK, T.K_MOVE];

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
    keys: { swapCtrlCmd: true, hotkey: 'AltRight' },
    phone: {},
  };
  const helper = new RecHelper();
  const control = fakeControl();
  const phoneFake = Object.assign(new EventEmitter(), { adb: null, info: { display: { w: 1080, h: 2400, dpi: 420 } } });
  const bridge = new PhoneBridge({ server: new Peer(A.hub.phoneRoute(), A.server), phone: phoneFake, getSettings: () => settings, clipboard: null });
  bridge.adb = { available: false, wake() {}, devices: async () => [], shell: async () => ({ out: '' }) }; // no adb here
  bridge.state = 'ready';
  bridge.control = control;
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, planDrag: () => null, startDrag: () => null, cancelDrag() {} });
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

  const phone = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token });
  assert.strictEqual(phone.reply.t, T.WELCOME, 'the phone is welcomed');
  await waitFor(() => A.hub.sessions.get(phoneId) && A.hub.sessions.get(phoneId).connected, 'the phone is connected');

  const got = { B: [], phone: [] };
  for (const t of RECORDED) B.hub.bus.on(t, (m, from) => got.B.push({ t, from, m }));
  const of = (who, t) => got[who].filter((x) => x.t === t);
  return { A, B, phoneId, phone: phone.client, settings, helper, control, bridge, kvm, of, got };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the phone behind the right edge: kvm.take reaches the phone bridge, the accept reaches Kvm, Kvm keeps driving past the take timeout, input goes to the phone only', async () => {
  const s = await setup();
  const { A, B, phoneId, kvm, bridge, control, helper } = s;
  try {
    assert.strictEqual(A.hub.selectedId, B.id, 'the computer is selected before the crossing');
    helper.emit('event', 'edge', { side: 'right', offset: 0.4 });
    await waitFor(() => bridge.kvm !== null, 'the phone bridge got kvm.take');
    assert.strictEqual(s.of('B', T.KVM_TAKE).length, 0, 'the computer got no take');

    // The bridge answers kvm.accept at once; Kvm must hear it, or it sends the pointer home after 1 s.
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 1000);
    assert.strictEqual(kvm.mode, 'driving', 'still driving after the take timeout');
    assert.strictEqual(A.hub.selectedId, phoneId, 'the crossing selected the phone');

    const before = control.calls.length;
    helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 5, dy: 2 } });
    await waitFor(() => control.calls.length > before, 'the phone control got the pointer move');
    await sleep(100);
    assert.strictEqual(s.of('B', T.K_MOVE).length, 0, 'the computer got no input');
    assert.strictEqual(bridge.kvm !== null, true, 'the phone still holds the pointer');

    kvm.home();
    await waitFor(() => bridge.kvm === null, 'the phone bridge let go');
    assert.strictEqual(kvm.mode, 'home');
    assert.strictEqual(s.of('B', T.KVM_RELEASE).length, 0, 'no release for the computer');
  } finally {
    s.phone.close();
    close(A, B);
  }
});

test('the computer above the top edge: kvm.take reaches the computer and not the phone; its input goes to the computer only', async () => {
  const s = await setup();
  const { A, B, kvm, bridge, control, helper } = s;
  try {
    helper.emit('event', 'edge', { side: 'top', offset: 0.6 });
    await waitFor(() => s.of('B', T.KVM_TAKE).length === 1, 'B gets kvm.take on its socket', 3000);
    const take = s.of('B', T.KVM_TAKE)[0].m;
    assert.strictEqual(take.side, 'bottom', 'B sees the take at its bottom');
    assert.strictEqual(bridge.kvm, null, 'the phone bridge got no take');
    assert.strictEqual(s.phone.count(T.KVM_TAKE), 0, 'the phone socket got no kvm.take');

    B.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: take.route });
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 500);
    assert.strictEqual(kvm.mode, 'driving', 'accepted: still driving');
    assert.strictEqual(A.hub.selectedId, B.id, 'the crossing selected B');

    const calls = control.calls.length;
    helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 3, dy: 3 } });
    await waitFor(() => s.of('B', T.K_MOVE).length === 1, 'B gets k.move');
    assert.strictEqual(control.calls.length, calls, 'the phone gets no input');

    kvm.home();
    await waitFor(() => s.of('B', T.KVM_RELEASE).length === 1, 'B gets kvm.release');
  } finally {
    s.phone.close();
    close(A, B);
  }
});

test('the phone drops while this Mac drives it: Kvm goes home', async () => {
  const s = await setup();
  const { A, B, phoneId, kvm, helper } = s;
  try {
    helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => kvm.mode === 'driving', 'driving the phone');
    await sleep(P.KVM_TAKE_TIMEOUT_MS + 300); // accepted: no take timeout sends Kvm home first
    assert.strictEqual(kvm.mode, 'driving', 'still driving the phone before it drops');
    s.phone.close();
    await waitFor(() => !A.hub.sessions.get(phoneId).connected, 'the phone is gone');
    await waitFor(() => kvm.mode === 'home', 'Kvm home after the phone dropped', 3000);
  } finally {
    close(A, B);
  }
});

runTests(tests);
