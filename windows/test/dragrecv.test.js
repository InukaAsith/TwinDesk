'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const P = require('../../shared/protocol');
let root;
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { app: { getPath: () => root } };
  return load.call(this, id, ...args);
};
const DragRecv = require('../dragrecv');
Module._load = load;
function fixture(t) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-drag-'));
  const dir = root, sent = [], events = [], fx = {};
  const link = Object.assign(new EventEmitter(), { send: m => { sent.push(m); return true; }, fx: { pressure() {}, receiver: h => { fx.hook = h; } } });
  const helper = Object.assign(new EventEmitter(), { send: (name, m) => events.push({ name, ...m }) });
  const recv = new DragRecv({ link, helper, settings: { files: { edgeDrag: true, acceptFromMac: true } }, isDriven: () => true, onChange() {} });
  t.after(() => { recv.cancel('cancelled', false); fs.rmSync(dir, { recursive: true, force: true }); });
  const paste = list => recv.startPaste({ batch: 'b', list, dir: 'target' });
  const offer = (rel = 'a', id = 'id', size = 1) => recv._offer({ drop: 'paste', batch: 'b', rel, id, size });
  return { recv, sent, events, paste, offer, dir, fx };
}
for (const list of [[{ rel: 'a', size: '1' }], [{ rel: 'a', size: 0.5 }], [{ rel: 'A', size: 1 }, { rel: 'a', size: 1 }], [{ rel: 'a', size: 1 }, { rel: 'a/b', size: 1 }]]) {
  test('invalid tree leaves no temporary files: ' + JSON.stringify(list), t => {
    const f = fixture(t); assert.equal(f.paste(list), false);
    assert.equal(fs.existsSync(f.recv.root), false);
  });
}
test('duplicate transfer IDs cannot overwrite another file', t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 1 }, { rel: 'b', size: 1 }]);
  f.offer(); f.offer('b'); assert.equal(f.recv.cur.byId.get('id').rel, 'a');
  assert.equal(f.sent.at(-1).t, P.T.FILE_REFUSE);
});
test('oversized chunk fails immediately and acknowledges paste failure once', t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 1 }]); f.offer();
  f.recv._chunk({ id: 'id', seq: 0, data: Buffer.from('xx') });
  f.recv._fail(f.recv.cur.byId.get('id'));
  assert.equal(f.recv.cur.byId.get('id').got, 0);
  assert.equal(f.sent.filter(m => m.t === P.T.FILE_DONE && m.ok === false).length, 1);
});
test('asynchronous disk errors fail paste without escaping the stream', t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 1 }]); f.offer();
  const file = f.recv.cur.byId.get('id'); file.out.emit('error', new Error('disk full'));
  assert.equal(file.state, 'failed'); assert.equal(f.sent.at(-1).ok, false);
});
test('cancel during close cannot later become successful', t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 0 }]); f.offer('a', 'id', 0);
  const file = f.recv.cur.byId.get('id'); const out = file.out;
  file.out = Object.assign(new EventEmitter(), { end() {}, destroy() {} });
  out.destroy();
  f.recv._end({ id: 'id', sha256: crypto.createHash('sha256').digest('hex') });
  f.recv._fail(file); file.out.emit('close');
  assert.equal(file.state, 'failed'); assert.equal(f.sent.filter(m => m.t === P.T.FILE_DONE && m.ok).length, 0);
});
test('valid paste acknowledges only after file is closed', async t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 1 }]); f.offer();
  f.recv._chunk({ id: 'id', seq: 0, data: Buffer.from('x') });
  const file = f.recv.cur.byId.get('id');
  const closed = new Promise(resolve => file.out.once('close', resolve));
  f.recv._end({ id: 'id', sha256: crypto.createHash('sha256').update('x').digest('hex') });
  assert.equal(f.sent.some(m => m.t === P.T.FILE_DONE), false); await closed;
  assert.equal(file.state, 'ok'); assert.equal(fs.readFileSync(file.tmp, 'utf8'), 'x');
  assert.equal(f.sent.at(-1).ok, true);
});
test('disk setup failure is contained by edge drag handler', t => {
  const f = fixture(t); f.recv._build = () => { throw new Error('access denied'); };
  assert.doesNotThrow(() => f.recv._start({ drag: 'd', list: [{ rel: 'a', size: 1 }] }));
  assert.equal(f.sent.at(-1).result, 'failed');
});
test('late error from old drag cannot affect replacement', t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 1 }]); f.offer();
  const old = f.recv.cur, file = old.byId.get('id');
  f.paste([{ rel: 'new', size: 1 }]); const count = f.events.length;
  file.out.emit('error', new Error('late')); assert.equal(f.events.length, count);
  assert.equal(f.recv.cur.files.has('new'), true);
});
test('fast files never fill the file the helper streams to Windows', async t => {
  const f = fixture(t); f.paste([{ rel: 'a', size: 4 }]); f.offer('a', 'id', 4);
  const file = f.recv.cur.byId.get('id');
  const target = await f.fx.hook.target('id', 4);
  assert.notEqual(target, file.tmp);
  fs.writeFileSync(target, Buffer.alloc(4)); // the engine sizes it up front, ranges still arriving
  assert.equal(fs.statSync(file.tmp).size, 0); // the helper sees nothing to read yet
  fs.writeFileSync(target, 'abcd');
  const closed = new Promise(resolve => file.out.once('close', resolve));
  f.fx.hook.adopt('id'); await closed;
  assert.equal(file.state, 'ok'); assert.equal(fs.readFileSync(file.tmp, 'utf8'), 'abcd');
  assert.equal(f.events.at(-1).state, 'ok');
});
