// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/iosusb/qt.js against a pretend phone: the ping, the clocks, the formats, a frame, sound,
// and the stop, packet by packet and split at odd places (as the USB reads come).
'use strict';

const assert = require('assert');
const { QtSession, T, el, u32, u64 } = require('../iosusb/qt.js');

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const frame = (body) => Buffer.concat([u32(4 + body.length), body]);
const sync = (type, corr, payload = Buffer.alloc(0), clock = 0x1111n) => frame(Buffer.concat([u32(T.sync), u64(clock), u32(type), u64(corr), payload]));
const asyn = (type, payload = Buffer.alloc(0), clock = 0x2222n) => frame(Buffer.concat([u32(T.asyn), u64(clock), u32(type), payload]));
const idx = (k, v) => el(T.keyv, Buffer.concat([el(T.idxk, u16(k)), v]));

const avcC = Buffer.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const fdsc = el(T.fdsc, Buffer.concat([
  el(T.mdia, u32(T.vide)), el(T.codc, u32(T.avc1)), el(T.vdim, Buffer.concat([u32(1170), u32(2532)])),
  el(T.extn, el(T.dict, idx(49, el(T.dict, idx(105, el(T.datv, avcC)))))),
]));
const nal = (type, n) => { const b = Buffer.alloc(4 + n); b.writeUInt32BE(n); b[4] = type; return b; };
const sbuf = (data, withFormat) => el(T.sbuf, Buffer.concat([el(T.sdat, data), ...(withFormat ? [fdsc] : [])]));

const out = [];
const q = new QtSession((b) => out.push(Buffer.from(b)));
const seen = { config: null, frames: [], audio: [], closed: false, warn: [] };
q.on('config', (c) => { seen.config = c; });
q.on('frame', (f) => seen.frames.push(f));
q.on('audio', (a) => seen.audio.push(a));
q.on('closed', () => { seen.closed = true; });
q.on('warn', (w) => seen.warn.push(w));

const parse = (b) => ({ len: b.readUInt32LE(0), magic: b.readUInt32LE(4), b });
const take = () => out.splice(0).map(parse);

// The phone's stream, cut into uneven pieces.
function send(...packets) {
  const all = Buffer.concat(packets);
  for (let i = 0; i < all.length;) { const n = 1 + ((i * 7) % 13); q.feed(all.subarray(i, i + n)); i += n; }
}

// ping → ping
send(frame(Buffer.concat([u32(T.ping), u32(0), u32(1)])));
let r = take();
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].magic, T.ping);
assert.strictEqual(r[0].len, 16);

// cwpa → hpd1 (asyn), the reply with our clock, hpa1 with the phone's clock
send(sync(T.cwpa, 7n, u64(0xabcdn)));
r = take();
assert.deepStrictEqual(r.map((x) => x.magic), [T.asyn, T.asyn, T.rply, T.asyn]);
assert.strictEqual(r[0].b.readUInt32LE(16), T.hpd1);
assert.strictEqual(r[1].b.readUInt32LE(16), T.hpd1);
assert(r[0].b.includes(Buffer.from('Valeria')));
assert.strictEqual(r[2].b.readBigUInt64LE(8), 7n);
assert.strictEqual(r[2].b.readBigUInt64LE(20), 0xabcdn + 1000n);
assert.strictEqual(r[3].b.readUInt32LE(16), T.hpa1);
assert.strictEqual(r[3].b.readBigUInt64LE(8), 0xabcdn);
// formats: 56 bytes, flags 12
const fm = r[3].b.indexOf(Buffer.from('formats'));
assert(fm > 0);
assert.strictEqual(r[3].b.readUInt32LE(fm + 7), 8 + 56);
assert.strictEqual(r[3].b.readUInt32LE(fm + 7 + 8 + 12), 12);

// cvrp (with the first format) → need, reply; config from its avcC and size
send(sync(T.cvrp, 8n, Buffer.concat([u64(0x5555n), el(T.dict, el(T.keyv, Buffer.concat([el(T.strk, Buffer.from('FormatDescription')), fdsc])))])));
r = take();
assert.deepStrictEqual(r.map((x) => x.magic), [T.asyn, T.rply]);
assert.strictEqual(r[0].b.readUInt32LE(16), T.need);
assert.strictEqual(r[0].b.readBigUInt64LE(8), 0x5555n);
assert.strictEqual(r[1].b.readBigUInt64LE(20), 0x5555n + 0x1000afn);
assert(seen.config, 'config');
assert.strictEqual(seen.config.codec, 'avc1.640028');
assert.deepStrictEqual([seen.config.width, seen.config.height], [1170, 2532]);
assert(seen.config.avcC.equals(avcC));

// clok, time, afmt, skew, go!
send(sync(T.clok, 9n, Buffer.alloc(0), 0x100n));
r = take();
assert.strictEqual(r[0].b.readBigUInt64LE(20), 0x100n + 0x10000n);
send(sync(T.time, 10n));
r = take();
assert.strictEqual(r[0].len, 44);
assert.strictEqual(r[0].b.readUInt32LE(28), 1e9);
send(sync(T.afmt, 11n), sync(T.skew, 12n), sync(T.og, 13n), sync(T.stop, 14n));
r = take();
assert.strictEqual(r.length, 4);
assert(r[0].b.includes(Buffer.from('Error')));
assert.strictEqual(r[1].b.readDoubleLE(20), 48000);
assert.strictEqual(r[2].len, 24);

// feed: a key frame, then a delta; each is followed by need
send(asyn(T.feed, sbuf(Buffer.concat([nal(6, 3), nal(5, 20)]), false)), asyn(T.feed, sbuf(nal(1, 10), false)));
r = take();
assert.strictEqual(r.length, 2);
assert(r.every((x) => x.b.readUInt32LE(16) === T.need));
assert.deepStrictEqual(seen.frames.map((f) => f.key), [true, false]);
assert.strictEqual(seen.frames[1].data.length, 14);

// eat!: PCM
const pcm = Buffer.alloc(16);
pcm.writeInt16LE(1000, 0);
pcm.writeInt16LE(-1000, 2);
send(asyn(T['eat!'], sbuf(pcm, false)));
assert.strictEqual(seen.audio.length, 1);
assert.strictEqual(seen.audio[0].rate, 48000);
assert.deepStrictEqual([...seen.audio[0].data.slice(0, 2)], [1000, -1000]);

// close: hpa0 (the phone's audio clock), hpd0; two rels end it; no more need after
q.close();
r = take();
assert.deepStrictEqual(r.map((x) => x.b.readUInt32LE(16)), [T.hpa0, T.hpd0]);
assert.strictEqual(r[0].b.readBigUInt64LE(8), 0xabcdn);
send(asyn(T.feed, sbuf(nal(1, 4), false)));
assert.strictEqual(take().length, 0);
send(asyn(T.rels), asyn(T.rels));
assert(seen.closed);
r = take();
assert.deepStrictEqual(r.map((x) => x.b.readUInt32LE(16)), [T.hpd0]);
assert.deepStrictEqual(seen.warn, []);

console.log('iosusb-qt: ok');
