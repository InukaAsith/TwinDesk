// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/drop.js receives files without blocking the main thread: writes go in order on a chain,
// file.end waits for them, fast files get backpressure past 8 MB, and an abort closes the file only
// after its writes (its fd number can't go to another file under them).
// Run with: node shared/test/drop-async.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const P = require('../protocol.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-async-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { shell: { showItemInFolder() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } };
  return load.call(this, id, ...args);
};
const { Drop } = require('../../mac/drop.js');
Module._load = load;

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

(async () => {
  const sent = [];
  const pressures = [];
  const server = Object.assign(new EventEmitter(), {
    current: { name: 'PC' },
    sendToClient: (m) => sent.push(m),
    fx: { pressure: (fn) => pressures.push(fn) },
  });
  const settings = { files: { acceptDrops: true, folder: dir } };
  const drop = new Drop({ server, helper: Object.assign(new EventEmitter(), { request: async () => ({}), send() {} }), displays: { target: () => null }, getSettings: () => settings });
  assert.strictEqual(pressures.length, 1, 'registered with fast files');
  const emit = (m) => server.emit(`t:${m.t}`, m);

  // A batch file of 40 MB in 1 MB chunks: the handler never waits for the disk.
  const data = crypto.randomBytes(40 * 1024 * 1024);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  emit({ t: P.T.FILE_OFFER, id: 'f1', name: 'big.bin', size: data.length, drop: 'send', batch: 'b1', count: 1 });
  await until(() => sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'f1'));
  let slowest = 0;
  let pressed = 0;
  for (let i = 0, seq = 0; i < data.length; i += 1024 * 1024, seq++) {
    const t0 = process.hrtime.bigint();
    emit({ t: P.T.FILE_CHUNK, id: 'f1', seq, data: data.subarray(i, i + 1024 * 1024) });
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - t0) / 1e6);
    const p = pressures[0]('f1');
    if (p) { pressed++; await p; }
  }
  emit({ t: P.T.FILE_END, id: 'f1', sha256 });
  await until(() => sent.some((m) => m.t === P.T.FILE_DONE && m.id === 'f1'));
  const done = sent.find((m) => m.t === P.T.FILE_DONE && m.id === 'f1');
  assert.strictEqual(done.ok, true, done.error);
  assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(data), 'every byte, in order');
  assert.ok(pressed > 0, 'backpressure past 8 MB');
  console.log(`  slowest chunk handler: ${slowest.toFixed(2)} ms, waited for the disk ${pressed} times`);

  // A wrong checksum still fails, after the writes.
  emit({ t: P.T.FILE_OFFER, id: 'f2', name: 'bad.bin', size: 10, drop: 'send', batch: 'b2', count: 1 });
  await until(() => sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'f2'));
  emit({ t: P.T.FILE_CHUNK, id: 'f2', seq: 0, data: Buffer.alloc(10, 1) });
  emit({ t: P.T.FILE_END, id: 'f2', sha256: '00'.repeat(32) });
  await until(() => sent.some((m) => m.t === P.T.FILE_DONE && m.id === 'f2'));
  assert.strictEqual(sent.find((m) => m.t === P.T.FILE_DONE && m.id === 'f2').ok, false);
  assert.ok(!fs.existsSync(path.join(dir, 'bad.bin')));

  // Cancelled mid-way: the part file goes once its writes are done.
  emit({ t: P.T.FILE_OFFER, id: 'f3', name: 'gone.bin', size: 8 * 1024 * 1024, drop: 'send', batch: 'b3', count: 1 });
  await until(() => sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'f3'));
  for (let seq = 0; seq < 4; seq++) emit({ t: P.T.FILE_CHUNK, id: 'f3', seq, data: Buffer.alloc(1024 * 1024, seq) });
  emit({ t: P.T.FILE_CANCEL, id: 'f3' });
  assert.strictEqual(pressures[0]('f3'), null, 'nothing to wait for once it is gone');
  await until(() => !fs.readdirSync(dir).some((f) => f.includes('gone.bin')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('drop-async: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
