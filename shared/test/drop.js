// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/drop.js, the Drop room over a small mesh: computers A–B–C in a line (A and C not linked), phone
// P on A, phone Q on C. A message reaches everyone once; one to Q only isn't shown to P (nor sent to it),
// though A and B pass it on; a computer that was away catches up with drop.hi; the order is the same
// everywhere; delete for everyone works only for the sender; delete for me stays here; a blocked device
// isn't shown; a phone can't speak for another device; files up to MAX_FILE travel with the message.
// Run: node shared/test/drop.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DropRoom, T, MAX_FILE } = require('../drop.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drop-'));
const links = new Map(); // id -> Set of ids
const up = new Set(); // ids online
const leaf = new Set(['P', 'Q']);
const rooms = {};
const queue = [];
let clock = 1000;
const sent = []; // [from, to, type]

function make(id) {
  const s = { drop: { on: true } };
  const r = new DropRoom({
    selfId: id, name: 'Dev ' + id, os: leaf.has(id) ? 'android' : 'mac', dir: path.join(base, id), settings: () => s, save: () => {},
    neighbors: () => [...(links.get(id) || [])].filter((x) => up.has(x)),
    send: (to, m) => { sent.push([id, to, m.t]); queue.push([to, JSON.parse(JSON.stringify(m)), id]); return true; },
    isLeaf: (x) => leaf.has(x),
    members: () => [...up].filter((x) => x !== id).map((x) => ({ id: x, name: 'Dev ' + x, online: true })),
    now: () => (clock += 10),
  });
  r.news = [];
  r.onNew = (it) => r.news.push(it);
  rooms[id] = r;
  return r;
}
const link = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) { if (!links.has(x)) links.set(x, new Set()); links.get(x).add(y); } };
function run() {
  for (let n = 0; queue.length && n < 10000; n += 1) {
    const [to, m, from] = queue.shift();
    if (!up.has(to) || !up.has(from)) continue;
    rooms[to].heard(m.t, m, from);
  }
}
function connect(id) {
  up.add(id);
  for (const n of links.get(id) || []) if (up.has(n)) { rooms[id].up(n); rooms[n].up(id); }
  run();
}
const texts = (id) => rooms[id].view().items.map((x) => x.text || (x.file && x.file.name));

for (const id of ['A', 'B', 'C', 'P', 'Q']) make(id);
link('A', 'B'); link('B', 'C'); link('A', 'P'); link('C', 'Q');
for (const id of ['A', 'B', 'C', 'P', 'Q']) up.add(id);

// Everyone, once each.
sent.length = 0;
assert.ok(rooms.P.post({ text: 'hello all' }).ok);
run();
for (const id of ['A', 'B', 'C', 'P', 'Q']) assert.deepStrictEqual(texts(id), ['hello all'], id);
assert.strictEqual(sent.filter((s) => s[2] === T.MSG).length, 4, 'one hop per link');
assert.strictEqual(rooms.Q.unread(), 1);
assert.strictEqual(rooms.P.unread(), 0, 'my own message is read');
assert.strictEqual(rooms.Q.news.length, 1);

// To Q only: A, B and C pass it on, P never gets it, only Q and P... no: only the sender and Q show it.
sent.length = 0;
rooms.A.post({ to: 'Q', text: 'just Q' });
run();
assert.deepStrictEqual(texts('Q'), ['hello all', 'just Q']);
assert.deepStrictEqual(texts('A'), ['hello all', 'just Q']);
assert.deepStrictEqual(texts('B'), ['hello all'], 'B relays but does not show it');
assert.deepStrictEqual(texts('P'), ['hello all']);
assert.ok(!sent.some((s) => s[1] === 'P'), 'never sent to P');
assert.ok(rooms.B.byId.has(rooms.A.view().items[1].id), 'B keeps it for catch-up');

// C goes away; B and Q talk... Q is behind C, so B talks alone. C comes back and catches up.
up.delete('C'); up.delete('Q');
rooms.B.post({ text: 'while C was away' });
rooms.P.post({ text: 'me too' });
run();
assert.deepStrictEqual(texts('A'), ['hello all', 'just Q', 'while C was away', 'me too']);
connect('C');
assert.deepStrictEqual(texts('C'), ['hello all', 'while C was away', 'me too']);
connect('Q');
assert.deepStrictEqual(texts('Q'), ['hello all', 'just Q', 'while C was away', 'me too']);
assert.strictEqual(rooms.Q.unread(), 4);
rooms.Q.read();
assert.strictEqual(rooms.Q.unread(), 0);

// Same order everywhere even with clocks out of step: by sender time, then id.
const ids = (id) => rooms[id].view().items.filter((x) => x.to === '*').map((x) => x.id);
assert.deepStrictEqual(ids('A'), ids('Q'));
assert.deepStrictEqual(ids('C'), ids('P'));

// Delete for everyone: only the sender's own.
const mine = rooms.P.view().items.find((x) => x.text === 'me too');
assert.strictEqual(rooms.A.del(mine.id, true), false, 'not A’s to delete for everyone');
assert.ok(rooms.P.del(mine.id, true));
run();
for (const id of ['A', 'B', 'C', 'P', 'Q']) assert.ok(!texts(id).includes('me too'), id);
// A tombstone reaches a device that was away.
up.delete('Q');
const gone = rooms.B.view().items.find((x) => x.text === 'while C was away');
rooms.B.del(gone.id, true);
run();
connect('Q');
assert.ok(!texts('Q').includes('while C was away'), 'tombstone caught up');

// Delete for me: hidden here only, not sent back by others on the next hi.
const hi = rooms.C.view().items.find((x) => x.text === 'hello all');
rooms.C.del(hi.id, false);
up.delete('C'); up.delete('Q'); connect('C');
assert.ok(!texts('C').includes('hello all'));
assert.ok(texts('B').includes('hello all'));

// A phone can't post as someone else.
const before = texts('A').length;
rooms.A.heard(T.MSG, { item: { id: 'forged-0000001', from: 'B', name: 'B', at: clock, to: '*', text: 'forged' } }, 'P');
assert.strictEqual(texts('A').length, before);

// Blocked: not shown, not announced, still passed on.
rooms.Q.block('P', true, 'Dev P');
up.add('Q'); connect('Q');
const newsBefore = rooms.Q.news.length;
rooms.P.post({ text: 'from P again' });
run();
assert.ok(!texts('Q').includes('from P again'));
assert.strictEqual(rooms.Q.news.length, newsBefore);
assert.ok(texts('C').includes('from P again'));
rooms.Q.block('P', false);
assert.ok(texts('Q').includes('from P again'));

// Files travel with the message; too big ones are refused.
const f = path.join(base, 'cat.png');
fs.writeFileSync(f, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
const r = rooms.Q.post({ file: { path: f } });
assert.ok(r.ok);
run();
const got = rooms.P.view().items.find((x) => x.id === r.id);
assert.strictEqual(got.file.name, 'cat.png');
assert.ok(got.file.image);
assert.deepStrictEqual(fs.readFileSync(rooms.P.filePath(r.id)), fs.readFileSync(f));
const big = path.join(base, 'big.bin');
fs.writeFileSync(big, Buffer.alloc(MAX_FILE + 1));
assert.strictEqual(rooms.Q.post({ file: { path: big } }).why, 'big');
// A file's bytes that don't match its size: refused.
rooms.A.heard(T.MSG, { item: { id: 'badfile-000001', from: 'B', name: 'B', at: clock, to: '*', file: { name: 'x', size: 99, data: 'AAAA' } } }, 'B');
assert.ok(!rooms.A.byId.has('badfile-000001'));

// Kept after a restart; capped.
rooms.A.flush();
const again = new DropRoom({ selfId: 'A', name: 'Dev A', dir: path.join(base, 'A'), settings: () => ({ drop: { on: true } }), save: () => {} });
assert.deepStrictEqual(again.view().items.map((x) => x.id), rooms.A.view().items.map((x) => x.id));
const small = new DropRoom({ selfId: 'Z', name: 'Z', dir: path.join(base, 'Z'), settings: () => ({ drop: { on: true } }), save: () => {}, keep: 3, now: () => (clock += 10) });
for (let i = 0; i < 5; i += 1) small.post({ text: 'n' + i });
assert.deepStrictEqual(small.view().items.map((x) => x.text), ['n2', 'n3', 'n4']);

// A phone hears who it can send to: its computer first, not itself.
sent.length = 0;
rooms.A.up('P');
const who = queue.filter((q) => q[0] === 'P' && q[1].t === T.WHO).pop();
assert.ok(who, 'drop.who to the phone');
assert.strictEqual(who[1].members[0].id, 'A');
assert.ok(!who[1].members.some((d) => d.id === 'P'));
run();

// Off (a new install): nothing heard, nothing sent.
const offS = { drop: {} };
const off = new DropRoom({ selfId: 'O', name: 'O', dir: path.join(base, 'O'), settings: () => offS, save: () => {}, neighbors: () => ['A'], send: () => { throw new Error('sent while off'); } });
off.up('A');
off.heard(T.MSG, { item: { id: 'whileoff-00001', from: 'A', at: 5, to: '*', text: 'x' } }, 'A');
assert.strictEqual(off.post({ text: 'x' }).why, 'off');
assert.deepStrictEqual(off.view().items, []);

fs.rmSync(base, { recursive: true, force: true });
console.log('drop: ok');
