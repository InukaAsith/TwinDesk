// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// BleHost: BlueZ refusing an advertisement is tried again (10 s, 30 s, 90 s, … up to 5 min), not with
// the radio off or missing, and not once advertising was switched off meanwhile.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');

const timers = [];
const realSet = global.setTimeout;
global.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const { BleHost } = require('../blepipe.js');

const tick = () => new Promise((r) => setImmediate(r));

function host(answers) {
  const helper = new EventEmitter();
  helper.running = true;
  helper.calls = [];
  helper.request = (cmd) => {
    helper.calls.push(cmd);
    if (cmd !== 'bleStart') return Promise.resolve({});
    const a = answers.shift();
    return a ? Promise.reject(new Error(a)) : Promise.resolve({});
  };
  let on = true;
  const ble = new BleHost({ helper, server: new EventEmitter(), info: () => ({ name: 'pc' }), enabled: () => on });
  return { helper, ble, off() { on = false; ble.apply(); } };
}

(async () => {
  const log = console.log;
  console.log = () => {};
  try {
    // Refused three times, then works: 10 s, 30 s, 90 s apart.
    let { helper } = host(['Failed to register advertisement', 'Failed to register advertisement', 'Failed to register advertisement']);
    const waits = [];
    for (let i = 0; i < 3; i++) {
      await tick();
      assert.strictEqual(timers.length, 1, `a retry is scheduled after failure ${i + 1}`);
      const t = timers.shift();
      waits.push(t.ms);
      t.fn();
    }
    await tick();
    assert.deepStrictEqual(waits, [10000, 30000, 90000]);
    assert.strictEqual(helper.calls.filter((c) => c === 'bleStart').length, 4);
    assert.strictEqual(timers.length, 0, 'started: nothing more');

    // The radio off: no retry (its own state change applies again).
    timers.length = 0;
    ({ helper } = host(['Bluetooth is off']));
    await tick();
    assert.strictEqual(timers.length, 0);

    // Switched off before the retry: the retry does nothing.
    timers.length = 0;
    const h = host(['Failed to register advertisement']);
    await tick();
    assert.strictEqual(timers.length, 1);
    h.off();
    const t = timers.shift();
    if (t) t.fn();
    await tick();
    assert.strictEqual(h.helper.calls.filter((c) => c === 'bleStart').length, 1);
  } finally {
    console.log = log;
    global.setTimeout = realSet;
  }
  console.log('ble retry: ok');
})().catch((e) => { console.error(e); process.exit(1); });
