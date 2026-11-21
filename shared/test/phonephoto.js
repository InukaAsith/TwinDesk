// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/phonephoto.js: Take a photo asks the phone's camera, the first picture that arrives is
// copied and the camera closed. Scan document asks for a PDF, ignores pictures, and does not copy
// the PDF. Files before or after, the wrong kind, or after the wait, are left alone. Back on the
// phone ends the wait. No phone, nothing asked, and a refused click does not clear a wait already open.
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
  const popVars = [];
  const pp = new PhonePhoto({
    send: (m) => sent.push(m), phoneOn: () => on,
    popup: (k, vars) => { pops.push(k); popVars.push(vars || null); },
    copy: async (f) => { copied.push(f); }, now: () => now,
  });

  assert.deepStrictEqual(pp.view(), { waiting: false, mode: '' });
  assert.strictEqual(pp.arrived(['/d/IMG_1.jpg']), false); // not asked: a normal file
  assert.ok(pp.take());
  assert.deepStrictEqual(sent.pop(), { t: 'cam.capture', on: true, once: true });
  assert.strictEqual(pp.view().mode, 'photo');
  assert.strictEqual(pp.arrived(['/d/notes.pdf']), false); // a PDF is not the photo
  assert.strictEqual(copied.length, 0);
  assert.strictEqual(pp.arrived(['/d/IMG_2.JPG']), true);
  assert.deepStrictEqual(sent.pop(), { t: 'cam.capture', on: false });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, ['/d/IMG_2.JPG']);
  assert.ok(pops.includes('Photo copied, ready to paste'));
  assert.strictEqual(pp.view().mode, '');
  assert.strictEqual(pp.arrived(['/d/IMG_3.jpg']), false); // one photo

  pp.take();
  pp.ended(); // Back on the phone
  assert.strictEqual(pp.view().mode, '');
  assert.strictEqual(pp.arrived(['/d/IMG_4.jpg']), false);

  pp.take();
  now += WAIT_MS + 1;
  assert.strictEqual(pp.waiting, false);
  assert.strictEqual(pp.view().mode, '');
  assert.strictEqual(pp.arrived(['/d/IMG_5.jpg']), false);

  on = false;
  sent.length = 0;
  assert.strictEqual(pp.take(), false);
  assert.strictEqual(sent.length, 0);
  assert.ok(pops.includes('Connect your phone'));

  // Scan: mode is sent, a picture is ignored, the PDF is kept (not copied), the camera is closed.
  on = true;
  now = 2e12;
  sent.length = 0;
  copied.length = 0;
  assert.ok(pp.scan());
  assert.deepStrictEqual(sent, [{ t: 'cam.capture', on: true, mode: 'scan' }]);
  assert.strictEqual(pp.view().mode, 'scan');
  assert.strictEqual(pp.arrived(['/d/IMG_6.jpg', '/d/notes.txt']), false);
  assert.deepStrictEqual(copied, []);
  assert.strictEqual(sent.length, 1); // still waiting: the picture was not the scan
  assert.strictEqual(pp.arrived(['/d/scans/TwinDesk_Scan.pdf']), true);
  assert.deepStrictEqual(sent[sent.length - 1], { t: 'cam.capture', on: false });
  assert.strictEqual(pops[pops.length - 1], 'Document scan saved: {name}');
  assert.deepStrictEqual(popVars[popVars.length - 1], { name: 'TwinDesk_Scan.pdf' });
  assert.deepStrictEqual(copied, []);
  assert.deepStrictEqual(pp.view(), { waiting: false, mode: '' });
  assert.strictEqual(pp.arrived(['/d/scans/another.pdf']), false);

  // Photo again, after a scan: a PDF is still not the photo, and the picture is still copied.
  sent.length = 0;
  assert.ok(pp.take());
  assert.deepStrictEqual(sent, [{ t: 'cam.capture', on: true, once: true }]);
  assert.strictEqual(pp.arrived(['/d/after.pdf']), false);
  assert.strictEqual(pp.arrived(['/d/IMG_7.png']), true);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, ['/d/IMG_7.png']);

  // Switching while waiting closes the camera that was open, then opens the other one.
  sent.length = 0;
  assert.ok(pp.take());
  assert.ok(pp.scan());
  assert.deepStrictEqual(sent, [
    { t: 'cam.capture', on: true, once: true },
    { t: 'cam.capture', on: false },
    { t: 'cam.capture', on: true, mode: 'scan' },
  ]);
  assert.strictEqual(pp.view().mode, 'scan');
  sent.length = 0;
  assert.ok(pp.take());
  assert.deepStrictEqual(sent, [
    { t: 'cam.capture', on: false },
    { t: 'cam.capture', on: true, once: true },
  ]);
  pp.ended();

  // The wait ends on Back, and on the clock, for a scan the same way as for a photo.
  assert.ok(pp.scan());
  pp.ended();
  assert.strictEqual(pp.view().mode, '');
  assert.strictEqual(pp.arrived(['/d/late-back.pdf']), false);
  assert.ok(pp.scan());
  now += WAIT_MS + 1;
  assert.strictEqual(pp.waiting, false);
  assert.strictEqual(pp.view().mode, '');
  assert.strictEqual(pp.arrived(['/d/late.pdf']), false);

  // No phone: nothing is sent, and a wait that is already open stays open.
  now = 3e12;
  assert.ok(pp.scan());
  on = false;
  const n = sent.length;
  assert.strictEqual(pp.scan(), false);
  assert.strictEqual(pp.take(), false);
  assert.strictEqual(sent.length, n);
  assert.strictEqual(pp.waiting, true);
  assert.strictEqual(pp.view().mode, 'scan');
  on = true;
  pp.ended();
  assert.strictEqual(pp.waiting, false);

  console.log('phonephoto: ok');
})().catch((e) => { console.error(e); process.exit(1); });
