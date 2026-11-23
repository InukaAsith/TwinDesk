// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/mesh/dropset.js on a real hub: a Drop per device, each hearing only its device and answering it,
// while another one is selected; the single `drop` API routes the pointer to the device driving us.
// Run with: node mac/mesh/test/dropset.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { DropSet } = require('../dropset.js');
const { node, close, waitFor, pairPhone, helloPhone } = require('./lib/mesh.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A Drop as ../drop.js is to the set: it takes an offer and answers on its own peer.
function fakeDrop(peer) {
  const d = new EventEmitter();
  Object.assign(d, { peer, recent: [], calls: [], offers: [] });
  d.dragIn = { onDriven: () => d.calls.push('driven'), cancel: () => d.calls.push('drag cancel'), dragging: false };
  d.armDrag = () => d.calls.push('arm');
  d.release = async () => d.calls.push('release');
  d.cancelDrag = () => d.calls.push('cancel');
  d.expectBatch = (b) => d.calls.push('expect ' + b);
  d.reveal = (i) => d.calls.push('reveal ' + d.recent[i].name);
  d.view = { receiving: [], receivingMore: 0, inBatches: [], recent: d.recent, defaultFolder: '/Downloads' };
  peer.on(`t:${T.FILE_OFFER}`, (m) => {
    d.offers.push(m.id);
    d.recent.unshift({ name: m.name, at: Date.now() });
    peer.sendToClient({ t: T.FILE_ACCEPT, id: m.id });
    d.emit('batch', { kind: 'send', files: 1 });
  });
  return d;
}

test('a file from the device that isn’t selected reaches its own Drop, and the answer goes to it', async () => {
  const A = await node('A');
  const clients = [];
  try {
    let partner = null;
    const set = new DropSet({ hub: A.hub, server: A.server, make: fakeDrop, partner: () => partner });
    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p1.id) && set.byId.has(p2.id), 'a Drop for each');
    assert.ok(A.hub.select(p1.id));
    const batches = [];
    set.on('batch', (b) => batches.push(b));

    p2.client.send({ t: T.FILE_OFFER, id: 'f2', name: 'two.txt', size: 3, drop: 'send', batch: 'b2', count: 1 });
    const ok = await p2.client.until((m) => m.t === T.FILE_ACCEPT && m.id === 'f2');
    assert.ok(ok, 'Two hears its file taken');
    assert.deepStrictEqual(set.byId.get(p2.id).offers, ['f2']);
    assert.deepStrictEqual(set.byId.get(p1.id).offers, [], 'One’s Drop heard nothing');
    assert.ok(!p1.client.inbox.some((m) => m.t === T.FILE_ACCEPT), 'nothing went to the selected device');
    assert.deepStrictEqual(batches.map((b) => b.from), [p2.id], 'the batch says where it came from');

    // Recent is one list for every device; reveal finds the item through any Drop.
    assert.deepStrictEqual(set.view.recent.map((r) => r.name), ['two.txt']);
    set.reveal(0);
    assert.ok(set.units.some((d) => d.calls.includes('reveal two.txt')));
    set.clearRecent();
    assert.deepStrictEqual(set.byId.get(p2.id).recent, [], 'cleared for every Drop');

    // The pointer: the device driving us; a paste we asked for: the selected device.
    partner = p2.id;
    set.armDrag();
    await set.release();
    set.dragIn.onDriven();
    assert.deepStrictEqual(set.byId.get(p2.id).calls.filter((c) => !c.startsWith('reveal')), ['arm', 'release', 'driven']);
    assert.deepStrictEqual(set.byId.get(p1.id).calls.filter((c) => !c.startsWith('reveal')), []);
    set.expectBatch('paste-1');
    assert.ok(set.byId.get(p1.id).calls.includes('expect paste-1'));
    set.dragIn.isDriven = () => true;
    assert.strictEqual(set.isDriven(), true, 'kvm.js sets it on the set, every Drop asks it');
  } finally {
    for (const c of clients) c.close();
    close(A);
  }
});

runTests(tests);
