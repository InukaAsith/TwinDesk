'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { KeyLayout } = require('../keylayout');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('older layout request cannot overwrite a newer keyboard layout', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const keys = new KeyLayout(() => ++calls === 1 ? first.promise : second.promise);
  const old = keys.refresh(), current = keys.refresh(); await Promise.resolve();
  second.resolve({ layout: { KeyY: 'z' }, type: true, selectInput: true, im: 'ja' }); await current;
  first.resolve({ layout: { KeyY: 'y' }, type: false }); await old;
  assert.equal(keys.map.KeyY, 'z'); assert.equal(keys.canType, true); assert.equal(keys.im, 'ja');
});
test('layout reply from before handoff reset cannot restore stale capabilities', async () => {
  const wait = deferred(), keys = new KeyLayout(() => wait.promise);
  keys.set({ KeyY: 'z' }); const pending = keys.refresh(); keys.reset();
  wait.resolve({ layout: { KeyY: 'y' }, type: true, selectInput: true, im: 'ja' }); await pending;
  assert.equal(keys.map.KeyY, 'z'); assert.equal(keys.canType, false); assert.equal(keys.im, null);
});
test('new refresh after reset applies the current layout normally', async () => {
  const keys = new KeyLayout(async () => ({ layout: { KeyA: 'q' }, type: true }));
  keys.reset(); await keys.refresh(); assert.equal(keys.map.KeyA, 'q'); assert.equal(keys.canType, true);
});
