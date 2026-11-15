// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls › Pause what plays here (shared/callpause.js): pauses only what plays, plays again only what it paused.
'use strict';
const assert = require('assert');
const { CallPause } = require('../callpause.js');

(async () => {
  const log = [];
  let playing = true;
  const media = { poll: async () => {}, state: () => ({ playing }), do: (c) => { log.push(c); playing = c === 'play'; } };
  let on = true;
  const cp = new CallPause({ media: () => media, on: () => on });
  await cp.onCall({ state: 'ringing' });
  await cp.onCall({ state: 'offhook' });
  assert.deepStrictEqual(log, ['pause']);
  await cp.onCall(null);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepStrictEqual(log, ['pause', 'play']);
  // Paused already by you: nothing to pause, nothing played after.
  playing = false; log.length = 0;
  await cp.onCall({ state: 'ringing' });
  await cp.onCall(null);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepStrictEqual(log, []);
  // Off: never touched.
  on = false; playing = true;
  await cp.onCall({ state: 'ringing' });
  assert.deepStrictEqual(log, []);
  console.log('callpause ok');
})().catch((e) => { console.error(e); process.exit(1); });
