// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/appinfo.js: the other side's TwinDesk version against this one.
'use strict';

const assert = require('assert');
const A = require('../appinfo.js');

assert.ok(A.compare('2.5.0-beta.1', '2.5.0') < 0, 'a pre-release is before its release');
assert.ok(A.compare('2.5.0-beta.2', '2.5.0-beta.10') < 0, 'numeric pre-release parts compare as numbers');
assert.ok(A.compare('2.4.9', '2.5.0-beta.1') < 0);
assert.ok(A.compare('2.5.1', '2.5.0') > 0);
assert.strictEqual(A.compare('2.5.0', '2.5.0'), 0);
assert.ok(A.compare('junk', '2.5.0') < 0, 'unparsable sorts first');

assert.strictEqual(A.clean(null), null);
assert.deepStrictEqual(A.clean({ v: '2.5.0', f: ['lane', 3, 'x'.repeat(60)] }), { v: '2.5.0', f: ['lane', 'x'.repeat(40)] });
assert.deepStrictEqual(A.clean({ v: 'nope' }), { v: '', f: null });

const all = ['lane', 'fastFiles', 'h265', 'chats'];
// An app from before the check says nothing: older, no features listed (we can't tell which).
assert.deepStrictEqual(A.check('2.5.0', null, { features: all }), { version: '', older: true, newer: false, missing: [] });
// Same version, all features.
assert.deepStrictEqual(A.check('2.5.0', { v: '2.5.0', f: all }, { features: all }), { version: '2.5.0', older: false, newer: false, missing: [] });
// Older, without H.265.
assert.deepStrictEqual(A.check('2.6.0', { v: '2.5.0', f: ['lane', 'fastFiles', 'chats'] }, { features: all }).missing, ['h265']);
// A phone: the version only.
assert.deepStrictEqual(A.check('2.5.0', { v: '2.4.0', f: null }, { phone: true, features: all }), { version: '2.4.0', older: true, newer: false, missing: [] });
assert.strictEqual(A.check('2.5.0-beta.1', { v: '2.5.0', f: all }, { features: all }).newer, true);

process.env.TWINDESK_NO_H265 = '1';
assert.ok(!A.mine().includes('h265'), 'H.265 off: not listed');
delete process.env.TWINDESK_NO_H265;
assert.ok(A.mine().includes('h265'));

// DevCtl: sends its app, keeps the other's, tells once when it's older.
const { EventEmitter } = require('events');
const { DevCtl } = require('../devctl.js');
const link = new EventEmitter();
const sent = [];
link.send = (m) => sent.push(m);
link.current = { deviceId: 'pc1', name: 'PC', os: 'win' };
const local = { can: () => ({ ring: true }), state: async () => ({ ringing: false }), stop() {}, do: async () => {} };
const d = new DevCtl({ link, local, version: '2.5.0' });
const told = [];
d.on('outdated', (o) => told.push(o));
(async () => {
  link.emit('welcome');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sent[0].app, { v: '2.5.0', f: A.mine() }, 'dev.state carries this app');
  link.emit('dev.state', { can: {}, app: { v: '2.4.1', f: ['lane'] } });
  assert.strictEqual(told.length, 1);
  assert.strictEqual(told[0].version, '2.4.1');
  assert.strictEqual(d.view.appCheck.older, true);
  link.emit('closed');
  link.emit('welcome');
  link.emit('dev.state', { can: {}, app: { v: '2.4.1', f: ['lane'] } });
  assert.strictEqual(told.length, 1, 'once per device and version while the app runs');
  d.stop();
  console.log('appinfo: passed');
})().catch((e) => { console.error(e); process.exit(1); });
