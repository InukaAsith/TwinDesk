// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/usbadb.js with a helper that watches (the Mac's usbWatch): present() answers from its word,
// a change is heard at once, and without a helper (or after it exits) the system is asked again.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const usbadb = require('../usbadb.js');

(async () => {
  const helper = new EventEmitter();
  helper.proc = {};
  let present = true;
  helper.request = async (cmd) => {
    assert.strictEqual(cmd, 'usbWatch');
    return { present };
  };
  const changes = [];
  usbadb.on('change', (v) => changes.push(v));
  usbadb.watch(helper);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(await usbadb.present(), true, 'the helper says plugged in');
  helper.emit('event', 'usbAdb', { present: false });
  assert.strictEqual(await usbadb.present(), false, 'unplugged: no process asked (checked just now)');
  helper.emit('event', 'usbAdb', { present: true });
  assert.strictEqual(await usbadb.present(), true);
  assert.deepStrictEqual(changes, [true, false, true]);

  // An older helper (usbWatch unknown): the system is asked, as before.
  helper.emit('exit');
  helper.request = async () => { throw new Error('unknown cmd usbWatch'); };
  helper.emit('ready');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(typeof (await usbadb.present()), 'boolean');
  console.log('usbadb: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
