'use strict';
// windows/filedrop.js with shared/outbox.js: Pause stops a Send files batch (file.cancel pause), the
// rest waits; Resume offers only the files that hadn't arrived, with cont; sent while away, it goes
// once the device connects.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../../shared/protocol.js');
const FileDrop = require('../filedrop.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-send-'));
  const folder = path.join(dir, 'Photos');
  fs.mkdirSync(folder);
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(folder, n), n);
  const sent = [];
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, bufferedAmount: 0, send: (m) => { sent.push(m); return true; } });
  link.on = link.on.bind(link);
  const drop = new FileDrop({ link, settings: { files: { outboxHours: 24 } }, peer: () => ({ id: 'mac', name: 'Studio' }), onProgress() {} });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, folder, sent, link, drop };
}

test('Pause keeps the files that hadn’t arrived; Resume sends them with cont', async (t) => {
  const f = fixture(t);
  const r = f.drop.sendBatch([f.folder], 'send');
  await tick();
  const first = f.sent.find((m) => m.t === P.T.FILE_OFFER);
  assert.equal(first.rel, 'Photos/a.txt');
  // a.txt arrives
  f.link.emit(P.T.FILE_ACCEPT, { t: P.T.FILE_ACCEPT, id: first.id });
  await tick();
  f.link.emit(P.T.FILE_DONE, { t: P.T.FILE_DONE, id: first.id, ok: true });
  await tick();
  const second = f.sent.filter((m) => m.t === P.T.FILE_OFFER)[1];
  assert.equal(second.rel, 'Photos/b.txt');
  assert.ok(f.drop.pause(r.batch));
  assert.ok(f.sent.some((m) => m.t === P.T.FILE_CANCEL && m.id === second.id && m.pause === true));
  const box = f.drop.view().outbox;
  assert.deepEqual(box.map((e) => [e.state, e.files]), [['paused', 2]]);
  assert.equal(f.drop.batches.size, 0);
  await tick();
  f.sent.length = 0;
  assert.ok(f.drop.resume(box[0].id));
  await tick();
  const again = f.sent.find((m) => m.t === P.T.FILE_OFFER);
  assert.equal(again.rel, 'Photos/b.txt');
  assert.equal(again.cont, r.batch);
  assert.equal(again.count, 2);
  assert.equal(f.drop.view().outbox.length, 0);
  f.drop.cancel();
});

test('Sent while away: it goes when the device connects', async (t) => {
  const f = fixture(t);
  f.drop.lastPeer = null;
  f.drop.outbox.last = { id: 'mac', name: 'Studio' };
  f.link.status.state = 'disconnected';
  assert.equal(f.drop.send([path.join(f.folder, 'a.txt')]), 'queued');
  assert.equal(f.sent.length, 0);
  f.link.status.state = 'connected';
  f.link.emit('welcome', {});
  await tick();
  assert.equal(f.sent.find((m) => m.t === P.T.FILE_OFFER).name, 'a.txt');
  f.drop.cancel();
});
