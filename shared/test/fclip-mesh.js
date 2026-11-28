// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/fclip-mesh.js on a FileClip shaped as windows|linux/fclip.js: where each message goes, whom
// each is taken from. (The whole copy and paste on real hubs: windows|linux/mesh/test/fclip-mesh.test.js.)
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const { meshFileClip } = require('../fclip-mesh.js');

const T = P.T;

// The platform FileClip's shape: its handlers on link, what it sends through link.send.
class FileClip {
  constructor(o) {
    Object.assign(this, o);
    this.offer = null;
    this.incoming = null;
    this.pasting = null;
    this.copySequence = 0;
    this.done = [];
    this.link.on(T.FCLIP_OFFER, (m) => { this.incoming = { id: m.id, files: 1 }; });
    this.link.on(T.FCLIP_GONE, (m) => { if (this.incoming && this.incoming.id === m.id) this.incoming = null; });
    this.link.on(T.FCLIP_PASTE, () => { throw new Error('the base answers no paste in Multi-device'); });
    this.link.on(T.FCLIP_KEY, (m) => this.done.push(m.action));
    this.link.on('closed', () => { throw new Error('the base hears no closed in Multi-device'); });
  }
  get connected() { return this.link.status.state === 'connected'; }
  shortcut(action) { this.link.send({ t: T.FCLIP_KEY, action }); }
  copy() { this.offer = { id: 'mine', paths: [] }; this.link.send({ t: T.FCLIP_OFFER, id: 'mine', items: [] }); }
  paste() { this.fileRecv.expectBatch(this.incoming.id); this.link.send({ t: T.FCLIP_PASTE, id: this.incoming.id }); }
}

function fakeHub(ids) {
  const handlers = new Map();
  const peer = new Map();
  const sent = [];
  const bus = {
    on: (t, fn) => handlers.set(t, [...(handlers.get(t) || []), fn]),
    onPeer: (e, fn) => peer.set(e, [...(peer.get(e) || []), fn]),
    send: (id, m) => { sent.push([id, m.t, m.id || m.action]); return true; },
    connectedIds: () => ids,
  };
  return {
    bus, sent, selectedId: ids[0], scoped: (id) => ({ id }),
    hear: (t, m, from) => { for (const fn of handlers.get(t) || []) fn(m, from); },
    leave: (id) => { ids.splice(ids.indexOf(id), 1); for (const fn of peer.get('closed') || []) fn(id); },
  };
}

const Mesh = meshFileClip(FileClip);
const hub = fakeHub(['A', 'B', 'C']);
const expected = [];
const files = { byId: new Map([['B', { fileRecv: { expectBatch: (id) => expected.push(['B', id]) } }]]) };
const clip = new Mesh({ hub, files, onChange() {}, makeSender: () => null });
assert.strictEqual(clip.connected, true);

// Our copy: offered to every device.
clip.copy();
assert.deepStrictEqual(hub.sent.splice(0), [['A', T.FCLIP_OFFER, 'mine'], ['B', T.FCLIP_OFFER, 'mine'], ['C', T.FCLIP_OFFER, 'mine']]);

// B's copy, then a paste: B is asked (not the selected A), and B's receivers expect the batch.
hub.hear(T.FCLIP_OFFER, { id: 'theirs', items: [] }, 'B');
assert.strictEqual(clip.incoming.from, 'B');
clip.paste();
assert.deepStrictEqual(hub.sent.splice(0), [['B', T.FCLIP_PASTE, 'theirs']]);
assert.deepStrictEqual(expected, [['B', 'theirs']]);

// "Gone" for that id from another device doesn't take B's copy away; from B it does.
hub.hear(T.FCLIP_GONE, { id: 'theirs' }, 'C');
assert.ok(clip.incoming, 'C can’t take B’s copy away');
hub.hear(T.FCLIP_GONE, { id: 'theirs' }, 'B');
assert.strictEqual(clip.incoming, null);

// The shortcut: ours goes to the device we drive; theirs only from the device driving us.
clip.kvm = { mode: 'driving', partner: 'C' };
clip.shortcut('copy');
assert.deepStrictEqual(hub.sent.splice(0), [['C', T.FCLIP_KEY, 'copy']]);
clip.kvm = { mode: 'driven', partner: 'B' };
hub.hear(T.FCLIP_KEY, { action: 'paste' }, 'C');
assert.deepStrictEqual(clip.done, [], 'C doesn’t drive us');
hub.hear(T.FCLIP_KEY, { action: 'paste' }, 'B');
assert.deepStrictEqual(clip.done, ['paste']);

// The device whose copy we'd paste leaves: forgotten. Ours stays until nobody is left.
hub.hear(T.FCLIP_OFFER, { id: 'again', items: [] }, 'C');
hub.leave('C');
assert.strictEqual(clip.incoming, null);
assert.ok(clip.offer, 'ours stays for A and B');
hub.leave('A');
hub.leave('B');
assert.strictEqual(clip.offer, null);
assert.strictEqual(clip.connected, false);

// The Mac's FileClip (mac/fclip.js): the same through `server` and `drop`, events for its changes.
{
  const { EventEmitter } = require('events');
  class MacFileClip extends EventEmitter {
    constructor({ server, drop, fileSend }) {
      super();
      Object.assign(this, { server, drop, fileSend });
      this.offer = null;
      this.incoming = null;
      this.copySequence = 0;
      this.batches = [];
      server.on(`t:${T.FCLIP_OFFER}`, (m) => { this.incoming = { id: m.id }; });
      server.on(`t:${T.FCLIP_PASTE}`, () => { throw new Error('the base answers no paste in Multi-device'); });
      server.on('closed', () => { throw new Error('the base hears no closed in Multi-device'); });
      drop.on('batch', (b) => this.batches.push(b));
    }
    get peerName() { return this.server.current ? this.server.current.name : 'the other computer'; }
    copy() { this.offer = { id: 'mac', paths: [__filename] }; this.server.sendToClient({ t: T.FCLIP_OFFER, id: 'mac', items: [] }); }
    paste() { this.drop.expectBatch(this.incoming.id); this.server.sendToClient({ t: T.FCLIP_PASTE, id: this.incoming.id }); }
  }
  const MacMesh = meshFileClip(MacFileClip, { mac: true });
  const mhub = fakeHub(['A', 'B']);
  mhub.sessions = { get: (id) => ({ displayName: () => 'PC-' + id }) };
  const drops = new EventEmitter();
  const got = [];
  drops.byId = new Map([['B', { expectBatch: (id) => got.push(['B', id]) }]]);
  const sent = [];
  const mclip = new MacMesh({ hub: mhub, files: drops, makeSender: (id) => ({ sendBatch: (paths, kind, batch) => { sent.push([id, kind, batch]); return true; } }) });
  assert.strictEqual(mclip.peerName, 'PC-A', 'the selected device, by name');
  mclip.copy();
  assert.deepStrictEqual(mhub.sent.splice(0).map((x) => x[0]), ['A', 'B'], 'offered to every device');
  mhub.hear(T.FCLIP_OFFER, { id: 'pc', items: [] }, 'B');
  mclip.paste();
  assert.deepStrictEqual(got, [['B', 'pc']], 'B’s Drop expects it');
  assert.deepStrictEqual(mhub.sent.splice(0), [['B', T.FCLIP_PASTE, 'pc']]);
  mhub.hear(T.FCLIP_PASTE, { id: 'mac' }, 'B');
  assert.deepStrictEqual(sent, [['B', 'paste', 'mac']], 'our copy goes to B through its own sender');
  drops.emit('batch', { kind: 'paste' });
  assert.strictEqual(mclip.batches.length, 1, 'the set’s batches reach it');
  let changed = 0;
  mclip.on('change', () => changed++);
  mhub.leave('B');
  assert.strictEqual(mclip.incoming, null);
  assert.strictEqual(changed, 1, 'its change event');
}

console.log('fclip-mesh: ok');
