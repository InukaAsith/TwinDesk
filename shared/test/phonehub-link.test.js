// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/phonehub-link.js: PhoneHub's link takes one phone at a time (the active one), keeps it while it has
// a call, tells the phone it leaves that the hub is off, and a phone that isn't its own leaving changes nothing.
// Run: node shared/test/phonehub-link.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { hubLink } = require('../phonehub-link.js');

const T = P.T;

// Every phone's link, faked: connected phones, the active one, and the messages each phone gets.
function fakePhones() {
  const phones = new EventEmitter();
  phones.conn = new Map();
  phones.activeId = null;
  phones.sent = [];
  Object.defineProperty(phones, 'current', { get: () => phones.conn.get(phones.activeId) || null });
  phones.come = (id) => {
    const ctx = { deviceId: id, name: id, os: P.OS.ANDROID };
    phones.conn.set(id, ctx);
    phones.emit('client', ctx);
  };
  phones.go = (id) => {
    const ctx = phones.conn.get(id);
    phones.emit('closed', ctx); // still listed while its 'closed' goes round
    phones.conn.delete(id);
  };
  phones.say = (id, msg) => phones.emit(`t:${msg.t}`, msg, phones.conn.get(id));
  return phones;
}

const phones = fakePhones();
let call = null;
const link = hubLink({
  phones, ctxOf: (id) => phones.conn.get(id) || null, sendTo: (id, m) => phones.sent.push([id, m]), held: () => !!call, log: () => {},
});
const life = [];
link.on('client', (c) => life.push('client ' + c.deviceId));
link.on('closed', (c) => life.push('closed ' + c.deviceId));
const heard = [];
link.on(`t:${T.CALL_STATE}`, (m, c) => heard.push(c.deviceId));

// A comes and is active: the hub's.
phones.activeId = 'A';
phones.come('A');
assert.strictEqual(link.id, 'A');
assert.deepStrictEqual(life, ['client A']);

// B comes, A stays active: only A is heard; sends go to A.
phones.come('B');
assert.strictEqual(link.id, 'A');
phones.say('B', { t: T.CALL_STATE });
phones.say('A', { t: T.CALL_STATE });
assert.deepStrictEqual(heard, ['A'], 'only its phone is heard');
link.sendToClient({ t: T.CALL_DO, a: 'answer' });
assert.deepStrictEqual(phones.sent.pop(), ['A', { t: T.CALL_DO, a: 'answer' }]);

// B leaving changes nothing (it used to stop the hub, A's call with it).
phones.go('B');
assert.strictEqual(link.id, 'A');
assert.deepStrictEqual(life, ['client A'], 'no closed for A');

// B back and active while A has a call: A keeps it until the call ends.
phones.come('B');
phones.activeId = 'B';
call = { state: 'offhook' };
link.refresh();
assert.strictEqual(link.id, 'A', 'held by the call');
call = null;
link.refresh();
assert.strictEqual(link.id, 'B', 'then the active phone');
assert.deepStrictEqual(life.slice(-2), ['closed A', 'client B']);
const bye = phones.sent.find(([id, m]) => id === 'A' && m.t === T.HUB_POLICY);
assert.ok(bye && bye[1].calls === false && bye[1].messages === false, 'A was told the hub is off here');

// B, its phone, leaves: closed, then A (still there, now active) takes it; B isn't picked while it goes.
phones.activeId = 'B';
phones.on('closed', () => { phones.activeId = 'A'; });
phones.go('B');
setImmediate(() => {
  assert.strictEqual(link.id, 'A');
  assert.deepStrictEqual(life.slice(-2), ['closed B', 'client A']);
  assert.ok(!phones.sent.some(([id, m]) => id === 'B' && m.t === T.HUB_POLICY && m.calls === false), 'a phone that left isn’t sent a goodbye');

  console.log('phonehub-link: ok');
});
