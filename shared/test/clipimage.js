// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/clipimage.js: a clipboard picture in pieces, put back together; what is refused.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const { ImageOut, ImageIn, MeshClipImages, isPng } = require('../clipimage.js');

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
  // A picture carries when and where it was copied (Multi-device: the latest copy wins against text too).
  {
    const sent = [];
    await new ImageOut({ send: (m) => sent.push(m) }).send(png(100), { w: 1, h: 1, stamp: { ts: 1234, o: 'dev-a' } });
    assert.deepStrictEqual([sent[0].ts, sent[0].o], [1234, 'dev-a']);
    const inn = new ImageIn();
    inn.header(sent[0]);
    const pic = inn.part(sent[1]);
    assert.deepStrictEqual([pic.ts, pic.o], [1234, 'dev-a']);
    const plain = [];
    await new ImageOut({ send: (m) => plain.push(m) }).send(png(100));
    assert.ok(!('ts' in plain[0]) && !('o' in plain[0]), 'no stamp: none on the wire');
  }

  // Multi-device: a picture older than the newest copy here (a text copied after it) isn't applied;
  // a newer one is; one that stays here says why in the log.
  {
    const { Latest } = require('../clipsync.js');
    const fakeImg = (png) => ({
      isEmpty: () => !png, getSize: () => ({ width: 2, height: 2 }), toPNG: () => png,
      resize: () => ({ toBitmap: () => Buffer.from(png ? png.subarray(0, 16) : []), toDataURL: () => 'data:' }),
    });
    const clipboard = { img: fakeImg(null), writes: 0, readImage() { return this.img; }, writeImage(i) { this.img = i; this.writes++; } };
    const latest = new Latest({ selfId: 'here' });
    const logs = [];
    const settings = { enabled: true, images: true, send: true, receive: true };
    const imgs = new MeshClipImages({
      cfg: () => settings, clipboard, ids: () => ['A'], send: () => true, backlog: () => 0, ble: () => false,
      peerName: () => 'PC-A', remember: () => {}, popup: () => {}, onChange: () => {}, log: (l) => logs.push(l),
      copied: () => latest.copied('image'), newest: (pic) => latest.accept(pic, 'image'),
    });
    Object.defineProperty(imgs, 'nativeImage', { value: { createFromBuffer: (b) => fakeImg(b), createEmpty: () => fakeImg(null) } });
    const inline = (ts, fill) => ({ t: T.CLIP_IMAGE, id: 'p' + ts, w: 2, h: 2, png: Buffer.concat([png(9), Buffer.alloc(40, fill)]).toString('base64'), ts, o: 'A' });
    const textStamp = latest.copied('text');
    imgs.header(inline(textStamp.ts - 1000, 0x10), 'A');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(clipboard.writes, 0, 'older than the text copied here');
    assert.ok(/older than the newest copy here/.test(logs.pop()));
    imgs.header(inline(textStamp.ts + 1000, 0x20), 'A');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(clipboard.writes, 1, 'newer: on the clipboard');
    const got = logs.pop();
    assert.ok(/from PC-A: on the clipboard/.test(got), got);

    clipboard.img = fakeImg(Buffer.concat([png(9), Buffer.alloc(40, 0x30)])); // copied here; A takes no pictures
    assert.strictEqual(await imgs.offerClipboard(false), '');
    const why = logs.pop();
    assert.ok(/stays here: PC-A: Pictures is off there/.test(why), why);
    assert.strictEqual(await imgs.offerClipboard(false), '');
    assert.strictEqual(logs.length, 0, 'once per picture');
    imgs.policy({ images: true }, 'A');
    const out = [];
    imgs.o.send = (id, m) => out.push(m);
    assert.strictEqual(await imgs.offerClipboard(false), 'sent', 'it takes pictures now: the same picture goes');
    assert.ok(Number.isFinite(out[0].ts) && out[0].o === 'here', 'stamped');
    assert.ok(/PC-A sent/.test(logs.pop()));
  }
  console.log('clipimage: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
