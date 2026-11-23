// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/filedrop-mesh.js: a FileDrop per device, one outbox for them all (each entry for its own
// device), and the single fileDrop API: Send files to the selected device, a drag to the one crossed to.
// (A crossing mid-send on real hubs: windows|linux/mesh/test/filedrop-mesh.test.js.)
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { FileDropSet } = require('../filedrop-mesh.js');

function fakeHub(ids) {
  const hub = new EventEmitter();
  const connected = new Set(ids);
  hub.selectedId = ids[0];
  hub.sessions = { get: (id) => (['A', 'B', 'C'].includes(id) ? { connected: connected.has(id), displayName: () => 'PC-' + id } : null) };
  hub._connectedIds = () => [...connected];
  hub.scoped = (id) => ({ id });
  hub.connect = (id) => { connected.add(id); hub.emit('peerAdded', id); };
  hub.leave = (id) => connected.delete(id);
  return hub;
}

// A FileDrop as the set uses it: what it was asked to send, its outbox as given.
class FakeDrop {
  constructor({ link, outbox }) {
    Object.assign(this, { link, outbox, sent: [], batches: new Map(), calls: [], last: null });
    this.outbox.on('change', () => {});
  }
  send(paths) { return this.outbox.add(paths); }
  sendBatch(paths, kind) { this.sent.push([kind, paths.join()]); return { files: paths.length }; }
  sendList(list, kind, batch, o) { this.sent.push([kind, list.map((f) => f.path).join(), o.cont]); return { files: list.length }; }
  prepareDrag(paths) { this.calls.push('prepare'); return { drag: 'd', paths }; }
  beginDrag() { this.calls.push('begin'); }
  cancelRelease() { this.calls.push('cancelRelease'); }
  pause(batch) { this.calls.push('pause ' + batch); return true; }
  cancel() { this.calls.push('cancel'); }
  view() { return { current: this.sending ? { name: this.sending } : null, batch: null, queued: this.sent.length }; }
  plan(paths) { return { items: paths }; }
}

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const hub = fakeHub(['A', 'B']);
  const set = new FileDropSet({ hub, FileDrop: FakeDrop, settings: { files: { outboxHours: 24 } }, make: (link, id, outbox) => new FakeDrop({ link, outbox }) });
  await tick();
  const A = set.byId.get('A');
  const B = set.byId.get('B');
  assert.strictEqual(A.link.id, 'A', 'each on its own scoped link');
  assert.deepStrictEqual(A.peer(), { id: 'A', name: 'PC-A' }, 'whom its batches are for');

  // Send files: the selected device, now.
  assert.strictEqual(set.send(['/x/a.txt']), 'sent');
  assert.deepStrictEqual(A.sent, [['send', '/x/a.txt']]);
  assert.deepStrictEqual(B.sent, []);

  // A paused batch of B's is kept for B; resumed while A is selected, it goes to B, not A.
  B.outbox.keep([{ path: __filename, rel: 'f.js', size: 1 }], { why: 'paused', cont: 'b1', name: 'f.js' });
  const kept = set.outbox.view[0];
  assert.strictEqual(kept.peerName, 'PC-B');
  assert.ok(set.resume(kept.id));
  assert.deepStrictEqual(B.sent, [['send', __filename, 'b1']], 'B gets the rest, with cont');
  assert.strictEqual(A.sent.length, 1);

  // Cut off while C was away: kept for C, sent when C comes, through C's own FileDrop.
  set.outbox.keep([{ path: __filename, rel: 'f.js', size: 1 }], { why: 'cut', cont: 'c1', name: 'f.js', peer: { id: 'C', name: 'PC-C' } });
  hub.connect('C');
  await tick();
  const C = set.byId.get('C');
  assert.deepStrictEqual(C.sent, [['send', __filename, 'c1']], 'C gets what waited for it');
  assert.deepStrictEqual(set.outbox.view, []);

  // A drag: the device kvm.js selected before prepareDrag; going home cancels that one.
  hub.selectedId = 'B';
  assert.ok(set.prepareDrag(['/x']));
  set.beginDrag({});
  hub.selectedId = 'A';
  set.cancelRelease();
  assert.deepStrictEqual(B.calls, ['prepare', 'begin', 'cancelRelease']);
  assert.ok(!A.calls.includes('cancelRelease'));

  // Pause: the device sending that batch.
  C.batches.set('cb', {});
  assert.ok(set.pause('cb'));
  assert.ok(C.calls.includes('pause cb') && !A.calls.some((c) => c.startsWith('pause')));

  // The Files page: the selected device's send first, else any; the newest result of any.
  B.sending = 'big.iso';
  assert.strictEqual(set.view().current.name, 'big.iso', 'B sends, A (selected) doesn’t');
  A.sending = 'note.txt';
  assert.strictEqual(set.view().current.name, 'note.txt', 'the selected device’s first');
  A.last = { text: 'old', at: 1 };
  C.last = { text: 'new', at: 2 };
  assert.strictEqual(set.view().last.text, 'new');
  set.last = null;
  assert.strictEqual(set.last, null);

  // Nothing selected and nobody connected: Send files waits for the device last connected.
  hub.selectedId = null;
  for (const id of ['A', 'B', 'C']) hub.leave(id);
  assert.strictEqual(set.send([__filename]), 'queued');
  assert.strictEqual(set.outbox.view[0].peerName, set.outbox.last.name);
  assert.strictEqual(set.plan(['p']).items[0], 'p', 'plan() needs no device');

  // A batch's progress says the device it goes to.
  const prog = [];
  set.onBatchProgress = (b) => prog.push(b.to);
  B.onBatchProgress({ sent: 1 });
  assert.deepStrictEqual(prog, ['B']);

  console.log('filedrop-mesh: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
