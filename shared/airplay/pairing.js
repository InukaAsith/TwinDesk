// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Adapted from UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0), lib/pairing.c.
// AirPlay's legacy pairing (UxPlay lib/pairing.c): /pair-setup trades Ed25519 public keys, and
// /pair-verify agrees an X25519 secret, each side signing both ECDH keys. The secret later hashes the
// FairPlay key (stream keys, receiver.js).
//
// Identity: loadIdentity(file) → {key (Ed25519 KeyObject), pk (32 bytes), id ('AA:BB:…' device id)},
//   made once and kept in file.
// new Pairing(identity); .setup(body) → reply; .verify(body) → reply | null (a bad signature); .secret
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const b64u = (b) => Buffer.from(b).toString('base64url');
const rawPub = (key) => Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
const edPub = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
const xPub = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' });
const sha512 = (...parts) => { const h = crypto.createHash('sha512'); for (const p of parts) h.update(p); return h.digest(); };

function loadIdentity(file) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (!saved || typeof saved.key !== 'string' || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(saved.id || '')) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    // A locally administered MAC-like id: AirPlay clients remember receivers by it.
    const mac = crypto.randomBytes(6);
    mac[0] = (mac[0] & 0xfc) | 0x02;
    saved = { key: privateKey.export({ format: 'pem', type: 'pkcs8' }), id: [...mac].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':'), pi: crypto.randomUUID() };
    try { fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 }); } catch (e) { console.warn('[airplay] identity not saved:', e.message); }
  }
  const key = crypto.createPrivateKey(saved.key);
  return { key, pk: rawPub(key), id: saved.id, pi: saved.pi || crypto.randomUUID() };
}

class Pairing {
  constructor(identity) {
    this.me = identity;
    this.secret = null; // the X25519 secret once verified
    this.pending = null;
  }

  setup(body) {
    // Legacy: the client's Ed25519 key (32 bytes); ours goes back.
    return Buffer.from(this.me.pk);
  }

  verify(body) {
    if (!Buffer.isBuffer(body) || body.length < 4) return null;
    if (body[0] === 1) {
      if (body.length < 68) return null;
      const theirEcdh = Buffer.from(body.subarray(4, 36));
      const theirEd = Buffer.from(body.subarray(36, 68));
      const mine = crypto.generateKeyPairSync('x25519');
      const ourEcdh = rawPub(mine.privateKey);
      const secret = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: xPub(theirEcdh) });
      const key = sha512(Buffer.from('Pair-Verify-AES-Key'), secret).subarray(0, 16);
      const iv = sha512(Buffer.from('Pair-Verify-AES-IV'), secret).subarray(0, 16);
      const sig = crypto.sign(null, Buffer.concat([ourEcdh, theirEcdh]), this.me.key);
      const ctr = crypto.createCipheriv('aes-128-ctr', key, iv);
      const enc = ctr.update(sig);
      this.pending = { theirEcdh, theirEd, ourEcdh, secret, ctr };
      return Buffer.concat([ourEcdh, enc]);
    }
    const p = this.pending;
    if (!p || body.length < 68) return null;
    this.pending = null;
    // The same counter, past our signature: theirs comes next in the stream.
    const sig = p.ctr.update(body.subarray(4, 68));
    let ok = false;
    try { ok = crypto.verify(null, Buffer.concat([p.theirEcdh, p.ourEcdh]), edPub(p.theirEd), sig); } catch (_) {}
    if (!ok) return null;
    this.secret = p.secret;
    return Buffer.alloc(0);
  }
}

module.exports = { loadIdentity, Pairing, sha512 };
