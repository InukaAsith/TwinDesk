// Tests for shared/clipsync.js. Run with: node shared/test/clipsync.js
'use strict';
const assert = require('assert');
const P = require('../protocol.js');
const { Clock, Latest, compare, validStamp, textMessage, imageMessage, readImage } = require('../clipsync.js');

const dev = (id, t0) => { let t = t0; const clk = new Clock(() => t); return { id, set: (n) => { t = n; }, clock: clk, latest: new Latest({ selfId: id, clock: clk }) }; };

// The reported bug: Windows copies A, then the Mac copies B; A's late push must not replace B.
{
  const w = dev('W', 1000);
  const m = dev('M', 1000);
  const a = textMessage('A', w.latest.copied('text'));     // copy on Windows at t=1000
  m.set(1500);
  const b = textMessage('B', m.latest.copied('text'));     // copy on the Mac, later, before A arrived
  m.set(1600);
  assert.strictEqual(m.latest.accept(a, 'text'), false, 'the older A must not overwrite the Mac\'s newer B');
  w.set(1700);
  assert.strictEqual(w.latest.accept(b, 'text'), true, 'B is newer than A: Windows takes it');
  assert.strictEqual(w.latest.accept(a, 'text'), false, 'and an echo of A is ignored afterwards');
}

// A copy made right after receiving another is newer even when the clocks disagree.
{
  const w = dev('W', 5000);
  const m = dev('M', 1000); // the Mac's clock is 4 s behind
  const a = textMessage('A', w.latest.copied('text'));
  m.set(1100);
  assert.strictEqual(m.latest.accept(a, 'text'), true);
  const b = textMessage('B', m.latest.copied('text')); // the Mac copies right after: wall time is 1100 < 5000
  assert.ok(b.ts > a.ts, 'the clock moved past what it saw: B > A');
  w.set(5200);
  assert.strictEqual(w.latest.accept(b, 'text'), true, 'Windows takes B although the Mac clock is behind');
}

// A clock far in the future does not win for ever.
{
  const m = dev('M', 1000);
  const evil = { t: P.T.CLIP, text: 'x', ts: 1e12, o: 'X' };
  assert.strictEqual(m.latest.accept(evil, 'text'), true);
  m.set(1500);
  const mine = m.latest.copied('text');
  m.set(1600);
  assert.ok(mine.ts <= 1500 + P.CLIP_SKEW_MS + 10, 'our next copy is not dragged into the far future');
}

// Ties are broken the same way on every device; own echo is dropped; items without a time count as new.
{
  assert.ok(compare({ ts: 5, o: 'a' }, { ts: 5, o: 'b' }) < 0 && compare({ ts: 5, o: 'b' }, { ts: 5, o: 'a' }) > 0);
  const m = dev('M', 1000);
  assert.strictEqual(m.latest.accept({ t: 'clip', text: 'old app' }, 'text'), true, 'no ts: copied on arrival');
  assert.strictEqual(m.latest.accept({ t: 'clip', text: 'x', ts: 900, o: 'M' }, 'text'), false, 'our own copy coming back');
  assert.strictEqual(validStamp({ ts: 1, o: 'a' }), true);
  assert.strictEqual(validStamp({ ts: -1, o: 'a' }), false);
  assert.strictEqual(validStamp({ ts: 1 }), false);
}

// clip.latest: tells who holds the newer copy.
{
  const w = dev('W', 1000);
  const m = dev('M', 1000);
  assert.strictEqual(w.latest.latestMessage(), null);
  w.latest.copied('text');
  const lm = w.latest.latestMessage();
  assert.strictEqual(lm.t, P.T.CLIP_LATEST);
  assert.strictEqual(m.latest.isNewer(lm), true, 'the Mac has nothing: the Windows copy is newer');
  m.set(2000);
  m.latest.copied('image');
  assert.strictEqual(w.latest.isNewer(m.latest.latestMessage()), true);
  assert.strictEqual(m.latest.isNewer(w.latest.latestMessage()), false);
}

// images
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const msg = imageMessage({ id: 'i1', w: 4, h: 3, png }, { ts: 10, o: 'W' });
  assert.strictEqual(msg.t, P.T.CLIP_IMAGE);
  const back = readImage(msg);
  assert.ok(back && back.png.equals(png) && back.w === 4 && back.h === 3);
  assert.strictEqual(readImage({ ...msg, png: Buffer.from('not a png at all').toString('base64') }), null, 'not a PNG');
  assert.strictEqual(imageMessage({ id: 'i', w: 1, h: 1, png: Buffer.alloc(P.CLIP_IMAGE_MAX_BYTES + 1) }, { ts: 1, o: 'a' }), null, 'too big to send');
  assert.strictEqual(readImage({ id: 'i', png: 'A'.repeat(P.CLIP_IMAGE_MAX_BYTES * 2) }), null, 'too big to take');
}
// An older app's item (no time) relayed to B, then A copies: A's clock never saw B's arrival time,
// so A's copy can carry the same millisecond or a little less. It came after, so it wins. A copy
// from long before the untimed item is still a late repeat.
{
  const A = dev('A', 899);
  const B = dev('B', 900);
  assert.ok(B.latest.accept({ t: 'clip', text: 'from old', o: 'L' }, 'text'), 'untimed: copied on arrival');
  const mine = A.latest.copied('text');
  assert.strictEqual(mine.ts, 899, "A's clock is behind B's");
  assert.ok(B.latest.accept({ ...mine }, 'text'), 'a copy made after the untimed one wins');
  const C = dev('C', 100000);
  C.latest.accept({ t: 'clip', text: 'old app' }, 'text');
  assert.ok(!C.latest.accept({ ts: 100000 - 60000, o: 'A' }, 'text'), 'a minute before it: a late repeat, not applied');
  // Two untimed items in a row: the order they arrived in.
  assert.ok(C.latest.accept({ t: 'clip', text: 'again' }, 'text'));
}
console.log('clipsync: passed');
