'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const P = require('../../shared/protocol');
let capture, launch;
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { desktopCapturer: { getSources: () => capture() }, screen: { getPrimaryDisplay: () => ({ displayFrequency: 60 }) } };
  if (id === 'child_process') return { spawn: (...a) => launch(...a) };
  if (id === './pcscreen') return { fps: () => 60 };
  return load.call(this, id, ...args);
};
const PcApps = require('../pcapps');
Module._load = load;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const sent = [], started = [], stopped = [];
  capture = async () => [{ id: 'window:1:0' }];
  launch = () => { const child = Object.assign(new EventEmitter(), { unref() {} }); queueMicrotask(() => child.emit('spawn')); return child; };
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, send: m => sent.push(m) });
  const helper = Object.assign(new EventEmitter(), { send() {}, request: async () => ({ windows: [] }) });
  const sender = Object.assign(new EventEmitter(), { start: o => { started.push(o); return 'session'; }, stop: s => stopped.push(s) });
  const settings = { pcApps: { allow: true }, pcScreen: { mbps: 10, input: true }, keys: {} };
  const apps = new PcApps({ link, helper, sender, settings, inputAllowed: () => true, onChange() {} });
  apps.macAccepts = true; apps._apps = async () => [{ id: 'app', exe: '' }];
  t.after(() => apps.shutdown());
  return { apps, link, helper, settings, sent, started, stopped };
}
for (const action of ['policy', 'disconnect', 'disable', 'shutdown']) {
  test('pending capture cannot restart after ' + action, async t => {
    const f = fixture(t), wait = deferred(); capture = () => wait.promise;
    const sync = f.apps._sync([{ wid: 1 }]);
    if (action === 'policy') f.link.emit(P.T.PAPP_POLICY, { accept: false });
    if (action === 'disconnect') f.link.emit('closed');
    if (action === 'disable') { f.settings.pcApps.allow = false; f.apps.apply(); }
    if (action === 'shutdown') f.apps.shutdown();
    wait.resolve([{ id: 'window:1:0' }]); await sync; assert.equal(f.started.length, 0);
  });
}
test('overlapping window refreshes share one capture lookup and start only once', async t => {
  const f = fixture(t), first = deferred(); let calls = 0;
  capture = () => { calls++; return first.promise; };
  const old = f.apps._sync([{ wid: 1 }]), current = f.apps._sync([{ wid: 1 }]);
  first.resolve([{ id: 'window:1:0' }]); await Promise.all([old, current]);
  assert.equal(f.started.length, 1); assert.equal(calls, 1);
});

test('disconnect during app lookup prevents launch', async t => {
  const f = fixture(t), wait = deferred(); f.apps._apps = () => wait.promise;
  let calls = 0; launch = () => { calls++; throw new Error('must not launch'); };
  const pending = f.apps._launch('app'); f.link.emit('closed'); wait.resolve([{ id: 'app' }]); await pending;
  assert.equal(calls, 0); assert.equal(f.apps.launched.size, 0);
});
test('disable during window lookup prevents launch', async t => {
  const f = fixture(t), wait = deferred(); f.helper.request = () => wait.promise;
  let calls = 0; launch = () => { calls++; throw new Error('must not launch'); };
  const pending = f.apps._launch('app'); await Promise.resolve(); await Promise.resolve();
  f.settings.pcApps.allow = false; f.apps.apply(); wait.resolve({ windows: [] }); await pending;
  assert.equal(calls, 0);
});
test('duplicate launch requests open one app', async t => {
  const f = fixture(t); let calls = 0; const original = launch; launch = (...a) => { calls++; return original(...a); };
  await Promise.all([f.apps._launch('app'), f.apps._launch('app')]); assert.equal(calls, 1);
});
test('asynchronous spawn failure returns failure instead of crashing', async t => {
  const f = fixture(t); launch = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('missing explorer'))); return child; };
  await f.apps._launch('app'); assert.equal(f.apps.launched.size, 0);
  assert.equal(f.sent.at(-1).ok, false); assert.match(f.sent.at(-1).why, /missing explorer/);
});
test('catalogue completing after disconnect is not sent to another session', async t => {
  const f = fixture(t), wait = deferred(); f.apps._build = () => wait.promise;
  const pending = f.apps._list(); f.link.emit('closed'); wait.resolve([{ id: 'app' }]); await pending;
  assert.equal(f.sent.some(m => m.t === P.T.PAPPS_RESULT), false);
});

test('stopping window sharing releases held remote keys', async t => {
  const f = fixture(t); let releases = 0;
  f.helper.send = cmd => { if (cmd === 'releaseAll') releases++; };
  await f.apps._sync([{ wid: 1 }]); f.apps.input.held = true;
  f.link.emit(P.T.PAPP_POLICY, { accept: false });
  assert.equal(releases, 1); assert.equal(f.apps.streams.size, 0);
});

test('a capture lookup is released after failure so a later request can retry', async t => {
  const f = fixture(t); let calls = 0;
  capture = async () => { calls++; throw new Error('temporarily unavailable'); };
  await f.apps._sync([{ wid: 1 }]);
  await f.apps._sync([]); await f.apps._sync([{ wid: 2 }]);
  assert.equal(calls, 2);
});
test('many overlapping capture refreshes start only the latest requested windows', async t => {
  const f = fixture(t), wait = deferred(); let calls = 0;
  capture = () => { calls++; return wait.promise; };
  const pending = Array.from({length: 20}, (_, n) => f.apps._sync([{ wid: n + 1 }]));
  wait.resolve([{ id: 'window:20:0' }]); await Promise.all(pending);
  assert.equal(calls, 1); assert.equal(f.started.length, 1);
  assert.equal(f.started[0].sourceId, 'window:20:0');
});
