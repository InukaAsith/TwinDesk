// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Web Push from this computer to a web device's browser, with no server of our own: the browser's push
// service (Apple's for an iPhone's Home Screen app, Google's for Chrome, Mozilla's for Firefox) takes
// the message and wakes the page's service worker (web/sw.js), even when the page is closed.
//
// The message is encrypted for that browser alone (RFC 8291, aes128gcm): the push service carries it
// but can't read it. This computer signs who it is with a key of its own (VAPID, RFC 8292), kept in
// <dir>/vapid.pem.
//
// new WebPush(dir); .publicKey (base64url, for PushManager.subscribe)
// send(sub {endpoint, keys {p256dh, auth}}, payload object, {ttl, urgency, topic}) → Promise<{ok, gone, status}>
//   gone: the browser dropped the subscription (404/410): forget it.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// Who the push services may write to about this sender (RFC 8292 asks for a contact; Apple insists).
const SUBJECT = 'https://github.com/InukaAsith/TwinDesk';

class WebPush {
  constructor(dir) {
    const file = path.join(dir, 'vapid.pem');
    let pem = null;
    try { pem = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (!pem) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, pem, { mode: 0o600 });
    }
    this.key = crypto.createPrivateKey(pem);
    const jwk = crypto.createPublicKey(this.key).export({ format: 'jwk' });
    this.publicRaw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
    this.publicKey = b64u(this.publicRaw);
    this.jwts = new Map(); // audience -> {jwt, exp}
  }

  _jwt(aud) {
    const now = Math.floor(Date.now() / 1000);
    const hit = this.jwts.get(aud);
    if (hit && hit.exp - now > 3600) return hit.jwt;
    const exp = now + 12 * 3600;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp, sub: SUBJECT }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const jwt = `${head}.${body}.${b64u(sig)}`;
    this.jwts.set(aud, { jwt, exp });
    return jwt;
  }

  // RFC 8291: one record, the whole message.
  static encrypt(plain, p256dh, auth) {
    const ua = unb64u(p256dh);
    const secret = unb64u(auth);
    if (ua.length !== 65 || secret.length < 16) throw new Error('bad subscription keys');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const as = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(ua);
    const prkKey = hmac(secret, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
    const salt = crypto.randomBytes(16);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
    const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
  }

  send(sub, payload, { ttl = 3600, urgency = 'high', topic } = {}) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(sub.endpoint); } catch (_) { return resolve({ ok: false, gone: true, status: 0 }); }
      if (u.protocol !== 'https:') return resolve({ ok: false, gone: true, status: 0 });
      let body;
      try {
        // A push message holds about 4 KB: long text is cut (the page has the rest).
        body = WebPush.encrypt(Buffer.from(JSON.stringify(payload)), sub.keys && sub.keys.p256dh, sub.keys && sub.keys.auth);
      } catch (e) {
        return resolve({ ok: false, gone: true, status: 0, error: e.message });
      }
      const headers = {
        'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length,
        TTL: String(ttl), Urgency: urgency,
        Authorization: `vapid t=${this._jwt(u.origin)}, k=${this.publicKey}`,
      };
      if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      const req = https.request(u, { method: 'POST', headers, timeout: 15000 }, (res) => {
        res.resume();
        const s = res.statusCode;
        resolve({ ok: s >= 200 && s < 300, gone: s === 404 || s === 410, status: s });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ ok: false, gone: false, status: 0, error: e.message }));
      req.end(body);
    });
  }
}

module.exports = { WebPush };
