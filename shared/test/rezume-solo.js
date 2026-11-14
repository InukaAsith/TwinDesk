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

console.log('rezume-solo: ok');
