// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/files-mesh.js: a FileRecv and a DragRecv per device; the single-receiver API routes to the
// device driving this computer (the pointer), the selected one (a paste we asked for) or all of them.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { FilesSet } = require('../files-mesh.js');

function fakeHub(ids) {
  const hub = new EventEmitter();
  hub.connected = ids;
  hub.selectedId = ids[0] || null;
  hub._connectedIds = () => hub.connected;
  hub.scoped = (id) => ({ id });
  return hub;
}

function unit(link) {
  const calls = [];
  const fileRecv = {
    link, last: null, receiving: 0,
    onRelease: async () => calls.push('release'),
    askedSends: (ms) => calls.push('asked ' + ms),
    expectBatch: (...a) => calls.push('expect ' + a.join(',')),
    view() { return { receiving: this.receiving, last: this.last }; },
  };
  const dragRecv = {
    link, last: null, dragging: false,
    onRelease: () => calls.push('drag release'),
    onHome: () => calls.push('home'),
    cancel: (why) => calls.push('cancel ' + why),
    startPaste: (p) => { calls.push('paste ' + p.batch); return true; },
    _pasteOf: (m) => m.batch === 'mine-' + link.id,
    view() { return this.dragging ? { state: 'dragging', name: 'a.txt', last: this.last } : { state: '', last: this.last }; },
  };
  return { fileRecv, dragRecv, calls };
}

(async () => {
  const hub = fakeHub(['A', 'B']);
  let partner = null;
  const set = new FilesSet({ hub, partner: () => partner, make: (link) => unit(link) });
  const A = set.byId.get('A');
  const B = set.byId.get('B');
  assert.strictEqual(A.fileRecv.link.id, 'A', 'each on its own scoped link');
  assert.strictEqual(B.dragRecv.link.id, 'B');

  // A device that comes later gets its own; one that comes back keeps its own.
  hub.emit('peerAdded', 'C');
  hub.emit('peerAdded', 'A');
  assert.strictEqual(set.byId.size, 3);
  assert.strictEqual(set.byId.get('A'), A);
  const C = set.byId.get('C');

  // A paste Windows copies itself skips filerecv.js: its own device's only.
  assert.strictEqual(B.fileRecv.claims({ batch: 'mine-B' }), true);
  assert.strictEqual(A.fileRecv.claims({ batch: 'mine-B' }), false);

  // The batch callbacks say which device it came from.
  const got = [];
  set.fileRecv.onBatch = (b) => got.push(['batch', b.from, b.files]);
  set.fileRecv.onBatchProgress = (b) => got.push(['progress', b.from]);
  set.dragRecv.onPasted = (b) => got.push(['pasted', b.from]);
  B.fileRecv.onBatch({ files: 2 });
  C.fileRecv.onBatchProgress({ got: 1 });
  A.dragRecv.onPasted({ batch: 'x' });
  assert.deepStrictEqual(got, [['batch', 'B', 2], ['progress', 'C'], ['pasted', 'A']]);

  // The pointer: the device driving us (B, not the selected A); nobody driving: every device.
  partner = 'B';
  await set.fileRecv.onRelease();
  set.dragRecv.onRelease();
  assert.deepStrictEqual(B.calls, ['release', 'drag release']);
  assert.deepStrictEqual(A.calls, []);
  partner = null;
  await set.fileRecv.onRelease();
  assert.ok(A.calls.includes('release') && C.calls.includes('release'));
  set.dragRecv.onHome();
  assert.ok([A, B, C].every((u) => u.calls.includes('home')), 'home: a drag of any device is cancelled');

  // Escape while a drag goes on: the dragging device's.
  C.dragRecv.dragging = true;
  assert.strictEqual(set.dragRecv.dragging, true);
  assert.deepStrictEqual(set.dragRecv.view().state, 'dragging', 'the drag going on');
  set.dragRecv.cancel('cancelled');
  assert.ok(C.calls.includes('cancel cancelled') && !A.calls.includes('cancel cancelled'));
  C.dragRecv.dragging = false;

  // A paste we asked for: the selected device's (fileclip.js asked it). The phone's Save: every device.
  set.fileRecv.expectBatch('p1', '/tmp', 5, false);
  assert.strictEqual(set.dragRecv.startPaste({ batch: 'p2' }), true);
  assert.ok(A.calls.includes('expect p1,/tmp,5,false') && A.calls.includes('paste p2'));
  assert.ok(!B.calls.some((c) => c.startsWith('expect')));
  set.fileRecv.askedSends(1000);
  assert.ok([A, B, C].every((u) => u.calls.includes('asked 1000')));
  hub.selectedId = null;
  assert.strictEqual(set.dragRecv.startPaste({ batch: 'p3' }), false, 'nobody selected');

  // The Files tab: the newest result of any device, the files of all; clearing clears all.
  A.fileRecv.last = { text: 'old', at: 1 };
  C.fileRecv.last = { text: 'new', at: 2 };
  B.fileRecv.receiving = 3;
  C.fileRecv.receiving = 1;
  assert.deepStrictEqual(set.fileRecv.view(), { receiving: 4, last: { text: 'new', at: 2 } });
  set.fileRecv.last = null;
  assert.strictEqual(set.fileRecv.last, null);
  B.dragRecv.last = { text: 'dropped', at: 5 };
  assert.deepStrictEqual(set.dragRecv.view(), { state: '', last: { text: 'dropped', at: 5 } });

  console.log('files-mesh: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
