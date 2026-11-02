'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const P = require('../../shared/protocol.js');

let activeDir;
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => activeDir } };
  if (id === 'child_process') return { spawn: () => ({ unref() {} }) };
  return load.call(this, id, ...args);
};
const FileRecv = require('../filerecv.js');
Module._load = load;
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
// Real files: their close, link and rename can take longer than a tick on a busy machine.
const until = async (done, ms = 2000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await tick(); };
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-recv-'));
  activeDir = dir;
  const sent = [], batches = [];
  const link = Object.assign(new EventEmitter(), { send: (m) => sent.push(m) });
  const recv = new FileRecv({ link, settings: { files: { acceptFromMac: true } }, helper: { request: async () => ({ path: dir }) }, onChange() {}, onBatch: (b) => batches.push(b) });
  t.after(async () => { link.emit('closed'); await tick(); fs.rmSync(dir, { recursive: true, force: true }); });
  const offer = (id, name, size, extra = {}) => link.emit(P.T.FILE_OFFER, { id, name, size, ...extra });
  const chunk = (id, data, seq = 0) => link.emit(P.T.FILE_CHUNK, { id, data, seq });
  const end = (id, data) => link.emit(P.T.FILE_END, { id, sha256: digest(data) });
  return { dir, sent, batches, recv, link, offer, chunk, end };
}

test('a transfer id cannot choose a path outside incoming', async (t) => {
  const f = fixture(t);
  f.offer('../escaped', 'safe.txt', 1);
  await tick();
  assert.equal(fs.existsSync(path.join(f.dir, 'escaped.part')), false);
  const transfer = f.recv.files.get('../escaped');
  if (transfer) assert.equal(path.dirname(transfer.tmp), f.recv.dir);
});

test('a chunk beyond the declared size fails before writing', async (t) => {
  const f = fixture(t);
  f.offer('oversize', 'small.txt', 1);
  f.chunk('oversize', Buffer.alloc(100));
  await tick();
  assert.equal(f.recv.files.size, 0);
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_DONE && m.ok === false));
});

test('write failures report failure and remove the active transfer', async (t) => {
  const f = fixture(t);
  const create = fs.createWriteStream;
  fs.createWriteStream = () => {
    const stream = Object.assign(new EventEmitter(), { write() {}, destroy() { this.emit('close'); } });
    setImmediate(() => stream.emit('error', new Error('disk full')));
    return stream;
  };
  try { f.offer('disk-error', 'file.txt', 1, { drop: 'send', batch: 'disk', count: 1 }); f.recv._chunk({ id: 'disk-error', seq: 0, data: Buffer.from('a') }); }
  finally { fs.createWriteStream = create; }
  await tick();
  assert.equal(f.recv.bfiles.size, 0);
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_DONE && m.ok === false));
});

test('simultaneous batches with the same name keep both files', async (t) => {
  const f = fixture(t);
  f.offer('one', 'report.txt', 1, { drop: 'send', batch: 'one', count: 1 });
  f.offer('two', 'report.txt', 1, { drop: 'send', batch: 'two', count: 1 });
  f.chunk('one', Buffer.from('a'));
  f.chunk('two', Buffer.from('b'));
  f.end('one', Buffer.from('a'));
  f.end('two', Buffer.from('b'));
  await tick();
  const files = fs.readdirSync(f.dir).filter((n) => n.endsWith('.txt'));
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((n) => fs.readFileSync(path.join(f.dir, n), 'utf8')).sort(), ['a', 'b']);
});

test('a file created by another app during transfer is never overwritten', async (t) => {
  const f = fixture(t);
  f.offer('race', 'report.txt', 1, { drop: 'send', batch: 'race', count: 1 });
  f.chunk('race', Buffer.from('a'));
  fs.writeFileSync(path.join(f.dir, 'report.txt'), 'original');
  f.end('race', Buffer.from('a'));
  await tick();
  assert.equal(fs.readFileSync(path.join(f.dir, 'report.txt'), 'utf8'), 'original');
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_DONE && m.ok === false));
});

test('cancelling after file.end cannot publish a successful result', async (t) => {
  const f = fixture(t);
  f.offer('cancel', 'cancel.txt', 1, { drop: 'send', batch: 'cancel', count: 1 });
  f.chunk('cancel', Buffer.from('a'));
  f.end('cancel', Buffer.from('a'));
  f.link.emit(P.T.FILE_CANCEL, { id: 'cancel' });
  await tick();
  assert.equal(fs.existsSync(path.join(f.dir, 'cancel.txt')), false);
  assert.equal(f.sent.some((m) => m.t === P.T.FILE_DONE && m.ok === true), false);
  assert.equal(fs.readdirSync(f.dir).some((n) => n.includes('part')), false);
});

test('empty files and nested files finish with correct contents', async (t) => {
  const f = fixture(t);
  f.offer('empty', 'empty.txt', 0, { drop: 'send', batch: 'tree', count: 2, rel: 'folder/empty.txt' });
  f.offer('text', 'text.txt', 5, { drop: 'send', batch: 'tree', count: 2, rel: 'folder/text.txt' });
  f.end('empty', Buffer.alloc(0));
  f.chunk('text', 'aGVsbG8=');
  f.end('text', Buffer.from('hello'));
  await until(() => f.sent.some((m) => m.t === P.T.FILES_DONE));
  assert.equal(fs.readFileSync(path.join(f.dir, 'folder', 'text.txt'), 'utf8'), 'hello');
  assert.equal(fs.statSync(path.join(f.dir, 'folder', 'empty.txt')).size, 0);
  assert.ok(f.sent.some((m) => m.t === P.T.FILES_DONE && m.ok && m.files === 2));
  assert.equal(f.recv.bfiles.size, 0);
});

test('a checksum mismatch deletes partial data and reports failure', async (t) => {
  const f = fixture(t);
  f.offer('hash', 'bad.txt', 1, { drop: 'send', batch: 'hash', count: 1 });
  f.chunk('hash', Buffer.from('a'));
  f.end('hash', Buffer.from('b'));
  await tick();
  assert.equal(fs.existsSync(path.join(f.dir, 'bad.txt')), false);
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_DONE && m.error === 'checksum mismatch'));
  assert.equal(fs.readdirSync(f.dir).some((n) => n.includes('part')), false);
});

test('a direct drag completes after its destination is chosen', async (t) => {
  const f = fixture(t);
  f.offer('drag', 'drop.txt', 4);
  await f.recv.onRelease();
  f.chunk('drag', Buffer.from('drop'));
  f.end('drag', Buffer.from('drop'));
  await until(() => f.recv.files.size === 0);
  assert.equal(fs.readFileSync(path.join(f.dir, 'drop.txt'), 'utf8'), 'drop');
  assert.equal(f.recv.files.size, 0);
});

test('a delayed folder lookup cannot set the next session destination', async (t) => {
  const f = fixture(t);
  let resolve;
  f.recv.helper.request = () => new Promise((yes) => { resolve = yes; });
  f.offer('old', 'old.txt', 1);
  const release = f.recv.onRelease();
  f.link.emit('closed');
  resolve({ path: f.dir });
  await release;
  assert.equal(f.recv.target, null);
});

test('case-insensitive duplicate paths fail without corrupting the first file', async (t) => {
  const f = fixture(t);
  f.offer('first', 'file.txt', 1, { drop: 'send', batch: 'alias', count: 2, rel: 'folder/file.txt' });
  f.offer('alias', 'FILE.txt', 1, { drop: 'send', batch: 'alias', count: 2, rel: 'folder/FILE.txt' });
  f.chunk('first', Buffer.from('a'));
  f.end('first', Buffer.from('a'));
  await tick();
  assert.equal(fs.readFileSync(path.join(f.dir, 'folder', 'file.txt'), 'utf8'), 'a');
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === 'alias'));
  assert.ok(f.sent.some((m) => m.t === P.T.FILES_DONE && m.ok === false && m.files === 1));
});
