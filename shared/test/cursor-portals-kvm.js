// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const P = require('../protocol.js');
const originalLoad = Module._load;
let electron;
Module._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };
const { Kvm } = require('../../mac/kvm.js');
const originalInterval = global.setInterval;
global.setInterval = () => null;

function helper() {
  const h = new EventEmitter();
  h.commands = [];
  h.send = (cmd, args) => { h.commands.push({ cmd, args }); };
  h.request = (cmd, args) => { h.commands.push({ cmd, args }); return Promise.resolve({ ok: true }); };
  return h;
}
function screen(displays) {
  const s = new EventEmitter();
  s.getPrimaryDisplay = () => displays[0];
  s.getAllDisplays = () => displays;
  return s;
}
const display = (id, x, y, width, height) => ({ id, bounds: { x, y, width, height }, scaleFactor: 1 });
const localScreens = [display(1, 0, 100, 100, 100), display(2, 80, 0, 150, 100)];
const remoteScreens = [display(3, 0, 0, 100, 100), display(4, 0, 100, 100, 100)];
const makeSettings = () => ({ kvm: { pcSide: 'top', along: 0, mouse: true, keyboard: true, driveOther: true,
  beDriven: true, linked: true, linkedBy: {}, portalsByPeer: {}, resistancePx: 10, speed: 1, ble: true },
  keys: { hotkey: 'AltRight', lockKeys: 'F14' } });
function node(name, screens) {
  electron = { screen: screen(screens) };
  const server = new EventEmitter();
  server.current = { deviceId: name === 'A' ? 'B' : 'A', name: 'Peer', lastRx: Date.now(), transport: 'ip' };
  server.messages = [];
  server.sendToClient = (msg) => { server.messages.push(msg); if (server.other) setImmediate(() => server.other.emit(`t:${msg.t}`, msg)); };
  const h = helper(), settings = makeSettings();
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, planDrag: () => null });
  const drop = { dragIn: { dragging: false, onDriven() {}, cancel() {} }, cancelDrag() {} };
  const input = { releaseAll() {} }, clipboard = { sendIfChanged() {} };
  const kvm = new Kvm({ server, helper: h, getSettings: () => settings, clipboard, input, drop, fileSend });
  return { server, helper: h, settings, kvm };
}
const A = node('A', localScreens), B = node('B', remoteScreens);
global.setInterval = originalInterval;
Module._load = originalLoad;
A.server.other = B.server; B.server.other = A.server;
A.kvm.helperPortalVersion = 3; B.kvm.helperPortalVersion = 3;
A.kvm.map.onDisplays({ displays: B.kvm.map.mine, portalVersion: 3 });
B.kvm.map.onDisplays({ displays: A.kvm.map.mine, portalVersion: 3 });
const target = { display: '3', side: 'bottom', from: 0, to: 1 };
const rules = [
  { id: 'laptop', source: { display: '1', side: 'top', from: 0, to: 0.5 }, target, modifiers: ['Command'], key: '' },
  { id: 'msi', source: { display: '2', side: 'bottom', from: 0, to: 0.1 }, target, modifiers: ['Command'], key: '' },
];
A.settings.kvm.portalsByPeer.B = rules;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

(async () => {
  A.kvm.config();
  const config = A.helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args;
  assert.equal(config.driveOther, true);
  assert.equal(config.portals.length, 2);
  A.server.current.os = P.OS.IOS;
  A.kvm.config();
  assert.equal(A.helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.driveOther, false,
    'portal configuration preserves the upstream iOS input restriction');
  delete A.server.current.os;
  A.kvm.config();
  assert.equal(A.helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.driveOther, true);
  A.kvm.blockEdge = () => true;
  A.helper.emit('event', 'portal', { id: 'laptop', offset: 0.25 });
  assert.equal(A.kvm.mode, 'home', 'a portal cannot bypass an active edge block');
  assert.deepEqual(A.helper.commands.filter((c) => c.cmd === 'capture').at(-1).args, { on: false });
  A.kvm.blockEdge = () => false;
  const sourceDisplays = A.kvm.map.mine;
  A.kvm.map.mine = sourceDisplays.filter((d) => d.id !== '1');
  A.helper.emit('event', 'portal', { id: 'laptop', offset: 0.25 });
  assert.equal(A.kvm.mode, 'home', 'a stale portal event cannot cross after its source disappears');
  assert.deepEqual(A.helper.commands.filter((c) => c.cmd === 'capture').at(-1).args, { on: false });
  A.kvm.map.mine = sourceDisplays;
  for (const id of ['laptop', 'msi']) {
    A.helper.emit('event', 'portal', { id, offset: id === 'msi' ? 0.05 : 0.25 });
    await tick();
    assert.equal(A.kvm.mode, 'driving');
    assert.equal(B.kvm.mode, 'driven');
    assert.equal(B.helper.commands.filter((c) => c.cmd === 'placePortal').at(-1).args.display, '3');
    assert.ok(B.helper.commands.filter((c) => c.cmd === 'placePortal').at(-1).args.deadlineMs > Date.now(), 'native placement expires');
    assert.equal(B.helper.commands.filter((c) => c.cmd === 'armReturn').at(-1).args.side, 'bottom');
    assert.equal(B.helper.commands.filter((c) => c.cmd === 'armReturn').at(-1).args.portal.display, '3',
      'return watches the selected display even if another local display occupies its edge');
    if (id === 'msi') {
      const before = B.kvm.map.mine;
      B.kvm.map.mine = [{ id: '5', x: -100, y: 0, w: 100, h: 100, scale: 1 }, ...before];
      B.kvm._rearmReturn();
      assert.equal(B.helper.commands.filter((c) => c.cmd === 'armReturn').at(-1).args.zones, '0.500000-1.000000',
        'return range follows desktop layout changes');
      B.kvm.map.mine = before;
      B.kvm._rearmReturn();
    }
    B.helper.emit('event', 'return', { offset: 0.5 });
    await tick();
    assert.equal(A.kvm.mode, 'home');
    assert.equal(B.kvm.mode, 'home');
    assert.deepEqual(A.helper.commands.filter((c) => c.cmd === 'capture').at(-1).args, { on: false }, 'returns to the captured source');
  }
  for (const locked of [false, true]) {
    A.helper.emit('event', 'portal', { id: 'msi', offset: 0.05 });
    await tick();
    assert.equal(B.kvm.mode, 'driven');
    if (locked) B.kvm.setLocked(true);
    const before = B.kvm.map.mine;
    B.kvm.map.mine = before.filter((d) => d.id !== '3');
    B.kvm.map.emit('change');
    await tick();
    assert.equal(B.kvm.mode, 'home', 'the driven Mac releases input when the portal display disappears');
    assert.equal(A.kvm.mode, 'home', 'the driver returns home even when the cursor was locked');
    assert.deepEqual(A.helper.commands.filter((c) => c.cmd === 'capture').at(-1).args, { on: false });
    B.kvm.map.mine = before;
    B.kvm.map.emit('change');
    await tick();
  }
  let finishPlacement;
  const originalRequest = B.helper.request;
  B.helper.request = (cmd, args) => cmd === 'placePortal' ? new Promise((resolve) => { finishPlacement = resolve; }) : originalRequest(cmd, args);
  A.helper.emit('event', 'portal', { id: 'msi', offset: 0.05 });
  await tick();
  assert.ok(B.kvm.pendingPortal);
  const beforePlacement = B.kvm.map.mine;
  B.kvm.map.mine = beforePlacement.filter((d) => d.id !== '3');
  finishPlacement({ ok: true });
  await tick();
  assert.equal(B.kvm.mode, 'home', 'a removed display cannot be accepted after placement');
  assert.equal(A.kvm.mode, 'home', 'the sender comes home when placement loses its target');
  B.kvm.map.mine = beforePlacement;
  A.helper.emit('event', 'portal', { id: 'msi', offset: 0.05 });
  await tick();
  assert.ok(B.kvm.pendingPortal, 'receiver awaits native placement');
  A.kvm.goHome('cancelled');
  await tick();
  assert.equal(B.kvm.pendingPortal, null, 'release cancels pending placement');
  finishPlacement({ ok: true });
  await tick();
  assert.equal(B.kvm.mode, 'home', 'late placement completion cannot restart a released route');
  B.kvm._onPortalTake({ route: 400, portal: { target, offset: 0.5 } }, () => {});
  assert.ok(B.kvm.pendingPortal);
  B.kvm.mode = 'driving'; // another transition wins while the helper is responding
  finishPlacement({ ok: true });
  await tick();
  assert.equal(B.kvm.pendingPortal, null, 'a superseded placement does not leave a pending route behind');
  assert.equal(B.kvm.mode, 'driving');
  B.kvm.mode = 'home';
  B.helper.request = originalRequest;

  A.kvm.map.onDisplays({ displays: B.kvm.map.mine, portalVersion: 2 });
  A.kvm.config();
  assert.equal(A.helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.driveOther, false,
    'an older prototype without shared-edge support is not compatible');
  A.kvm.map.onDisplays({ displays: B.kvm.map.mine, portalVersion: 3 });

  const acceptsBefore = B.server.messages.filter((m) => m.t === P.T.KVM_ACCEPT).length;
  B.kvm._onTake({ t: P.T.KVM_TAKE, route: 999, _portalAccepted: true,
    portal: { target: { ...target, display: 'missing' }, offset: 0.5 } });
  await tick();
  assert.equal(B.server.messages.filter((m) => m.t === P.T.KVM_ACCEPT).length, acceptsBefore,
    'a forged internal marker cannot bypass destination validation');
  assert.equal(B.kvm.mode, 'home');
  A.kvm.map.onDisplays({ displays: B.kvm.map.mine }); // an older peer cannot support portals
  A.kvm.config();
  const old = A.helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args;
  assert.equal(old.driveOther, false, 'do not silently bypass configured shortcuts with an older peer');
  A.helper.emit('event', 'edge', { offset: 0.5 });
  assert.equal(A.kvm.mode, 'home', 'a stale edge event cannot bypass shortcut settings');
  console.log('cursor portals: two-peer routing and return passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
