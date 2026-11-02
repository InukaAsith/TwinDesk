'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const P = require('../../shared/protocol');
const FileDrop = require('../filedrop');
let tempDir;
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => tempDir }, globalShortcut: { unregister() {}, register: () => true } };
  return load.call(this, id, ...args);
};
const FileClip = require('../fclip');
const FileRecv = require('../filerecv');
Module._load = load;
const tick = () => new Promise(r => setTimeout(r, 25));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-actions-'));
  const dir = tempDir, sent = [], expected = [], requests = [];
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, bufferedAmount: 0, send: m => { sent.push(m); return true; } });
  const settings = { files: { dropToMac: true } };
  const fileDrop = new FileDrop({ link, settings, onProgress() {} });
  const helper = { request: async (name, args) => { requests.push({ name, args }); return { path: dir }; } };
  const fileClip = new FileClip({ link, settings, helper, fileDrop, fileRecv: { expectBatch: (...a) => expected.push(a) }, onChange() {}, popup() {}, peerName: () => 'peer' });
  t.after(async () => { link.emit('closed'); await tick(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, link, sent, fileDrop, fileClip, helper, expected, requests };
}
test('disconnect during destination lookup cancels file paste', async t => {
  const f = fixture(t), wait = deferred(); f.helper.request = () => wait.promise;
  f.fileClip.incoming = { id: 'copy', files: 1, bytes: 1 };
  const paste = f.fileClip.paste(); f.link.emit('closed'); wait.resolve({ path: f.dir }); await paste;
  assert.equal(f.expected.length, 0); assert.equal(f.fileClip.pasting, null);
  assert.equal(f.sent.some(m => m.t === P.T.FCLIP_PASTE), false);
});
test('overlapping paste shortcuts create only one destination request', async t => {
  const f = fixture(t), wait = deferred(); let calls = 0; f.helper.request = () => { calls++; return wait.promise; };
  f.fileClip.incoming = { id: 'copy', files: 1, bytes: 1 };
  const first = f.fileClip.paste(), second = f.fileClip.paste(); wait.resolve({ path: f.dir }); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(f.expected.length, 1);
});
test('completion of another paste cannot paste its files into the current app', async t => {
  const f = fixture(t), pending = { id: 'new', files: 1, into: { hwnd: 123 } };
  f.fileClip.pasting = pending;
  f.fileClip.pasted({ batch: 'old', kind: 'paste', files: 1, count: 1, ok: true, placed: ['old.txt'] });
  await tick(); assert.equal(f.fileClip.pasting, pending); assert.equal(f.requests.length, 0);
});
test('copy lookup completing after disconnect cannot announce old selected files', async t => {
  const f = fixture(t), wait = deferred(), file = path.join(f.dir, 'file.txt'); fs.writeFileSync(file, 'x');
  f.helper.request = () => wait.promise;
  const copy = f.fileClip.copy(); f.link.emit('closed'); wait.resolve({ explorer: true, selection: [file] }); await copy;
  assert.equal(f.fileClip.offer, null); assert.equal(f.sent.some(m => m.t === P.T.FCLIP_OFFER), false);
});
test('same-millisecond app pastes get separate temporary directories', t => {
  const f = fixture(t), now = Date.now; Date.now = () => 100000000;
  try { assert.notEqual(f.fileClip._pasteDir(), f.fileClip._pasteDir()); } finally { Date.now = now; }
});
test('a cancellation under backpressure stops the chunk loop promptly', async t => {
  const f = fixture(t), file = path.join(f.dir, 'file.txt'); fs.writeFileSync(file, 'x');
  f.link.bufferedAmount = 2 * 1024 * 1024;
  const cur = { id: 'id', sent: 0 }; f.fileDrop.active.set(cur.id, cur);
  const chunks = f.fileDrop._chunks({ path: file, size: 1 }, cur);
  await tick(); f.fileDrop.cancel();
  const result = await Promise.race([chunks.then(() => 'sent', () => 'cancelled'), new Promise(r => setTimeout(() => r('stuck'), 150))]);
  f.link.bufferedAmount = 0; await chunks.catch(() => {});
  assert.equal(result, 'cancelled'); assert.equal(f.sent.some(m => m.t === P.T.FILE_CHUNK), false);
});
test('drag cancellation leaves an unrelated transfer running', t => {
  const f = fixture(t), other = { id: 'other' };
  f.fileDrop.active.set('dragfile', { id: 'dragfile', drag: 'drag' }); f.fileDrop.active.set('other', other);
  f.fileDrop._stopDrag('drag', true);
  assert.equal(f.fileDrop.active.get('other'), other); assert.equal(f.sent.some(m => m.id === 'other' && m.t === P.T.FILE_CANCEL), false);
});
test('a duplicate batch request cannot overwrite active accounting', t => {
  const f = fixture(t), file = path.join(f.dir, 'file.txt'); fs.writeFileSync(file, 'x'); f.fileDrop._next = () => {};
  assert.ok(f.fileDrop.sendBatch([file], 'paste', 'same'));
  assert.equal(f.fileDrop.sendBatch([file], 'paste', 'same'), null); assert.equal(f.fileDrop.queue.length, 1);
});
test('transfer waiters exist before immediate offer and end acknowledgements', async t => {
  const f = fixture(t); f.fileDrop._fast = async () => 'digest';
  f.link.send = m => {
    f.sent.push(m);
    if (m.t === P.T.FILE_OFFER) f.link.emit(P.T.FILE_ACCEPT, { t: P.T.FILE_ACCEPT, id: m.id });
    if (m.t === P.T.FILE_END) f.link.emit(P.T.FILE_DONE, { t: P.T.FILE_DONE, id: m.id, ok: true });
    return true;
  };
  const cur = { id: 'instant', name: 'file', sent: 0 }; f.fileDrop.active.set(cur.id, cur);
  let finished = false;
  const sending = f.fileDrop._sendFile({ size: 1 }, cur).then(() => { finished = true; });
  await tick();
  if (!finished) f.link.emit('closed');
  await sending.catch(() => {}); assert.equal(finished, true);
});
test('a receiver write failure during chunks stops the sender without waiting for file.end', async t => {
  const f = fixture(t), cur = { id: 'id' };
  f.fileDrop.active.set(cur.id, cur);
  f.link.emit(P.T.FILE_DONE, { t: P.T.FILE_DONE, id: cur.id, ok: false, error: 'Disk full' });
  assert.throws(() => f.fileDrop._check(cur), /Disk full/);
});
test('a matching app-paste completion pastes once into the intended window', async t => {
  const f = fixture(t);
  f.fileClip.pasting = { id: 'copy', files: 1, into: { hwnd: 123 } };
  f.fileClip.pasted({ batch: 'copy', kind: 'paste', files: 1, count: 1, ok: true, placed: ['file.txt'] });
  await tick(); assert.equal(f.fileClip.pasting, null);
  assert.deepEqual(f.requests, [{ name: 'pasteFiles', args: { paths: ['file.txt'], hwnd: 123 } }]);
});
test('a nested paste batch transfers over paired links and reports its batch identity', async t => {
  const f = fixture(t), source = path.join(f.dir, 'source'), dest = path.join(f.dir, 'destination');
  fs.mkdirSync(source); fs.mkdirSync(dest); fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'empty.txt'), ''); fs.writeFileSync(path.join(source, 'nested/data.txt'), 'test contents');
  const batches = [], receiverLink = Object.assign(new EventEmitter(), { send: m => { setImmediate(() => f.link.emit(m.t, m)); return true; } });
  const recv = new FileRecv({ link: receiverLink, settings: { files: {} }, helper: { request: async () => ({}) }, onChange() {}, onBatch: b => batches.push(b) });
  f.link.send = m => { setImmediate(() => receiverLink.emit(m.t, m)); return true; };
  recv.expectBatch('batch', dest, 13, true);
  f.fileDrop.sendBatch([source], 'paste', 'batch');
  const end = Date.now() + 3000;
  while ((!batches.length || f.fileDrop.sending) && Date.now() < end) await tick();
  assert.equal(batches.length, 1); assert.equal(batches[0].batch, 'batch'); assert.equal(batches[0].ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'source/nested/data.txt'), 'utf8'), 'test contents');
  assert.equal(fs.statSync(path.join(dest, 'source/empty.txt')).size, 0);
  assert.equal(f.fileDrop.batches.size, 0); assert.equal(f.fileDrop.waiters.size, 0); receiverLink.emit('closed');
});
