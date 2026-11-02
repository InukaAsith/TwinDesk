// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/clipimage.js: a clipboard picture in pieces, put back together; what is refused.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const { ImageOut, ImageIn, isPng } = require('../clipimage.js');

const T = P.T;
const PART = P.CLIP_IMAGE_PART_BYTES;

function png(size) {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}

(async () => {
  // Several pieces, in order: the same bytes come out.
  {
    const sent = [];
    const out = new ImageOut({ send: (m) => sent.push(m) });
    const pic = png(PART * 2 + 1234);
    assert.strictEqual(await out.send(pic, { w: 640, h: 480 }), true);
    assert.strictEqual(sent.length, 4, 'a header and three pieces');
    assert.deepStrictEqual([sent[0].t, sent[0].parts, sent[0].bytes, sent[0].w], [T.CLIP_IMAGE, 3, pic.length, 640]);
    assert.strictEqual(sent[0].shot, undefined);
    const inn = new ImageIn();
    assert.strictEqual(inn.header(sent[0]), null, 'pieces still to come');
    assert.strictEqual(inn.part(sent[1]), null);
    assert.strictEqual(inn.part(sent[2]), null);
    const got = inn.part(sent[3]);
    assert.ok(got && got.png.equals(pic), 'put back together');
    assert.deepStrictEqual([got.w, got.h, got.shot], [640, 480, false]);
  }

  // A screenshot is marked.
  {
    const sent = [];
    await new ImageOut({ send: (m) => sent.push(m) }).send(png(100), { w: 1, h: 1, shot: true });
    assert.strictEqual(sent[0].shot, true);
    assert.strictEqual(new ImageIn().header(sent[0]), null);
    const inn = new ImageIn();
    inn.header(sent[0]);
    assert.strictEqual(inn.part(sent[1]).shot, true);
  }

  // Inline (Multi-device's form) is taken whole.
  {
    const pic = png(300);
    const got = new ImageIn().header({ t: T.CLIP_IMAGE, id: 'a', w: 2, h: 3, png: pic.toString('base64') });
    assert.ok(got && got.png.equals(pic));
  }

  // Refused: not a PNG, too big, a piece out of order, a piece of another picture, a newer copy.
  {
    assert.strictEqual(await new ImageOut({ send: () => true }).send(Buffer.alloc(100)), false, 'not a PNG');
    assert.strictEqual(await new ImageOut({ send: () => true }).send(png(P.CLIP_IMAGE_MAX_BYTES + 1)), false, 'too big');
    assert.strictEqual(new ImageIn().header({ id: 'a', bytes: P.CLIP_IMAGE_MAX_BYTES + 1, parts: 41 }), null);
    assert.strictEqual(new ImageIn().header({ id: 'a', png: Buffer.alloc(20).toString('base64') }), null, 'inline, not a PNG');

    const sent = [];
    await new ImageOut({ send: (m) => sent.push(m) }).send(png(PART * 2 + 5));
    const inn = new ImageIn();
    inn.header(sent[0]);
    assert.strictEqual(inn.part(sent[2]), null, 'out of order');
    assert.strictEqual(inn.part(sent[1]), null, 'dropped after that');
    assert.strictEqual(inn.cur, null);

    inn.header(sent[0]);
    assert.strictEqual(inn.part({ ...sent[1], id: 'other' }), null, 'another picture');
    inn.drop();
    assert.strictEqual(inn.part(sent[1]), null, 'a newer copy dropped it');

    inn.header({ ...sent[0], parts: 2 });
    assert.strictEqual(inn.cur, null, 'parts must match bytes');
  }

  // A newer copy stops one still going; the socket's backlog is waited for.
  {
    const sent = [];
    let backlog = 10 * 1024 * 1024;
    const out = new ImageOut({ send: (m) => sent.push(m), backlog: () => backlog });
    const p = out.send(png(PART * 3));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(sent.length, 1, 'waits while the socket is full');
    out.cancel();
    backlog = 0;
    assert.strictEqual(await p, false, 'stopped');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(out.busy, false);
  }

  // The session gone: nothing more goes.
  {
    const sent = [];
    let open = true;
    const out = new ImageOut({ send: (m) => { sent.push(m); if (sent.length === 2) open = false; }, open: () => open });
    assert.strictEqual(await out.send(png(PART * 3)), false);
    assert.strictEqual(sent.length, 2);
  }

  assert.ok(isPng(png(9)) && !isPng(Buffer.alloc(9)));
  {
    const rejected = new ImageOut({ send: (m) => m.t !== T.CLIP_IMAGE_PART });
    assert.strictEqual(await rejected.send(png(100)), false, 'a rejected final piece is a failed send');
    assert.strictEqual(rejected.busy, false);
    const failed = new ImageOut({ send: () => { throw new Error('socket closed'); } });
    assert.strictEqual(await failed.send(png(100)), false, 'a closed transport fails without leaving a busy sender');
    assert.strictEqual(failed.busy, false);
  }
  console.log('clipimage: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
