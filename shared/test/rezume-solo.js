// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/rezume-solo.js: ReZume in Multi-device only while one phone is the only device.
'use strict';
const assert = require('assert');
const { soloLink } = require('../rezume-solo.js');
const P = require('../protocol.js');

const handlers = new Map();
const peerFns = { welcome: [], closed: [] };
const conn = [];
const sent = [];
const sess = new Map();
const bus = {
  connectedIds: () => conn.slice(),
  onPeer: (ev, fn) => peerFns[ev].push(fn),
  on: (t, fn) => handlers.set(t, fn),
  send: (id, m) => sent.push([id, m]),
};
const add = (id, os) => { sess.set(id, { peerOs: os, name: id }); conn.push(id); peerFns.welcome.forEach((f) => f(id)); };
const drop = (id) => { conn.splice(conn.indexOf(id), 1); peerFns.closed.forEach((f) => f(id)); };

const solo = soloLink({ bus, sessions: sess });
let welcomed = 0;
let closed = 0;
solo.link.welcome(() => welcomed++);
solo.link.closed(() => closed++);
const got = [];
solo.link.on('rz.offer', (m) => got.push(m));

assert.strictEqual(solo.blocked(), '');
assert.strictEqual(solo.link.peer(), null);

add('ph', P.OS.ANDROID);
assert.strictEqual(solo.id(), 'ph');
assert.strictEqual(welcomed, 1);
assert.strictEqual(solo.link.peer().os, P.OS.ANDROID);
solo.link.send({ t: 'x' });
assert.deepStrictEqual(sent[0], ['ph', { t: 'x' }]);
handlers.get('rz.offer')({ a: 1 }, 'ph');
assert.strictEqual(got.length, 1);

// A computer joins: ReZume ends, the page says why.
add('mac', P.OS.MAC);
assert.strictEqual(solo.id(), null);
assert.strictEqual(closed, 1);
assert.strictEqual(solo.blocked(), 'many');
handlers.get('rz.offer')({ a: 2 }, 'ph');
assert.strictEqual(got.length, 1);
solo.link.send({ t: 'y' });
assert.strictEqual(sent.length, 1);

// It leaves: the phone is alone again.
drop('mac');
assert.strictEqual(welcomed, 2);
drop('ph');
assert.strictEqual(closed, 2);

// Only a computer: blocked as 'computer'.
add('pc', P.OS.WIN);
assert.strictEqual(solo.blocked(), 'computer');
assert.strictEqual(welcomed, 2);

// Multi-device with a partner (settings.rezume.with): computers A, B, C and a phone P, every link
// direct. A pick is mutual, and whoever either side was with before lets go.
{
  const nodes = new Map();
  const node = (id, os) => {
    const n = { id, os, handlers: new Map(), peerFns: { welcome: [], closed: [] }, conn: new Set(), saved: null, got: [], welcomed: 0, closed: 0 };
    n.bus = {
      connectedIds: () => [...n.conn],
      onPeer: (ev, fn) => n.peerFns[ev].push(fn),
      on: (t, fn) => { if (!n.handlers.has(t)) n.handlers.set(t, []); n.handlers.get(t).push(fn); },
      send: (to, m) => { const o = nodes.get(to); if (o && o.conn.has(id)) for (const fn of o.handlers.get(m.t) || []) fn(JSON.parse(JSON.stringify(m)), id); },
    };
    n.sessions = { get: (x) => (nodes.has(x) ? { peerOs: nodes.get(x).os, name: 'N' + x } : null) };
    nodes.set(id, n);
    if (os !== P.OS.ANDROID) {
      n.solo = soloLink({ bus: n.bus, sessions: n.sessions, partner: { get: () => n.saved, set: (v) => { n.saved = v; } } });
      n.solo.link.welcome(() => n.welcomed++);
      n.solo.link.closed(() => n.closed++);
      n.solo.link.on('rz.offer', (m) => n.got.push(m));
    }
    return n;
  };
  const link = (a, b) => { const x = nodes.get(a), y = nodes.get(b); x.conn.add(b); y.conn.add(a); x.peerFns.welcome.forEach((f) => f(b)); y.peerFns.welcome.forEach((f) => f(a)); };
  const unlink = (a, b) => { const x = nodes.get(a), y = nodes.get(b); x.conn.delete(b); y.conn.delete(a); x.peerFns.closed.forEach((f) => f(b)); y.peerFns.closed.forEach((f) => f(a)); };
  const A = node('A', P.OS.MAC), B = node('B', P.OS.WIN), C = node('C', P.OS.LINUX);
  node('P', P.OS.ANDROID);
  link('A', 'B'); link('A', 'C'); link('B', 'C'); link('A', 'P');

  assert.strictEqual(A.solo.blocked(), 'pick', 'several devices, none picked: pick one');
  assert.strictEqual(A.solo.id(), null);
  assert.deepStrictEqual(A.solo.view().devices.map((d) => d.id), ['B', 'C', 'P']);

  A.solo.choose('C');
  assert.strictEqual(A.saved.id, 'C');
  assert.strictEqual(C.saved.id, 'A', 'C follows: it is with A');
  assert.strictEqual(B.saved, null);
  assert.strictEqual(A.solo.id(), 'C');
  assert.strictEqual(C.solo.id(), 'A');
  assert.ok(A.welcomed === 1 && C.welcomed === 1);
  A.solo.link.send({ t: 'rz.offer', n: 1 });
  B.bus.send('C', { t: 'rz.offer', n: 2 }); // B isn't C's partner: ignored
  assert.deepStrictEqual(C.got.map((m) => m.n), [1]);

  // B picks C: C goes with B, and A lets go.
  B.solo.choose('C');
  assert.strictEqual(C.saved.id, 'B');
  assert.strictEqual(A.saved, null, 'A was told it is over');
  assert.strictEqual(A.solo.id(), null);
  assert.ok(A.closed === 1 && C.closed === 1 && C.welcomed === 2);

  // A picks the phone: only A's own choice.
  A.solo.choose('P');
  assert.strictEqual(A.solo.id(), 'P');
  assert.strictEqual(A.solo.link.peer().os, P.OS.ANDROID);
  assert.strictEqual(C.saved.id, 'B');

  // Picked while apart: the newer pick wins when they meet.
  unlink('B', 'C');
  assert.strictEqual(B.solo.id(), null);
  assert.strictEqual(B.saved.id, 'C', 'kept while C is away');
  assert.strictEqual(B.solo.blocked(), 'pick');
  A.solo.choose('C'); // A and C again (C lets B go, but B isn't connected to hear it)
  assert.strictEqual(C.saved.id, 'A');
  assert.strictEqual(B.saved.id, 'C');
  link('B', 'C'); // B says it picked C, but A's pick is newer: C says no, B lets go
  assert.strictEqual(C.saved.id, 'A');
  assert.strictEqual(B.saved, null);

  // None: both let go.
  A.solo.choose('');
  assert.strictEqual(A.saved, null);
  assert.strictEqual(C.saved, null);
  assert.strictEqual(C.solo.id(), null);
}

console.log('rezume-solo: ok');
