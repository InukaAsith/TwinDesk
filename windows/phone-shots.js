// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screenshots both ways with a phone, onto the other device's clipboard (clip.image, the format of
// shared/clipsync.js: a PNG with its id, width and height).
//   This PC's: Win+Shift+S, PrtScn and the Snipping Tool save each one in Pictures › Screenshots, so
//   a new picture there goes to the phone while it is connected and Clipboard › "Screenshots go to
//   {phone}" is on. The phone puts it on its clipboard (and saves it only if set to there).
//   The phone's: a screenshot taken there arrives here and goes on this clipboard (paste with
//   Ctrl+V), saved in Pictures › TwinDesk only with Clipboard › "Also save {phone}’s screenshots".
//   Pictures › TwinDesk is outside Screenshots, so nothing goes back round.
// Not through Bluetooth: a picture is megabytes, and the session's link there is kept for the small
// things (the phone sends nothing over it either). One-to-one only: an item carries no `o` (that is
// the pool's, in Multi-device), as a plain `clip` doesn't.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');
const P = require('../shared/protocol.js');
const { imageMessage, readImage } = require('../shared/clipsync.js');

const T = P.T;
const FRESH_MS = 30000; // older files (synced in, copied over) aren't screenshots just taken
const SETTLE_MS = 600; // a new file is written in a moment: sent once it stops changing
const isPhone = (c) => !!c && c.os === P.OS.ANDROID;
const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;

class PhoneShots {
  // server: phone-link.js; clip: clip.js (the phone's clip.policy); getSettings(); popup(kind, text)
  constructor({ server, clip, getSettings, popup }) {
    Object.assign(this, { server, clip, getSettings, popup });
    this.watcher = null;
    this.timers = new Map();
    this.sent = new Set(); // files sent already (Windows reports a new file more than once)
    server.on(`t:${T.CLIP_IMAGE}`, (m, ctx) => this._fromPhone(m, ctx));
    // Pictures is watched only while a phone is connected.
    server.on('client', () => this._watch());
    server.on('closed', () => this._watch());
  }

  get cfg() {
    return this.getSettings().clipboard || {};
  }

  _watch() {
    const on = isPhone(this.server.current);
    if (on && !this.watcher) {
      try {
        // All of Pictures, so a Screenshots folder Windows makes later is seen too.
        this.watcher = fs.watch(app.getPath('pictures'), { recursive: true }, (_ev, file) => file && this._seen(String(file)));
        this.watcher.on('error', (e) => { console.log(`[shots] ${e.message}`); this._stop(); });
      } catch (e) {
        console.log(`[shots] can't watch Pictures: ${e.message}`);
      }
    } else if (!on) {
      this._stop();
    }
  }

  _stop() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // Pictures › Screenshots › *.png | *.jpg, once the file has settled.
  _seen(rel) {
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'screenshots' || !/\.(png|jpe?g)$/i.test(parts[1])) return;
    const file = path.join(app.getPath('pictures'), parts[0], parts[1]);
    clearTimeout(this.timers.get(file));
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file);
      try { this._send(file); } catch (e) { console.log(`[shots] ${e.message}`); }
    }, SETTLE_MS));
  }

  // One of this PC's screenshots to the phone, as a PNG of at most CLIP_IMAGE_MAX_BYTES.
  _send(file) {
    const c = this.cfg;
    const phone = this.server.current;
    if (!c.enabled || !c.send || !c.screenshots || !isPhone(phone) || phone.transport === 'ble') return;
    if (this.clip && this.clip.peerAccepts === false) return; // the phone's clipboard doesn't take ours
    if (this.sent.has(file)) return;
    let st;
    try { st = fs.statSync(file); } catch (_) { return; }
    if (!st.isFile() || !st.size || Date.now() - st.mtimeMs > FRESH_MS) return;
    if (this.sent.size > 200) this.sent.clear();
    this.sent.add(file);
    const buf = fs.readFileSync(file);
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return;
    let { width, height } = img.getSize();
    let png = isPng(buf) ? buf : img.toPNG();
    // Too big for one item (a very large screen): smaller until it fits.
    for (let i = 0; png.length > P.CLIP_IMAGE_MAX_BYTES && i < 4; i++) {
      const k = Math.sqrt(P.CLIP_IMAGE_MAX_BYTES / png.length) * 0.9;
      img = img.resize({ width: Math.max(1, Math.round(width * k)), quality: 'better' });
      ({ width, height } = img.getSize());
      png = img.toPNG();
    }
    const msg = imageMessage({ id: P.randomHex(8), w: width, h: height, png }, { ts: Date.now() });
    if (!msg) return;
    delete msg.o; // one-to-one: no origin (Multi-device's pool adds it)
    this.server.sendToClient(msg);
    this.popup('away', `Screenshot copied on ${phone.name || 'the phone'}`);
  }

  // A screenshot taken on the phone: on this clipboard while the clipboard comes in from it.
  _fromPhone(m, ctx) {
    if (!isPhone(ctx)) return; // a computer's clip.image isn't a phone screenshot (nor handled here)
    const c = this.cfg;
    if (!c.enabled || !c.receive) return;
    const shot = readImage(m);
    if (!shot) return;
    const img = nativeImage.createFromBuffer(shot.png);
    if (img.isEmpty()) return;
    clipboard.writeImage(img);
    const phone = ctx.name || 'the phone';
    let saved = '';
    if (c.saveScreenshots) {
      try {
        this._save(`${phone} ${stamp(new Date())}`, shot.png);
        saved = ', and saved in Pictures › TwinDesk';
      } catch (e) {
        console.log(`[shots] not saved: ${e.message}`);
      }
    }
    this.popup('driven', `Screenshot from ${phone} copied${saved}: paste it with Ctrl+V`);
  }

  // Into Pictures › TwinDesk under a name of its own (never over another file).
  _save(base, png) {
    const dir = path.join(app.getPath('pictures'), 'TwinDesk');
    fs.mkdirSync(dir, { recursive: true });
    const clean = String(base).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'Phone';
    let file = path.join(dir, `${clean}.png`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${clean} (${i}).png`);
    fs.writeFileSync(file, png);
    return file;
  }
}

// 2026-10-24 13.05.12
function stamp(t) {
  const two = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}.${two(t.getMinutes())}.${two(t.getSeconds())}`;
}

module.exports = { PhoneShots };
