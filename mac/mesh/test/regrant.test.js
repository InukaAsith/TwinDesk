// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An introduction again for a pair that is already linked: this Mac, the host, makes a new token each
// time; the guest's earlier ones (the last two) still let it in, so a grant lost on its way doesn't lock
// it out (it said BAD_TOKEN and the guest forgot this Mac for good: 'via Ryzen9' on nitro, 2026-11-23).
// The guest side (links.addGrant keeps the new token) is in autojoin.test.js.
// Run with: node mac/mesh/test/regrant.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { Pairing } = require('../pairing.js');

function memoryStorage() {
  const files = new Map();
  return { read: (n, d) => (files.has(n) ? JSON.parse(files.get(n)) : d), write: (n, o) => files.set(n, JSON.stringify(o)), remove: (n) => files.delete(n) };
}

const server = new EventEmitter();
server.failed = [];
server.authed = [];
server.fail = (ctx, code) => server.failed.push(code);
server.authenticate = (ctx, who) => server.authed.push(who.deviceId);
server.closeDevice = () => {};
const pairing = new Pairing(server, { macId: 'mac-1', macName: 'Mac', fp: 'ab'.repeat(32) }, { storage: memoryStorage() });
const hello = (token) => server.emit('preauth', {}, { t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: 'guest-1', name: 'Guest', os: P.OS.LINUX, token });
const grant = () => pairing.grantFor({ id: 'guest-1', name: 'Guest', os: P.OS.LINUX }).token;

const t1 = grant(), t2 = grant(), t3 = grant(), t4 = grant();
for (const t of [t2, t3, t4]) hello(t);
assert.strictEqual(server.authed.length, 3, 'the new token and the two before it');
hello(t1);
assert.deepStrictEqual(server.failed, [P.E.BAD_TOKEN], 'three grants old');
pairing.forget('guest-1');
hello(t4);
assert.strictEqual(server.failed.length, 2, 'forgotten: none of them');
console.log('regrant: all passed');
