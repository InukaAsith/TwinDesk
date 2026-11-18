// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/clipqueue.js: copies made while a device is away go to its Recent when it's back.
'use strict';
const assert = require('assert');
const P = require('../protocol.js');
const { ClipQueue, MeshClipQueue, itemsOf } = require('../clipqueue.js');

(async () => {
  const q = new ClipQueue();
  assert.ok(q.add('a')); assert.ok(!q.add('a')); assert.ok(q.add('b')); assert.ok(q.add('a'));
  assert.deepStrictEqual(q.take().items.map((x) => x.text), ['b', 'a']);
  assert.strictEqual(q.take(), null);
  for (let i = 0; i < 70; i++) q.add('x' + i);
  assert.strictEqual(q.size, 50);
  assert.ok(!q.add('y'.repeat(300 * 1024)), 'over maxKB');
  assert.deepStrictEqual(itemsOf({ items: [{ text: 'ok', at: 1 }, { text: 5 }, null, { text: '' }] }).map((x) => x.text), ['ok']);

  // mesh
  let text = 'before';
  const connected = new Set(['A', 'B']);
  const sent = [];
  const writes = [];
  const history = [];
  const clip = {
    cfg: { enabled: true, send: true, receive: true, maxKB: 256 },
    bus: { connectedIds: () => [...connected], send: (id, m) => (sent.push([id, m]), true) },
    lastSync: { received: null }, onChange() {},
    _readText: async () => text,
    _remember: (dir, t, from, at) => history.push({ dir, t, from, at }),
    clipboard: { writeText: (t) => writes.push(t) },
  };
  const pairs = new Map([['A', {}], ['B', {}]]);
  const m = new MeshClipQueue(clip, {
    nameOf: (id) => 'dev-' + id, activePair: (id) => pairs.get(id),
    knownPair: (id, pair) => pairs.get(id) === pair,
  });
  m.destroy();
  m.welcome('A'); m.welcome('B');
  await m._look(); // nobody away
  connected.delete('B');
  await m._look(); // baseline
  text = 'one'; await m._look();
  text = 'two'; await m._look();
  assert.strictEqual(m.size, 2);
  m.policy('B', { accept: true }); // older: no queue
  assert.strictEqual(sent.length, 0);
  connected.add('B');
  m.policy('B', { accept: true, queue: true });
  assert.deepStrictEqual(sent.map(([id, x]) => [id, x.t, x.items.map((i) => i.text)]), [['B', P.T.CLIP_QUEUE, ['one', 'two']]]);
  assert.strictEqual(m.size, 0);
  // receiving
  await m.receive({ items: [{ text: 'r1', at: 5 }, { text: 'r2', at: 6 }] }, 'B');
  assert.deepStrictEqual(history.map((h) => [h.dir, h.t, h.from, h.at]), [['in', 'r1', 'dev-B', 5], ['in', 'r2', 'dev-B', 6]]);
  assert.deepStrictEqual(writes, []);
  clip.cfg.queueLatest = true;
  await m.receive({ items: [{ text: 'r3', at: 7 }] }, 'B');
  assert.deepStrictEqual(writes, ['r3']);
  connected.delete('B');
  await m._look();
  text = 'later sample'; await m._look();
  m.forget('B');
  pairs.set('B', {});
  connected.add('B');
  m.welcome('B');
  m.policy('B', { accept: true, queue: true });
  assert.strictEqual(sent.length, 1, 'a new pair with the same device id gets no prior copies');
  // queue off
  clip.cfg.queue = false; connected.delete('A');
  text = 'three'; await m._look(); text = 'four'; await m._look();
  assert.strictEqual(m.size, 0);
  console.log('clipqueue: ok');
})().catch((e) => { console.error(e); process.exit(1); });
