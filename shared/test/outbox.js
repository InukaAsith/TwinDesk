// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/outbox.js: files sent while away go to the device last connected when it's back (not to
// another one), paused ones wait for Resume, a cut-off batch's rest goes again with cont, files gone
// meanwhile are skipped, Keep files to send off keeps nothing, old ones are dropped, a restart keeps them.
// Run with: node shared/test/outbox.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Outbox } = require('../outbox.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-outbox-'));
const a = path.join(dir, 'a.txt');
const b = path.join(dir, 'b.txt');
fs.writeFileSync(a, 'a');
fs.writeFileSync(b, 'bb');
const file = path.join(dir, 'outbox.json');

let peer = null;
let hours = 24;
let now = 1e12;
const sent = [];
let accept = true;
const make = () => new Outbox({ file, hours: () => hours, peer: () => peer, now: () => now, send: (e) => { if (!accept) return false; sent.push(e); return true; } });

let o = make();
// Never connected: nothing to keep it for.
assert.strictEqual(o.add([a]), null);
// Never connected, but paired: kept for the paired one (just updated).
{
  const o2 = new Outbox({ hours: () => 24, peer: () => null, paired: () => ({ id: 'mac1', name: 'Studio Mac' }), now: () => now, send: () => true });
  assert.strictEqual(o2.add([a]), 'queued');
  assert.strictEqual(o2.view[0].peerName, 'Studio Mac');
}
// Connected: it simply goes.
peer = { id: 'pc1', name: 'Studio' };
o.connected();
assert.strictEqual(o.add([a]), 'sent');
assert.deepStrictEqual(sent.pop().paths, [a]);
// Away: kept for Studio.
peer = null;
assert.strictEqual(o.add([a, b]), 'queued');
assert.deepStrictEqual(o.view.map((e) => [e.state, e.files, e.peerName]), [['waiting', 2, 'Studio']]);
// Another device connects: not for it.
peer = { id: 'phone', name: 'Pixel' };
o.connected();
assert.strictEqual(sent.length, 0);
assert.strictEqual(o.view.length, 1);
// Studio is back: it goes, and a file deleted meanwhile is skipped.
fs.rmSync(b);
peer = { id: 'pc1', name: 'Studio' };
o.connected();
assert.strictEqual(sent.length, 1);
assert.deepStrictEqual(sent.pop().paths, [a]);
assert.strictEqual(o.view.length, 0);
fs.writeFileSync(b, 'bb');

// Paused: waits for Resume even while connected; the rest goes with cont.
const id = o.keep([{ path: a, rel: 'F/a.txt', size: 1 }, { path: b, rel: 'F/b.txt', size: 2 }], { why: 'paused', cont: 'batch1', name: 'F' });
o.flush();
assert.strictEqual(sent.length, 0);
assert.strictEqual(o.view[0].state, 'paused');
assert.ok(o.resume(id));
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].cont, 'batch1');
assert.deepStrictEqual(sent.pop().list.map((f) => f.rel), ['F/a.txt', 'F/b.txt']);

// Cut off: goes again on reconnect; the sender can't right now: it stays.
peer = null;
o.keep([{ path: a, rel: 'G/a.txt', size: 1 }], { why: 'cut', cont: 'batch2', peer: { id: 'pc1', name: 'Studio' } });
peer = { id: 'pc1', name: 'Studio' };
accept = false;
o.connected();
assert.strictEqual(o.view.length, 1);
accept = true;
// A restart keeps it.
o = make();
assert.strictEqual(o.view.length, 1);
assert.strictEqual(o.last.name, 'Studio');
o.connected();
assert.strictEqual(sent.pop().cont, 'batch2');
assert.strictEqual(o.view.length, 0);

// Too old: dropped.
peer = null;
o.add([a]);
now += 25 * 3600 * 1000;
assert.strictEqual(o.view.length, 0);
// Remove.
o.add([a]);
o.remove(o.view[0].id);
assert.strictEqual(o.view.length, 0);
// Keep files to send off: nothing kept (a pause still is: the user asked for it).
hours = 0;
assert.strictEqual(o.add([a]), null);
assert.strictEqual(o.keep([{ path: a, rel: 'a.txt', size: 1 }], { why: 'cut', cont: 'x' }), null);
assert.ok(o.keep([{ path: a, rel: 'a.txt', size: 1 }], { why: 'paused', cont: 'x' }));
assert.strictEqual(o.view.length, 1);
now += 8 * 86400000; // … for a week
assert.strictEqual(o.view.length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('outbox: ok');
