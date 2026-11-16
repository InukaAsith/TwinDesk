// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Two independent KVM processes exchange serialized messages over IPC. Native
// input and display APIs are simulated; no Electron app or event tap is started.
'use strict';
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');

if (process.argv[2] === 'peer') {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const id = process.argv[3];
  const display = (id, x, y, width, height) => ({ id, bounds: { x, y, width, height }, scaleFactor: 1 });
  const displays = id === 'A'
    ? [display(1, 0, 100, 100, 100), display(2, 80, 0, 150, 100)]
    : [display(3, 0, 0, 100, 100), display(4, 0, 100, 100, 100)];
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays });
  Module._load = function (name, ...args) { return name === 'electron' ? { screen } : originalLoad.call(this, name, ...args); };
  const { Kvm } = require('../../mac/kvm.js');
  const peer = id === 'A' ? 'B' : 'A';
  const server = Object.assign(new EventEmitter(), {
    current: { deviceId: peer, name: peer, lastRx: Date.now(), transport: 'ip' },
    sendToClient(message) { process.send({ type: 'wire', message }); },
  });
  const helper = Object.assign(new EventEmitter(), {
    commands: [], send(cmd, args) { this.commands.push({ cmd, args }); },
    request(cmd, args) { this.commands.push({ cmd, args }); return Promise.resolve({ ok: true }); },
  });
  const settings = { kvm: { pcSide: 'top', along: 0, mouse: true, keyboard: true, driveOther: true,
    beDriven: true, linked: true, linkedBy: {}, portalsByPeer: {}, resistancePx: 10, speed: 1, ble: true },
  keys: { hotkey: 'AltRight', lockKeys: 'F14' } };
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, planDrag: () => null });
  const drop = { dragIn: { dragging: false, onDriven() {}, cancel() {} }, cancelDrag() {} };
  const kvm = new Kvm({ server, helper, getSettings: () => settings, clipboard: { sendIfChanged() {} },
    input: { releaseAll() {} }, drop, fileSend });
  Module._load = originalLoad;
  kvm.helperPortalVersion = 3;
  if (id === 'A') settings.kvm.portalsByPeer.B = [
    { id: 'msi', source: { display: '2', side: 'bottom', from: 0, to: 0.1 },
      target: { display: '3', side: 'bottom', from: 0, to: 1 }, modifiers: ['Command'], key: '' },
  ];
  process.on('message', ({ type, message, request }) => {
    if (type === 'wire') server.emit(`t:${message.t}`, message);
    if (type === 'init') { kvm.map.onDisplays({ displays: message, portalVersion: 3 }); kvm.config(); }
    if (type === 'portal') helper.emit('event', 'portal', { id: 'msi', offset: 0.05 });
    if (type === 'return') helper.emit('event', 'return', { offset: 0.5 });
    if (type === 'state') process.send({ type: 'state', request, mode: kvm.mode, commands: helper.commands });
    if (type === 'displays') process.send({ type: 'displays', request, displays: kvm.map.mine });
  });
  process.send({ type: 'ready' });
} else {
  const children = ['A', 'B'].map((id) => fork(__filename, ['peer', id], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  let seq = 0;
  const waiters = new Map();
  const timeout = setTimeout(() => { console.error('two-process simulation timed out'); process.exitCode = 1; cleanup(); }, 5000);
  function cleanup() { clearTimeout(timeout); for (const child of children) child.kill(); }
  const ready = children.map((child, index) => new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => { if (code && !process.exitCode) { process.exitCode = code; cleanup(); } });
    child.on('message', (m) => {
      if (m.type === 'ready') resolve();
      else if (m.type === 'wire') children[1 - index].send({ type: 'wire', message: m.message });
      else if (waiters.has(m.request)) { waiters.get(m.request)(m); waiters.delete(m.request); }
    });
  }));
  const ask = (child, type) => new Promise((resolve) => { const request = ++seq; waiters.set(request, resolve); child.send({ type, request }); });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  (async () => {
    await Promise.all(ready);
    const [a, b] = children;
    const [ad, bd] = await Promise.all([ask(a, 'displays'), ask(b, 'displays')]);
    a.send({ type: 'init', message: bd.displays }); b.send({ type: 'init', message: ad.displays });
    await pause();
    const initial = await ask(a, 'state');
    const rule = initial.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.portals[0];
    assert.deepEqual(rule.modifiers, ['Command']);
    assert.equal(rule.source.display, '2');
    a.send({ type: 'portal' }); await pause();
    const [outA, outB] = await Promise.all([ask(a, 'state'), ask(b, 'state')]);
    assert.equal(outA.mode, 'driving'); assert.equal(outB.mode, 'driven');
    assert.equal(outB.commands.filter((c) => c.cmd === 'placePortal').at(-1).args.display, '3');
    assert.equal(outB.commands.filter((c) => c.cmd === 'armReturn').at(-1).args.portal.display, '3');
    b.send({ type: 'return' }); await pause();
    const [homeA, homeB] = await Promise.all([ask(a, 'state'), ask(b, 'state')]);
    assert.equal(homeA.mode, 'home'); assert.equal(homeB.mode, 'home');
    assert.equal(homeA.commands.filter((c) => c.cmd === 'capture').at(-1).args.on, false);
    console.log('two-process IPC simulation: MSI portal and return passed');
  })().catch((err) => { console.error(err); process.exitCode = 1; }).finally(cleanup);
}
