'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const P = require('../../shared/protocol');
const load = Module._load;
const mockLoad = function(id, ...args) {
  if (id === 'electron') return {};
  if (id === '../shared/kvm-map.js') return { KvmMap: class extends EventEmitter { zones() { return null; } } };
  return load.call(this, id, ...args);
};
Module._load = mockLoad;
const Kvm = require('../kvm');
Module._load = load;
function fixture(t) {
  const sent = [], injected = [];
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, peerOs: P.OS.MAC, lastRx: Date.now(), send: m => sent.push(m) });
  const helper = Object.assign(new EventEmitter(), { send: (cmd, args) => injected.push({ cmd, ...args }), request: async () => ({}), stop() {} });
  const settings = { kvm: { speed: 1, linked: true, beDriven: true }, keys: { swapCtrlCmd: true }, files: {} };
  Module._load = mockLoad;
  const kvm = new Kvm({ link, helper, settings, fileRecv: { onRelease() {} }, clip: { sendIfChanged() {} }, onChange() {} });
  Module._load = load;
  kvm.mode = 'driven'; kvm.peerRoute = 1;
  t.after(() => { kvm._setMode('home', ''); });
  return { kvm, sent, injected, settings };
}
const tick = () => new Promise(r => setImmediate(r));
test('queued incoming movement cannot cross a quick home-and-return handoff', async t => {
  const f = fixture(t); f.kvm._inject({ t: P.T.K_MOVE, dx: 20, dy: 1 });
  f.kvm._setMode('home', ''); f.kvm._setMode('driven', '');
  f.kvm._inject({ t: P.T.K_MOVE, dx: 2, dy: 3 }); await tick();
  const moves = f.injected.filter(m => m.ev?.t === P.T.K_MOVE);
  assert.equal(moves.length, 1); assert.equal(moves[0].ev.dx, 2); assert.equal(moves[0].ev.dy, 3);
});
test('new takeover position discards movement queued for the previous route', async t => {
  const f = fixture(t); f.kvm._inject({ t: P.T.K_MOVE, dx: 20, dy: 1 });
  f.kvm._onTake({ route: 2, side: 'left', offset: .5 }); await tick();
  assert.equal(f.injected.some(m => m.ev?.t === P.T.K_MOVE), false);
  assert.equal(f.injected.some(m => m.cmd === 'place'), true);
});
test('KVM key repeats and release retain Ctrl/Cmd mapping after settings change', t => {
  const f = fixture(t); f.kvm._inject({ t: P.T.K_KEY_DOWN, code: 'MetaLeft' });
  f.settings.keys.swapCtrlCmd = false;
  f.kvm._inject({ t: P.T.K_KEY_DOWN, code: 'MetaLeft' });
  f.kvm._inject({ t: P.T.K_KEY_UP, code: 'MetaLeft' });
  assert.deepEqual(f.injected.filter(m => m.ev).map(m => m.ev.code), ['ControlLeft', 'ControlLeft', 'ControlLeft']);
});
test('KVM handoff clears key mapping for the next session', t => {
  const f = fixture(t); f.kvm._inject({ t: P.T.K_KEY_DOWN, code: 'MetaLeft' });
  f.kvm._setMode('home', ''); f.settings.keys.swapCtrlCmd = false; f.kvm._setMode('driven', '');
  f.kvm._inject({ t: P.T.K_KEY_DOWN, code: 'MetaLeft' }); assert.equal(f.injected.at(-1).ev.code, 'MetaLeft');
});
test('invalid movement does not poison the next cursor batch', async t => {
  const f = fixture(t); f.kvm._inject({ t: P.T.K_MOVE, dx: Infinity, dy: 1 });
  f.kvm._inject({ t: P.T.K_MOVE, dx: 4, dy: 5 }); await tick();
  const moves = f.injected.filter(m => m.ev?.t === P.T.K_MOVE);
  assert.equal(moves.length, 1); assert.equal(moves[0].ev.dx, 4); assert.equal(moves[0].ev.dy, 5);
});
test('nonfinite wheels are ignored and ordinary reverse scroll still works', t => {
  const f = fixture(t); f.settings.kvm.reverseScroll = true;
  f.kvm._inject({ t: P.T.K_WHEEL, dx: Infinity, dy: 1 });
  f.kvm._inject({ t: P.T.K_WHEEL, dx: 2, dy: -3 });
  assert.equal(f.injected.length, 1); assert.equal(f.injected[0].ev.dx, -2); assert.equal(f.injected[0].ev.dy, 3);
});
test('zoom accumulates fractional gestures and resets at handoff', t => {
  const f = fixture(t); f.kvm._onGesture({ g: 'zoom', phase: 'begin', v: .1 });
  assert.equal(f.injected.length, 0); f.kvm._onGesture({ g: 'zoom', v: .1 });
  assert.equal(f.injected.find(m => m.ev?.t === P.T.K_WHEEL).ev.dy, -1);
  f.kvm._setMode('home', ''); f.kvm._setMode('driven', ''); f.injected.length = 0;
  f.kvm._onGesture({ g: 'zoom', v: .11 }); assert.equal(f.injected.length, 0);
});
test('huge finite zoom finishes promptly and emits a bounded wheel event', { timeout: 1000 }, t => {
  const f = fixture(t); f.kvm._onGesture({ g: 'zoom', v: Number.MAX_VALUE });
  const wheel = f.injected.find(m => m.ev?.t === P.T.K_WHEEL);
  assert.ok(wheel); assert.ok(Math.abs(wheel.ev.dy) <= 67);
});
