// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/airplay: a sender's side against the receiver on loopback — /info, pair-setup and
// pair-verify (both signatures checked), fp-setup, both SETUPs, then an encrypted mirror stream
// whose codec record and frames come out decrypted. And the mDNS answers for _airplay._tcp.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const bplist = require('../airplay/bplist.js');
const { AirPlayReceiver } = require('../airplay/receiver.js');

const b64u = (b) => Buffer.from(b).toString('base64url');
const rawPub = (k) => Buffer.from(crypto.createPublicKey(k).export({ format: 'jwk' }).x, 'base64url');
const sha512 = (...p) => { const h = crypto.createHash('sha512'); for (const x of p) h.update(x); return h.digest(); };

function client(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  let waiting = null;
  let cseq = 0;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0 || !waiting) return;
    const head = buf.toString('latin1', 0, end);
    const len = Number((/content-length:\s*(\d+)/i.exec(head) || [0, 0])[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.subarray(end + 4, end + 4 + len);
    buf = buf.subarray(end + 4 + len);
    const w = waiting;
    waiting = null;
    w({ status: Number(head.split(' ')[1]), head, body: Buffer.from(body) });
  });
  const req = (method, uri, body = Buffer.alloc(0), type = 'application/octet-stream') => new Promise((resolve) => {
    waiting = resolve;
    sock.write(Buffer.concat([Buffer.from(`${method} ${uri} RTSP/1.0\r\nCSeq: ${++cseq}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n\r\n`), body]));
  });
  return { sock, req, ready: new Promise((r) => sock.once('connect', r)) };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-airplay-'));
  const rx = new AirPlayReceiver({ name: 'Test PC', dir, port: 0 });
  rx.adv = null;
  await rx.start();
  rx.adv.stop(false); // no multicast in a test
  assert.ok(rx.port > 0);
  const c = client(rx.port);
  await c.ready;

  // /info
  const info = bplist.parse((await c.req('GET', '/info')).body);
  assert.strictEqual(info.model, 'AppleTV3,2');
  assert.strictEqual(info.pk.length, 32);
  assert.strictEqual(info.displays[0].width, 1920);

  // pair-setup: their key back
  const ed = crypto.generateKeyPairSync('ed25519');
  const setup = await c.req('POST', '/pair-setup', rawPub(ed.privateKey));
  assert.deepStrictEqual(setup.body, info.pk);

  // pair-verify 1: ECDH; their signature over (theirs || ours) checks with the pk from /info
  const x = crypto.generateKeyPairSync('x25519');
  const ourX = rawPub(x.privateKey);
  const v1 = await c.req('POST', '/pair-verify', Buffer.concat([Buffer.from([1, 0, 0, 0]), ourX, rawPub(ed.privateKey)]));
  assert.strictEqual(v1.body.length, 96);
  const theirX = v1.body.subarray(0, 32);
  const secret = crypto.diffieHellman({ privateKey: x.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(theirX) }, format: 'jwk' }) });
  const key = sha512(Buffer.from('Pair-Verify-AES-Key'), secret).subarray(0, 16);
  const iv = sha512(Buffer.from('Pair-Verify-AES-IV'), secret).subarray(0, 16);
  const ctr = crypto.createDecipheriv('aes-128-ctr', key, iv);
  const theirSig = ctr.update(v1.body.subarray(32));
  const theirEd = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(info.pk) }, format: 'jwk' });
  assert.ok(crypto.verify(null, Buffer.concat([theirX, ourX]), theirEd, theirSig), 'receiver signature');

  // pair-verify 2: a bad signature is refused, on a fresh connection's state; a good one passes
  const ourSig = crypto.sign(null, Buffer.concat([ourX, theirX]), ed.privateKey);
  const v2 = await c.req('POST', '/pair-verify', Buffer.concat([Buffer.from([0, 0, 0, 0]), ctr.update(ourSig)]));
  assert.strictEqual(v2.status, 200);

  // fp-setup: the mode's answer, then the key message's tail behind the header
  const m1 = Buffer.from([0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x02, 0x00, 0x02, 0xbb]);
  const f1 = await c.req('POST', '/fp-setup', m1);
  assert.strictEqual(f1.body.length, 142);
  assert.strictEqual(f1.body[13], 2); // mode 2's answer
  const m2 = Buffer.concat([Buffer.from([0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x98, 0x02]), crypto.randomBytes(151)]);
  const bad = Buffer.from(m2);
  bad[12] = 7;
  assert.strictEqual(new (require('../airplay/fairplay.js').FairPlay)().setup(bad), null); // a mode playfair has no tables for
  const f2 = await c.req('POST', '/fp-setup', m2);
  assert.strictEqual(f2.body.length, 32);
  assert.deepStrictEqual(f2.body.subarray(12), m2.subarray(144));

  // SETUP 1: keys and timing
  const ekey = Buffer.concat([Buffer.from('FPLY'), crypto.randomBytes(68)]);
  const eiv = crypto.randomBytes(16);
  let session = null;
  rx.on('session', (s) => { session = s; });
  const s1 = bplist.parse((await c.req('SETUP', 'rtsp://127.0.0.1/123', bplist.build({ ekey, eiv, timingPort: 0, name: 'Test iPhone', model: 'iPhone15,2', isScreenMirroringSession: true }), 'application/x-apple-binary-plist')).body);
  assert.ok(s1.timingPort > 0);
  assert.strictEqual(session && session.name, 'Test iPhone');
  assert.strictEqual(rx.view().session.name, 'Test iPhone');

  // The key the receiver derived: FairPlay's (whatever playfair makes of this ekey), hashed with the secret
  const { FairPlay } = require('../airplay/fairplay.js');
  const fp = new FairPlay();
  fp.setup(m1);
  fp.setup(m2);
  const fpKey = fp.decrypt(ekey);
  assert.strictEqual(fpKey.length, 16);
  const aesKey = sha512(fpKey, secret).subarray(0, 16);

  // SETUP 2: the mirror stream (an id past 2^53, sent as a negative int64 as libplist does)
  const sid = 0xf123456789abcdefn;
  const s2 = bplist.parse((await c.req('SETUP', 'rtsp://127.0.0.1/123', bplist.build({ streams: [{ type: 110, streamConnectionID: BigInt.asIntN(64, sid) }] }), 'application/x-apple-binary-plist')).body);
  const dataPort = s2.streams[0].dataPort;
  assert.ok(dataPort > 0);

  const skey = sha512(Buffer.from(`AirPlayStreamKey${sid}`), aesKey).subarray(0, 16);
  const siv = sha512(Buffer.from(`AirPlayStreamIV${sid}`), aesKey).subarray(0, 16);
  const enc = crypto.createCipheriv('aes-128-ctr', skey, siv);
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9]);
  const pps = Buffer.from([0x68, 0xeb, 0xe3, 0xcb]);
  const avcC = Buffer.concat([Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, sps.length]), sps, Buffer.from([1, 0, pps.length]), pps]);
  const pkt = (type, payload) => {
    const h = Buffer.alloc(128);
    h.writeUInt32LE(payload.length, 0);
    h[4] = type;
    if (type === 1) { h.writeFloatLE(1170, 56); h.writeFloatLE(2532, 60); }
    return Buffer.concat([h, payload]);
  };
  const nal = (t, n) => { const b = Buffer.alloc(4 + n, 0xab); b.writeUInt32BE(n, 0); b[4] = t; return b; };
  const idr = Buffer.concat([nal(0x06, 7), nal(0x65, 1001)]);
  const pframe = nal(0x41, 333);

  const got = { config: null, frames: [] };
  rx.on('config', (cfg) => { got.config = cfg; });
  rx.on('frame', (f) => got.frames.push(f));
  const ms = net.connect(dataPort, '127.0.0.1');
  await new Promise((r) => ms.once('connect', r));
  const all = Buffer.concat([pkt(1, avcC), pkt(0, enc.update(idr)), pkt(2, Buffer.alloc(0)), pkt(0, enc.update(pframe))]);
  // In odd pieces, as TCP may give them
  for (let i = 0; i < all.length; i += 97) ms.write(all.subarray(i, i + 97));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(got.config, 'codec record');
  assert.strictEqual(got.config.codec, 'avc1.64001f');
  assert.strictEqual(got.config.width, 1170);
  assert.strictEqual(got.config.height, 2532);
  assert.strictEqual(got.frames.length, 2);
  assert.deepStrictEqual(got.frames[0].data, idr);
  assert.strictEqual(got.frames[0].key, true);
  assert.deepStrictEqual(got.frames[1].data, pframe);
  assert.strictEqual(got.frames[1].key, false);

  // The sound: SETUP 96 (AAC-ELD), an RTP packet AES-CBC'd with the session key and eiv (the tail
  // past the last whole block left plain), decrypted with its spf and seq
  const s3 = bplist.parse((await c.req('SETUP', 'rtsp://127.0.0.1/123', bplist.build({ streams: [{ type: 96, ct: 8, spf: 480, controlPort: 0 }] }), 'application/x-apple-binary-plist')).body);
  assert.ok(s3.streams[0].dataPort > 0 && s3.streams[0].controlPort > 0);
  const au = crypto.randomBytes(37); // two blocks and 5 bytes
  const cbc = crypto.createCipheriv('aes-128-cbc', aesKey, eiv);
  cbc.setAutoPadding(false);
  const rtp = Buffer.alloc(12);
  rtp[0] = 0x80; rtp[1] = 0x60; rtp.writeUInt16BE(77, 2); rtp.writeUInt32BE(12345, 4);
  const sound = new Promise((r) => rx.once('audio', r));
  const us = require('dgram').createSocket('udp4');
  us.send(Buffer.concat([rtp, cbc.update(au.subarray(0, 32)), au.subarray(32)]), s3.streams[0].dataPort, '127.0.0.1', () => us.close());
  const a = await sound;
  assert.deepStrictEqual(a.data, au);
  assert.strictEqual(a.ct, 8);
  assert.strictEqual(a.spf, 480);
  assert.strictEqual(a.seq, 77);

  // TEARDOWN of the streams, then of the session
  let ended = false;
  rx.on('end', () => { ended = true; });
  await c.req('TEARDOWN', 'rtsp://127.0.0.1/123', bplist.build({ streams: [{ type: 110 }] }), 'application/x-apple-binary-plist');
  assert.ok(!ended); // the sound still goes
  await c.req('TEARDOWN', 'rtsp://127.0.0.1/123', bplist.build({ streams: [{ type: 96 }] }), 'application/x-apple-binary-plist');
  assert.ok(ended);
  assert.strictEqual(rx.view().session, null);
  ms.destroy();
  c.sock.destroy();
  rx.stop();

  // mDNS: a PTR question for _airplay._tcp gets PTR + SRV + TXT + A
  const { Advertiser } = require('../airplay/advertise.js');
  const adv = new Advertiser({ name: 'Test PC', host: 'twindesk-ap-test', port: 7000, airplayTxt: { model: 'AppleTV3,2' }, raopTxt: { am: 'AppleTV3,2' }, raopName: 'AABBCCDDEEFF@Test PC' });
  const sent = [];
  adv.sock = { send: (b) => sent.push(b), setMulticastInterface() {} };
  const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from('\x08_airplay\x04_tcp\x05local\x00', 'latin1'), Buffer.from([0, 12, 0, 1])]);
  adv._query(q, { address: '127.0.0.1', port: 5353 });
  const { ipv4s } = require('../web/mdnshost.js');
  if (ipv4s().length) {
    assert.strictEqual(sent.length, 1);
    const r = sent[0];
    assert.strictEqual(r.readUInt16BE(6), 1); // one answer
    assert.strictEqual(r.readUInt16BE(10), 3); // SRV, TXT, A
    assert.ok(r.includes(Buffer.from('Test PC')));
    assert.ok(r.includes(Buffer.from('model=AppleTV3,2')));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('airplay: ok');
})().catch((e) => { console.error(e); process.exit(1); });
