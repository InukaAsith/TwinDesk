// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/locksync.js (#322): a lock here tells the others when the switch is on; a lock told by another
// one locks here only with the switch on, and isn't passed back; logind's LockedHint on Linux.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { LockSync, QUIET_MS, escapePath } = require('../locksync.js');

let t = 1000000;
const make = (on = true) => {
  const sent = [];
  const locked = [];
  const pm = new EventEmitter();
  const ls = new LockSync({ platform: 'mac', enabled: () => on, send: (m) => sent.push(m), log: () => {}, now: () => t, powerMonitor: pm, lockNow: async () => locked.push(t) }).start();
  return { ls, sent, locked, pm, set: (v) => { on = v; } };
};

(async () => {
  // This computer locks: the others are told once (two events for one lock count once).
  const a = make(true);
  a.pm.emit('lock-screen');
  a.pm.emit('lock-screen');
  assert.deepStrictEqual(a.sent, [{ t: 'lock.now' }]);
  // Off: nothing told.
  const off = make(false);
  off.pm.emit('lock-screen');
  assert.deepStrictEqual(off.sent, []);

  // Another computer locked: this one locks, and its own lock event that follows isn't passed back.
  const b = make(true);
  b.ls.onMessage('nitro');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(b.locked.length, 1);
  t += 1000;
  b.pm.emit('lock-screen');
  assert.deepStrictEqual(b.sent, [], 'no loop');
  t += QUIET_MS + 5000;
  b.pm.emit('lock-screen'); // later, locked by its person
  assert.deepStrictEqual(b.sent, [{ t: 'lock.now' }]);
  // The switch off here: told, but doesn't lock.
  const c = make(false);
  c.ls.onMessage('nitro');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(c.locked.length, 0);

  // Linux: logind's LockedHint for this session.
  assert.strictEqual(escapePath('2'), '_32');
  assert.strictEqual(escapePath('c1'), 'c1');
  assert.strictEqual(escapePath('12'), '_312');
  const out = new EventEmitter();
  let args = null;
  const sent = [];
  const ls = new LockSync({ platform: 'linux', enabled: () => true, send: (m) => sent.push(m), log: () => {}, now: () => (t += 10000), powerMonitor: new EventEmitter(), env: { XDG_SESSION_ID: '2' },
    spawn: (cmd, a) => { args = [cmd, ...a]; const p = new EventEmitter(); p.stdout = out; p.kill = () => {}; return p; } }).start();
  assert.deepStrictEqual(args, ['gdbus', 'monitor', '--system', '--dest', 'org.freedesktop.login1', '--object-path', '/org/freedesktop/login1/session/_32']);
  out.emit('data', "/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <false>}, @as [])\n");
  assert.deepStrictEqual(sent, [], 'unlocked: nothing');
  out.emit('data', "/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <tr");
  out.emit('data', "ue>}, @as [])\n");
  assert.deepStrictEqual(sent, [{ t: 'lock.now' }], 'locked, even across two reads');
  ls.stop();
  console.log('locksync: ok');
})().catch((e) => { console.error(e); process.exit(1); });
