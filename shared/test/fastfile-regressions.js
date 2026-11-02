'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const { FastFiles } = require('../fastfile');
const P = require('../protocol');
function stream() {
  return Object.assign(new EventEmitter(), {
    destroyed: false, complete: false, writableFinished: false,
    destroy() { this.destroyed = true; }, setTimeout() {}, resume() {},
    pipe(target) { this.target = target; }, writeHead() {}, end() {},
  });
}
function fixture(t, host = true) {
  const sent = [], delivered = [];
  const fx = new FastFiles({ session: () => ({ host, token: 'a'.repeat(32), address: '127.0.0.1' }), send: m => { sent.push(m); return true; }, deliver: m => delivered.push(m) });
  t.after(() => fx.reset()); return { fx, sent, delivered };
}
function reader(t) {
  const original = fs.createReadStream, rs = stream();
  fs.createReadStream = () => rs; t.after(() => { fs.createReadStream = original; }); return rs;
}
function put(t) {
  const f = fixture(t, false), rs = reader(t), req = stream(), original = https.request;
  https.request = () => req; t.after(() => { https.request = original; });
  f.fx._pinned = (r, fp, go) => { f.go = go; };
  return Object.assign(f, { rs, req });
}
test('reset destroys incoming body and discards held file.end from old session', t => {
  const f = fixture(t), body = stream(); f.fx._receive('id', body);
  f.fx.incoming({ t: P.T.FILE_END, id: 'id' }); f.fx.reset();
  assert.equal(body.destroyed, true); assert.deepEqual(f.delivered, []);
});
test('cancel does not finalize the canceled incoming file', t => {
  const f = fixture(t), body = stream(); f.fx._receive('id', body);
  f.fx.incoming({ t: P.T.FILE_END, id: 'id' }); f.fx.cancel('id');
  assert.equal(body.destroyed, true); assert.deepEqual(f.delivered, []);
});
test('replaced incoming stream cannot drop its replacement on late close', t => {
  const f = fixture(t), old = stream(), current = stream();
  f.fx._receive('id', old); f.fx._receive('id', current); old.emit('close');
  assert.equal(old.destroyed, true); assert.equal(f.fx.arriving.get('id').stream, current);
});
test('cancel from final chunk callback prevents HTTP success and held end delivery', t => {
  const f = fixture(t), body = stream(); let ok = false;
  f.fx.o.deliver = m => { f.delivered.push(m); f.fx.cancel('id'); };
  f.fx._receive('id', body, () => { ok = true; }); body.emit('data', Buffer.from('x'));
  f.fx.incoming({ t: P.T.FILE_END, id: 'id' }); body.emit('end');
  assert.equal(ok, false); assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].t, P.T.FILE_CHUNK);
});
test('replacement from final chunk callback survives old end handler', t => {
  const f = fixture(t), body = stream(), current = stream();
  f.fx.o.deliver = () => f.fx._receive('id', current);
  f.fx._receive('id', body); body.emit('data', Buffer.from('x')); body.emit('end');
  assert.equal(f.fx.arriving.get('id').stream, current);
});
test('incoming stream error is contained and clears receiver', t => {
  const f = fixture(t), body = stream(); f.fx._receive('id', body);
  assert.doesNotThrow(() => body.emit('error', new Error('broken socket')));
  assert.equal(f.fx.arriving.size, 0);
});
for (const behavior of ['false', 'throw']) test('failed pull announcement clears waiter: ' + behavior, async t => {
  const f = fixture(t); f.fx.o.send = () => { if (behavior === 'throw') throw new Error('closed'); return false; };
  const pending = f.fx.send('id', 'unused', 1, () => {});
  if (f.fx.outgoing.size) f.fx.cancel('id');
  await assert.rejects(pending);
  assert.equal(f.fx.outgoing.size, 0); assert.equal(f.fx.broken, true);
});
test('host cancellation stops disk reader and suppresses late progress', async t => {
  const f = fixture(t), rs = reader(t), req = stream(), res = stream(); let bytes = 0;
  const pending = f.fx.send('id', 'unused', 1, n => { bytes += n; }); const rejected = assert.rejects(pending);
  f.fx._serve('id', req, res); f.fx.cancel('id'); rs.emit('data', Buffer.from('late'));
  await rejected; assert.equal(rs.destroyed, true); assert.equal(res.destroyed, true); assert.equal(bytes, 0);
});
test('late host response close cannot fail a replacement transfer', async t => {
  const f = fixture(t), rs = reader(t), req = stream(), res = stream();
  const first = f.fx.send('id', 'unused', 1, () => {}); const rejected = assert.rejects(first);
  f.fx._serve('id', req, res); f.fx.cancel('id'); await rejected;
  const second = f.fx.send('id', 'unused', 1, () => {}); const rejected2 = assert.rejects(second);
  res.emit('close'); rs.emit('error', new Error('late read error'));
  assert.equal(f.fx.outgoing.has('id'), true); f.fx.cancel('id'); await rejected2;
});
test('PUT cancellation stops disk reader and suppresses late progress', async t => {
  const f = put(t); let bytes = 0;
  const pending = f.fx.send('id', 'unused', 1, n => { bytes += n; }); const rejected = assert.rejects(pending);
  f.go(); f.fx.cancel('id'); f.rs.emit('data', Buffer.from('late')); await rejected;
  assert.equal(f.rs.destroyed, true); assert.equal(bytes, 0);
});
test('late certificate callback cannot open disk reader after cancellation', async t => {
  const f = put(t), pending = f.fx.send('id', 'unused', 1, () => {}), rejected = assert.rejects(pending);
  f.fx.cancel('id'); f.go(); await rejected; assert.equal(f.rs.target, undefined);
});
test('aborted PUT response rejects instead of waiting indefinitely', async t => {
  const f = put(t), pending = f.fx.send('id', 'unused', 1, () => {}), rejected = assert.rejects(pending);
  f.go(); const res = stream(); f.req.emit('response', res); res.emit('aborted');
  assert.equal(f.fx.outgoing.size, 0); await rejected; assert.equal(f.rs.destroyed, true);
});
test('duplicate outgoing ID does not replace active sender', async t => {
  const f = fixture(t), first = f.fx.send('id', 'unused', 1, () => {}), rejected = assert.rejects(first);
  const active = f.fx.outgoing.get('id'); const second = f.fx.send('id', 'unused', 1, () => {});
  if (f.fx.outgoing.get('id') !== active) f.fx.cancel('id');
  await assert.rejects(second, /already transferring/); assert.equal(f.fx.outgoing.get('id'), active);
  f.fx.cancel('id'); await rejected;
});
test('malformed unicode token is refused without throwing', t => {
  const f = fixture(t), req = stream(), res = stream(); let status;
  Object.assign(req, { url: '/twindesk/fx/id', method: 'GET', headers: { 'x-twindesk-fx': 'é'.repeat(32) } });
  res.writeHead = code => { status = code; };
  assert.doesNotThrow(() => f.fx.request(req, res)); assert.equal(status, 403);
});
test('normal incoming body flushes bytes before held file.end and succeeds', t => {
  const f = fixture(t), body = stream(); let ok = false;
  f.fx._receive('id', body, () => { ok = true; }); body.emit('data', Buffer.from('x'));
  f.fx.incoming({ t: P.T.FILE_END, id: 'id' }); body.complete = true; body.emit('end'); body.emit('close');
  assert.equal(ok, true); assert.deepEqual(f.delivered.map(m => m.t), [P.T.FILE_CHUNK, P.T.FILE_END]); assert.equal(f.fx.arriving.size, 0);
});


test('late GET response after cancellation is destroyed instead of consumed', t => {
  const f = put(t); f.fx._pull('id'); f.fx.cancel('id');
  const res = stream(); res.statusCode = 200; f.req.emit('response', res);
  assert.equal(res.destroyed, true); assert.equal(f.fx.arriving.size, 0);
});
