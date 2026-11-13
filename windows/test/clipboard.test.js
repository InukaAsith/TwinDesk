'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const P = require('../../shared/protocol');
let read, writes;
const load = Module._load;
const mockLoad = function (id, ...args) {
  if (id === 'electron') return { clipboard: { readText: () => read(), writeText: t => writes.push(t), availableFormats: () => [], readBuffer: () => Buffer.alloc(0) } };
  return load.call(this, id, ...args);
};
Module._load = mockLoad;
const Clip = require('../clip');
Module._load = load;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  writes = []; read = () => 'text';
  const sent = [], cfg = { enabled: true, send: true, receive: true, historySize: 10, maxKB: 1024, mode: 'switch' };
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, send: m => { sent.push(m); return true; } });
  Module._load = mockLoad;
  const clip = new Clip(link, () => cfg, () => {});
  Module._load = load;
  return { clip, cfg, link, sent };
}
test('clipboard send rechecks the disabled setting after an asynchronous read', async () => {
  const f = fixture(), wait = deferred(); read = () => wait.promise;
  const sending = f.clip.sendIfChanged(); f.cfg.enabled = false; wait.resolve('private'); await sending;
  assert.equal(f.sent.length, 0);
});
test('a clipboard read from the old connection is never sent to a new session', async () => {
  const f = fixture(), wait = deferred(); read = () => wait.promise;
  const sending = f.clip.sendIfChanged(); f.link.emit('closed'); f.link.emit('welcome'); wait.resolve('old'); await sending;
  assert.equal(f.sent.some(m => m.t === P.T.CLIP), false);
});
test('the newest outgoing clipboard read wins even when the older one resolves last', async () => {
  const f = fixture(), old = deferred(); read = () => old.promise;
  const first = f.clip.sendIfChanged(); read = () => 'new'; await f.clip.sendIfChanged(); old.resolve('old'); await first;
  assert.deepEqual(f.sent.filter(m => m.t === P.T.CLIP).map(m => m.text), ['new']);
});
test('incoming clipboard copies retain arrival order without awaiting an old local read', async () => {
  const f = fixture(), wait = deferred(); read = () => wait.promise;
  const first = f.clip._onClip({ text: 'old' }); read = () => 'local'; await f.clip._onClip({ text: 'new' }); wait.resolve('local'); await first;
  assert.equal(writes.at(-1), 'new'); assert.equal(f.clip.lastSync.received, 'new');
});
test('new connections can receive text that was already sent on a prior connection', async () => {
  const f = fixture(); await f.clip.sendIfChanged(); f.link.emit('closed'); f.link.emit('welcome'); await f.clip.sendIfChanged();
  assert.equal(f.sent.filter(m => m.t === P.T.CLIP).length, 2);
});
test('copying a recent text makes it eligible for instant synchronization', () => {
  const f = fixture(); f.clip.history = [{ text: 'again', dir: 'in' }]; f.clip.lastSync.received = 'again';
  f.clip.copyHistory(0);
  assert.notEqual(f.clip.seen, 'again'); assert.notEqual(f.clip.lastSync.received, 'again');
});
test('clipboard read failures settle without an unhandled rejection', async () => {
  const f = fixture(); read = async () => { throw new Error('clipboard busy'); };
  await assert.doesNotReject(f.clip.sendIfChanged());
});
test('picture polling resumes when the clipboard helper exits', () => {
  const f = fixture(), helper = new EventEmitter(); f.clip.useHelper(helper);
  helper.emit('event', 'clipboard'); assert.equal(f.clip.watched, true);
  helper.emit('exit'); assert.equal(f.clip.watched, false);
});
test('received clipboard text is recorded without echoing it to the peer', async () => {
  const f = fixture(); read = () => 'remote';
  await f.clip._onClip({ text: 'remote' }); await f.clip.sendIfChanged();
  assert.deepEqual(writes, ['remote']); assert.equal(f.clip.history[0].dir, 'in'); assert.equal(f.sent.length, 0);
});
test('copies can be repeated after a different copy crosses in either direction', async () => {
  const f = fixture();
  read = () => 'A'; await f.clip.sendIfChanged();
  await f.clip._onClip({ text: 'B' }); read = () => 'B'; await f.clip.sendIfChanged();
  read = () => 'A'; await f.clip.sendIfChanged();
  await f.clip._onClip({ text: 'B' }); read = () => 'C'; await f.clip.sendIfChanged();
  read = () => 'B'; await f.clip.sendIfChanged();
  assert.deepEqual(f.sent.filter(m => m.t === P.T.CLIP).map(m => m.text), ['A', 'A', 'C', 'B']);
});

function pollFixture(t) {
  const f = fixture(), original = global.setInterval;
  global.setInterval = fn => { f.poll = fn; return { fake: true }; };
  read = () => 'initial';
  try { f.clip._startPoll(); } finally { global.setInterval = original; }
  t.after(() => f.clip._stopPoll());
  return f;
}
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('instant clipboard retries text after transport rejects a send', async t => {
  const f = pollFixture(t); await drain(); read = () => 'new copy'; let attempts = 0;
  f.link.send = m => { if (m.t === P.T.CLIP) { attempts++; if (attempts === 1) return false; f.sent.push(m); } return true; };
  await f.poll(); await f.poll(); await f.poll();
  assert.equal(attempts, 2); assert.equal(f.clip.seen, 'new copy');
  assert.equal(f.sent.filter(m => m.t === P.T.CLIP).length, 1);
});
test('instant clipboard retries after a temporarily busy second read', async t => {
  const f = pollFixture(t); await drain(); let reads = 0;
  read = () => { if (++reads === 2) throw new Error('clipboard locked'); return 'new copy'; };
  await f.poll(); await f.poll(); assert.equal(f.sent.filter(m => m.t === P.T.CLIP).length, 1);
});
test('instant clipboard retries when peer resumes accepting copies', async t => {
  const f = pollFixture(t); await drain(); read = () => 'new copy'; f.clip.peerAccepts = false;
  await f.poll(); f.link.emit(P.T.CLIP_POLICY, { accept: true }); await f.poll();
  assert.equal(f.sent.filter(m => m.t === P.T.CLIP).length, 1);
});
test('instant clipboard consumes intentionally skipped oversized text once', async t => {
  const f = pollFixture(t); await drain(); f.cfg.maxKB = 0; read = () => 'large';
  await f.poll(); assert.equal(f.clip.seen, 'large'); assert.equal(f.sent.length, 0);
});
test('received copy during pending poll is not overwritten or echoed', async t => {
  const f = pollFixture(t); await drain(); const wait = deferred(); let reads = 0;
  read = () => ++reads === 1 ? 'local' : wait.promise;
  const poll = f.poll(); await drain(); await f.clip._onClip({ text: 'remote' });
  wait.resolve('local'); await poll; assert.equal(f.clip.seen, 'remote');
  assert.equal(f.sent.filter(m => m.t === P.T.CLIP).length, 0);
});
