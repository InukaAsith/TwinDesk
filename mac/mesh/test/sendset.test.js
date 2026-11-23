// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/mesh/sendset.js on a real hub: the Mac sends One a folder, and the selection moves to Two mid-send
// (a crossing). Before, the facade's 'closed' aborted it; now One's own FileSend goes on to the end.
// Run with: node mac/mesh/test/sendset.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const P = require('../../../shared/protocol.js');
const { node, close, waitFor, pairPhone, helloPhone } = require('./lib/mesh.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => os.tmpdir() }, powerSaveBlocker: { start: () => 1, stop() {} } };
  return load.call(this, id, ...args);
};
const { FileSend } = require('../../filesend.js');
const { SendSet } = require('../sendset.js');
Module._load = load;

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A device that takes every file: accept, done when it ends whole, files.done once the batch is in.
function receiver(client) {
  const got = new Map(); // id -> {batch, size, bytes, done}
  const count = new Map(); // batch -> files in it
  client.ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.t === T.FILE_OFFER) {
      got.set(m.id, { batch: m.batch, size: m.size, bytes: [], done: false });
      count.set(m.batch, m.count);
      client.send({ t: T.FILE_ACCEPT, id: m.id });
    } else if (m.t === T.FILE_CHUNK && got.has(m.id)) {
      got.get(m.id).bytes.push(Buffer.from(m.data, 'base64'));
    } else if (m.t === T.FILE_END && got.has(m.id)) {
      const f = got.get(m.id);
      f.done = Buffer.concat(f.bytes).length === f.size;
      client.send({ t: T.FILE_DONE, id: m.id, ok: f.done });
      const all = [...got.values()].filter((x) => x.batch === f.batch);
      if (all.length === count.get(f.batch) && all.every((x) => x.done)) client.send({ t: T.FILES_DONE, batch: f.batch, ok: true, files: all.length });
    }
  });
  return got;
}

test('a send goes on when the selection moves to another device mid-send', async () => {
  const A = await node('A');
  const clients = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendset-'));
  try {
    const settings = { files: { dragEdge: true, outboxHours: 24 } };
    const set = new SendSet({ hub: A.hub, server: A.server, FileSend, getSettings: () => settings });
    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p1.id) && set.byId.has(p2.id), 'a FileSend for each');
    const got = receiver(p1.client);
    const done = [];
    set.on('batchDone', (b) => done.push(b));

    const src = path.join(dir, 'photos');
    fs.mkdirSync(src);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(src, `p${i}.bin`), crypto.randomBytes(200000));
    assert.ok(A.hub.select(p1.id));
    assert.ok(set.sendBatch([src], 'send'), 'five files on their way to One');
    assert.ok(A.hub.select(p2.id), 'the selection moves to Two');
    await waitFor(() => done.length === 1, 'One has the batch', 20000);
    assert.strictEqual(done[0].ok, true);
    assert.strictEqual(done[0].to, p1.id, 'the batch says where it went');
    assert.strictEqual([...got.values()].filter((f) => f.done).length, 5, 'every file arrived whole');
    assert.ok(!p2.client.inbox.some((m) => m.t === T.FILE_OFFER), 'nothing went to Two');
    assert.deepStrictEqual(set.outbox.view, [], 'nothing kept as cut off');
    assert.strictEqual(set.view.sent[0].ok, true, 'Recent: sent');
    assert.strictEqual(set.selected, set.byId.get(p2.id), 'Send files now goes to Two');
  } finally {
    for (const c of clients) c.close();
    close(A);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

runTests(tests);
