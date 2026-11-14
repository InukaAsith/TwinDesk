// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard and notification history kept on this computer, encrypted, when the person turns it on
// (settings.history.save, off at first; settings.history.days, how long: 1, 7, 30 or 365).
//
// No keychain prompt at start (macOS asks each time an app reads its keychain item when the app's
// signature changed, and a Linux keyring may ask to be unlocked): writing never needs the keychain.
// The file is a log of sealed records, one a line: {t, k, n, c} — t the newest item's time (so old
// lines can go without opening them), and the items sealed to this computer's public key (an X25519
// key agreement with a key made for that line, then AES-256-GCM). The private key is kept wrapped by
// the system's safe storage (Electron's safeStorage: the keychain, DPAPI, the keyring) and is
// unwrapped only by unlock(), which the app calls when the person opens a history: then all lines
// are read, merged with this session's, the old ones dropped, and the file written again in one line.
//
// new HistKeep({dir, name, wrap: {encrypt(buf) → buf, decrypt(buf) → buf}})
//   add(items): seals and appends (when on). unlock() → items (newest first) or throws.
//   setOn(on, days): turning on makes the key pair (wrap.encrypt once); off removes the file and keys.
//   clear(): the saved history goes. days: how long items are kept.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const DAYS = [1, 7, 30, 365];

class HistKeep {
  constructor({ dir, name, wrap, max = 2000 }) {
    this.file = path.join(dir, `${name}.hist`);
    this.keyFile = path.join(dir, `${name}.key`);
    this.wrap = wrap;
    this.max = max;
    this.on = false;
    this.days = 7;
    this.unlocked = null; // the items once unlocked this session
  }

  // The settings (settings.history), at start and when they change.
  setOn(on, days) {
    this.days = DAYS.includes(Number(days)) ? Number(days) : 7;
    if (on && !this.on) {
      this.on = true;
      if (!this._pub()) this._makeKeys();
    } else if (!on && this.on) {
      this.on = false;
      this.forget();
    } else this.on = !!on;
  }

  // The public key (plain, in the key file); null when there's none yet.
  _pub() {
    try {
      const k = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      return crypto.createPublicKey({ key: Buffer.from(k.pub, 'base64'), format: 'der', type: 'spki' });
    } catch (_) { return null; }
  }

  _makeKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' });
    const wrapped = this.wrap.encrypt(priv).toString('base64');
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, JSON.stringify({ v: 1, pub, priv: wrapped }), { mode: 0o600 });
  }

  _seal(items) {
    const pub = this._pub();
    if (!pub) throw new Error('no key');
    const eph = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
    const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('twindesk history'), 32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
    const body = Buffer.concat([c.update(JSON.stringify(items), 'utf8'), c.final(), c.getAuthTag()]);
    return { k: eph.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), n: iv.toString('base64'), c: body.toString('base64') };
  }

  _open(rec, priv) {
    const eph = crypto.createPublicKey({ key: Buffer.from(rec.k, 'base64'), format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: eph });
    const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('twindesk history'), 32);
    const body = Buffer.from(rec.c, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(rec.n, 'base64'));
    d.setAuthTag(body.subarray(body.length - 16));
    return JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8'));
  }

  // New items (each with at, ms): sealed and added to the file. Nothing when it's off.
  add(items) {
    if (!this.on || !items || !items.length) return;
    const list = items.filter((x) => x && Number(x.at)).map((x) => ({ ...x }));
    if (!list.length) return;
    try {
      const rec = { t: Math.max(...list.map((x) => Number(x.at))), ...this._seal(list) };
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
      if (this.unlocked) this.unlocked = merge(list, this.unlocked, this.max);
    } catch (_) { /* not kept this time */ }
  }

  // Everything kept (newest first), reading the private key once a session; then the file is
  // written again as one line without what's older than days.
  unlock() {
    if (!this.on) return [];
    if (this.unlocked) return this.unlocked.filter((x) => x.at >= Date.now() - this.days * DAY);
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch (_) { /* none yet */ }
    const since = Date.now() - this.days * DAY;
    let items = [];
    if (lines.length) {
      const k = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      const priv = crypto.createPrivateKey({ key: this.wrap.decrypt(Buffer.from(k.priv, 'base64')), format: 'der', type: 'pkcs8' });
      for (const l of lines) {
        try {
          const rec = JSON.parse(l);
          if (Number(rec.t) < since) continue;
          items = merge(this._open(rec, priv), items, Infinity);
        } catch (_) { /* a broken line: skipped */ }
      }
    }
    items = items.filter((x) => Number(x.at) >= since).slice(0, this.max);
    this.unlocked = items;
    this._compact();
    return items;
  }

  // Old lines go without opening them (their t), at start and now and then.
  prune() {
    if (!this.on) return;
    const since = Date.now() - this.days * DAY;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const keep = lines.filter((l) => { try { return Number(JSON.parse(l).t) >= since; } catch (_) { return false; } });
      if (keep.length !== lines.length) fs.writeFileSync(this.file, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
    } catch (_) { /* none */ }
  }

  _compact() {
    try {
      if (!this.unlocked.length) { fs.rmSync(this.file, { force: true }); return; }
      const rec = { t: Math.max(...this.unlocked.map((x) => Number(x.at))), ...this._seal(this.unlocked) };
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (_) { /* the log stays as it was */ }
  }

  clear() {
    this.unlocked = this.on ? [] : null;
    try { fs.rmSync(this.file, { force: true }); } catch (_) { /* gone */ }
  }

  // Off: the saved history and the keys go.
  forget() {
    this.unlocked = null;
    for (const f of [this.file, this.keyFile]) { try { fs.rmSync(f, { force: true }); } catch (_) { /* gone */ } }
  }
}

// Newest first, the same item (its id, else its time and text) once.
function merge(a, b, max) {
  const seen = new Set();
  const out = [];
  for (const x of [...a, ...b].sort((p, q) => Number(q.at) - Number(p.at))) {
    const k = x.id ? 'i' + x.id : 't' + x.at + ':' + (x.text || x.title || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

// Electron's safeStorage as the wrap (asked for only when called).
function safeWrap() {
  const ss = () => require('electron').safeStorage;
  return {
    encrypt: (buf) => ss().encryptString(buf.toString('base64')),
    decrypt: (buf) => Buffer.from(ss().decryptString(buf), 'base64'),
  };
}

module.exports = { HistKeep, merge, safeWrap, DAYS };
