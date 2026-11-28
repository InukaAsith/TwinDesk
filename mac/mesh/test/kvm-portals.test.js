// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor portals in Multi-device (mesh/kvm.js): two Macs on a real mesh, each with its Kvm and a recorded
// helper. Off, nothing is watched and Hold key to switch stays; on, the helper watches the portal and the
// hold key steps aside; a crossing through it takes the other Mac, which places the pointer with
// placePortal and arms the way back on that range only; going back sends the pointer home.
// Run with: node mac/mesh/test/kvm-portals.test.js  (NODE_PATH as in CI; electron is stubbed here)
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

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
const { Kvm } = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const store = require('../store.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node, close, waitFor, pair, linked } = require('./lib/mesh.js');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kvm-portals-')));
const T = P.T;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RecHelper extends EventEmitter {
  constructor() { super(); this.running = true; this.sent = []; }
  send(name, args) { this.sent.push({ name, args }); }
  request(name, args) {
    this.sent.push({ name, args });
    return Promise.resolve(name === 'portalCapabilities' ? { version: 3 } : {});
  }
  stop() {}
  last(name) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].name === name) return this.sent[i].args; return undefined; }
}

function mac(n, displays) {
  const settings = {
    kvm: { mouse: true, keyboard: true, driveOther: true, beDriven: true, linked: true, linkedBy: {}, resistancePx: 0, speed: 1,
      gestures: true, crossingModifier: 'Shift', portalsOn: false, portalsByPeer: {} },
    keys: { hotkey: 'AltRight', lockKeys: 'F14' },
    phone: {},
  };
  const helper = new RecHelper();
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, anyPeerDrag: false, peerDragOf: () => false, planDrag: () => null, startDrag: () => null, cancelDrag() {} });
  const drop = { dragIn: { armDrag() {}, onDriven() {}, cancel() {} }, cancelDrag() {}, armDrag() {} };
  const layoutSync = new LayoutSync({
    bus: n.hub.bus, mesh: n.mesh, selfId: n.id,
    storage: { get: () => settings.layout, set: (l) => { settings.layout = l; } },
    knownIds: () => n.hub.peers().map((p) => p.id),
    myDisplays: () => displays,
    onChange: () => {},
  });
  const kvm = new Kvm({ hub: n.hub, layoutSync, helper, getSettings: () => settings, clipboard: { sendIfChanged: () => true }, input: { releaseAll() {} }, drop, fileSend });
  return { settings, helper, layoutSync, kvm };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a portal from A’s display 1 right edge to B’s display 9 bottom edge: off, on, across and back', async () => {
  const A = await node('A');
  const B = await node('B');
  try {
    await pair(B, A);
    await waitFor(() => linked(A, B), 'linked');
    const a = mac(A, [{ id: '1', name: 'Built-in', x: 0, y: 0, w: 1000, h: 600, primary: true }]);
    const b = mac(B, [{ id: '9', name: 'Studio', x: 0, y: 0, w: 2000, h: 1000, primary: true }]);
    a.layoutSync.displaysChanged(); b.layoutSync.displaysChanged();
    await waitFor(() => (a.layoutSync.allDisplays()[B.id] || []).length && (b.layoutSync.allDisplays()[A.id] || []).length, 'displays exchanged');
    await sleep(50);

    // Off: nothing watched, the hold key as set.
    a.kvm.config();
    assert.deepStrictEqual(a.helper.last('kvmConfig').portals, []);
    assert.strictEqual(a.helper.last('kvmConfig').crossingModifier, 'Shift');

    // Saved, on: watched, the hold key off.
    const rule = { id: 'p1', source: { display: '1', side: 'right', from: 0.2, to: 0.6 }, target: { display: '9', side: 'bottom', from: 0.5, to: 1 }, modifiers: [], key: '' };
    assert.ok(a.kvm.setPortals([rule], B.id), 'saved');
    assert.strictEqual(a.kvm.setPortals([rule], 'nobody'), false, 'only a connected computer');
    a.settings.kvm.portalsOn = true;
    a.kvm.config();
    const cfg = a.helper.last('kvmConfig');
    assert.strictEqual(cfg.portals.length, 1);
    assert.strictEqual(cfg.crossingModifier, '', 'Hold key to switch steps aside');
    assert.strictEqual(cfg.driveOther, true);
    const view = a.kvm.view.portals;
    assert.strictEqual(view.supported, true);
    assert.strictEqual(view.peers[0].id, B.id);
    assert.strictEqual(view.peers[0].rules[0].id, 'p1');

    // Across: B places the pointer on its range and arms the way back there only.
    const takes = [];
    B.hub.bus.on(T.KVM_TAKE, (m) => takes.push(m));
    a.helper.emit('event', 'portal', { id: cfg.portals[0].id, offset: 0.4 });
    await waitFor(() => b.kvm.mode === 'driven', 'B driven');
    assert.strictEqual(a.kvm.mode, 'driving');
    assert.strictEqual(takes[0].portal.target.display, '9');
    assert.strictEqual(takes[0].portal.offset, 0.75, 'halfway along the source is halfway along the target');
    assert.strictEqual(takes[0].side, 'bottom', 'an older app places it on that side instead');
    const place = b.helper.last('placePortal');
    assert.strictEqual(place.display, '9');
    assert.strictEqual(place.offset, 0.75);
    assert.strictEqual(b.helper.last('place'), undefined, 'no ordinary place');
    const arm = b.helper.last('armReturn');
    assert.deepStrictEqual(arm.sides, ['bottom']);
    assert.strictEqual(arm.portal.display, '9');
    assert.strictEqual(arm.zones, '0.500000-1.000000');

    // Back: home, no offset (A's pointer returns where it left).
    const homes = [];
    A.hub.bus.on(T.KVM_HOME, (m) => homes.push(m));
    b.helper.emit('event', 'return', { side: 'bottom', offset: 0.8 });
    await waitFor(() => a.kvm.mode === 'home', 'A home');
    assert.strictEqual(b.kvm.mode, 'home');
    assert.strictEqual(homes[0].offset, undefined);
    assert.strictEqual(b.kvm.portalReturn, null);

    // Off again: not watched.
    a.settings.kvm.portalsOn = false;
    a.kvm.config();
    assert.deepStrictEqual(a.helper.last('kvmConfig').portals, []);
    a.helper.emit('event', 'portal', { id: cfg.portals[0].id, offset: 0.4 });
    await sleep(100);
    assert.strictEqual(a.kvm.mode, 'home', 'a portal event while off is refused');
  } finally {
    close(A, B);
  }
});

runTests(tests);
