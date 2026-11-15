// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/phonephoto.js: Take a photo asks the phone's camera, the first picture that arrives is
// copied and the camera closed; files before or after, not pictures, or after the wait, are left
// alone; Back on the phone ends the wait; no phone, nothing asked.
// Run with: node shared/test/phonephoto.js
'use strict';

const assert = require('assert');
const { PhonePhoto, WAIT_MS } = require('../phonephoto.js');

(async () => {
  let on = true;
  let now = 1e12;
  const sent = [];
  const copied = [];
  const pops = [];
  const pp = new PhonePhoto({ send: (m) => sent.push(m), phoneOn: () => on, popup: (k) => pops.push(k), copy: async (f) => { copied.push(f); }, now: () => now });

  assert.strictEqual(pp.arrived(['/d/IMG_1.jpg']), false); // not asked: a normal file
  assert.ok(pp.take());
  assert.deepStrictEqual(sent.pop(), { t: 'cam.capture', on: true, once: true });
  assert.strictEqual(pp.arrived(['/d/notes.pdf']), false);
  assert.strictEqual(pp.arrived(['/d/IMG_2.JPG']), true);
  assert.deepStrictEqual(sent.pop(), { t: 'cam.capture', on: false });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, ['/d/IMG_2.JPG']);
  assert.ok(pops.includes('Photo copied, ready to paste'));
  assert.strictEqual(pp.arrived(['/d/IMG_3.jpg']), false); // one photo

  pp.take();
  pp.ended(); // Back on the phone
  assert.strictEqual(pp.arrived(['/d/IMG_4.jpg']), false);

  pp.take();
  now += WAIT_MS + 1;
  assert.strictEqual(pp.arrived(['/d/IMG_5.jpg']), false);

  on = false;
  sent.length = 0;
  assert.strictEqual(pp.take(), false);
  assert.strictEqual(sent.length, 0);
  console.log('phonephoto: ok');
})().catch((e) => { console.error(e); process.exit(1); });
