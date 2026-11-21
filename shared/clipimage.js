// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard pictures between the two devices of a session (one-to-one: a computer with a computer
// or a phone). A PNG of up to CLIP_IMAGE_MAX_BYTES goes as clip.image {id, w, h, bytes, parts,
// shot?} followed by `parts` clip.image.part {id, i, data}, each piece at most
// CLIP_IMAGE_PART_BYTES and sent as the socket drains, so the mouse and keys never wait behind a
// picture. A clip.image with the picture inline (png: base64, Multi-device's form) is taken too.
// A newer copy, text or picture, replaces one still on its way.
//
// ImageOut / ImageIn are pure (no Electron). pngOf(), sigOf() take Electron NativeImages.
'use strict';

const crypto = require('crypto');
const P = require('./protocol.js');

const T = P.T;
const MAX = P.CLIP_IMAGE_MAX_BYTES;
const PART = P.CLIP_IMAGE_PART_BYTES;
const HIGH_WATER = 512 * 1024; // bytes waiting on the socket before the next piece
const STALE_MS = 60000; // a picture still missing pieces after this long is dropped
const MAX_ID = 128;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPng = (b) => !!b && b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;
const dim = (v) => Math.max(0, Math.min(65535, v | 0));

class ImageOut {
  // send(msg) → bool; backlog() → bytes waiting on the socket; open() → still fine to send
  constructor({ send, backlog, open }) {
    this.sendFn = send;
    this.backlog = backlog || (() => 0);
    this.open = open || (() => true);
    this.current = null;
  }

  // A PNG (Buffer) to the other side. True once every piece went; false when a newer copy took
  // its place, the session went or it is too big.
  // stamp {ts, o}: when and where it was copied (shared/clipsync.js Latest, Multi-device).
  async send(png, { w, h, shot, stamp } = {}) {
    if (!isPng(png) || png.length > MAX) return false;
    const me = { id: crypto.randomBytes(8).toString('hex') };
    this.current = me;
    const parts = Math.ceil(png.length / PART);
    const live = () => this.current === me && this.open();
    const head = { t: T.CLIP_IMAGE, id: me.id, w: dim(w), h: dim(h), bytes: png.length, parts };
    if (shot) head.shot = true;
    if (stamp) Object.assign(head, { ts: stamp.ts, o: stamp.o });
    try {
      if (!live() || this.sendFn(head) === false) return this._done(me, false);
      for (let i = 0; i < parts; i++) {
        while (this.backlog() > HIGH_WATER) {
          if (!live()) return this._done(me, false);
          await sleep(15);
        }
        if (!live()) return this._done(me, false);
        if (this.sendFn({ t: T.CLIP_IMAGE_PART, id: me.id, i, data: png.subarray(i * PART, (i + 1) * PART).toString('base64') }) === false) return this._done(me, false);
      }
      return this._done(me, true);
    } catch (_) {
      return this._done(me, false);
    }
  }

  // A newer copy (or the session ended): what is still going stops.
  cancel() {
    this.current = null;
  }

  get busy() {
    return !!this.current;
  }

  _done(me, ok) {
    if (this.current === me) this.current = null;
    return ok;
  }
}

class ImageIn {
  constructor(now = Date.now) {
    this.now = now;
    this.cur = null;
  }

  // A clip.image: the picture {id, w, h, png, shot} when it came whole (inline), else null while
  // its pieces are on the way.
  header(m) {
    this.cur = null;
    if (!m || typeof m.id !== 'string' || !m.id || m.id.length > MAX_ID) return null;
    const stamp = Number.isFinite(m.ts) && typeof m.o === 'string' ? { ts: m.ts, o: m.o } : {}; // when and where it was copied
    if (typeof m.png === 'string') {
      if (!m.png || m.png.length > Math.ceil(MAX * 4 / 3) + 8) return null;
      const png = Buffer.from(m.png, 'base64');
      return png.length <= MAX && isPng(png) ? { id: m.id, w: dim(m.w), h: dim(m.h), png, shot: m.shot === true, ...stamp } : null;
    }
    const bytes = Number(m.bytes);
    const parts = Number(m.parts);
    if (!Number.isInteger(bytes) || bytes < 9 || bytes > MAX || parts !== Math.ceil(bytes / PART)) return null;
    this.cur = { id: m.id, w: dim(m.w), h: dim(m.h), bytes, parts, shot: m.shot === true, bufs: [], got: 0, size: 0, at: this.now(), ...stamp };
    return null;
  }

  // A clip.image.part: the picture once its last piece is in, else null.
  part(m) {
    const c = this.cur;
    if (!c || !m || m.id !== c.id) return null;
    // Out of order, too big, or too slow: the picture is dropped.
    if (m.i !== c.got || typeof m.data !== 'string' || m.data.length > Math.ceil(PART * 4 / 3) + 8 || this.now() - c.at > STALE_MS) {
      this.cur = null;
      return null;
    }
    const b = Buffer.from(m.data, 'base64');
    c.size += b.length;
    if (c.size > c.bytes || (c.got + 1 < c.parts && b.length !== PART)) {
      this.cur = null;
      return null;
    }
    c.bufs.push(b);
    c.got++;
    if (c.got < c.parts) return null;
    this.cur = null;
    const png = Buffer.concat(c.bufs, c.size);
    return png.length === c.bytes && isPng(png) ? { id: c.id, w: c.w, h: c.h, png, shot: c.shot, ...(c.o ? { ts: c.ts, o: c.o } : {}) } : null;
  }

  // A newer copy came (or the session ended): a picture half in is dropped.
  drop() {
    this.cur = null;
  }
}

// An Electron NativeImage as a PNG of at most CLIP_IMAGE_MAX_BYTES: {png, w, h}, made smaller
// while it is too big (a very large screen or photo), or null.
function pngOf(img) {
  if (!img || img.isEmpty()) return null;
  let { width, height } = img.getSize();
  let png = img.toPNG();
  for (let i = 0; png.length > MAX && i < 5; i++) {
    const k = Math.sqrt(MAX / png.length) * 0.9;
    img = img.resize({ width: Math.max(1, Math.round(width * k)), quality: 'better' });
    ({ width, height } = img.getSize());
    png = img.toPNG();
  }
  return png.length <= MAX && png.length > 0 ? { png, w: width, h: height } : null;
}

// What a picture looks like, small: the same picture read back from a clipboard (which may have
// re-encoded it) gives the same signature, so one that came in is never sent back.
function sigOf(img) {
  if (!img || img.isEmpty()) return '';
  const { width, height } = img.getSize();
  const small = img.resize({ width: 16, height: 16, quality: 'good' }).toBitmap();
  // Rounded off: a few levels of difference from a colour profile or a lost alpha still match.
  const q = Buffer.alloc(small.length);
  for (let i = 0; i < small.length; i++) q[i] = small[i] >> 4;
  return `${width}x${height}:${crypto.createHash('sha1').update(q).digest('hex').slice(0, 16)}`;
}

// The clipboard's picture as a NativeImage (empty when it holds none), and a PNG put on it. Electron
// 44 (the Mac) has no readImage/writeImage: there it's read() and write() with a ClipboardItem.
async function readClipImage(clipboard, nativeImage) {
  if (typeof clipboard.readImage === 'function') return clipboard.readImage();
  for (const item of await clipboard.read()) {
    if (!item.types.includes('image/png')) continue;
    const blob = await item.getType('image/png');
    return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
  }
  return nativeImage.createEmpty();
}

async function writeClipImage(clipboard, img, png) {
  if (typeof clipboard.writeImage === 'function') return clipboard.writeImage(img);
  const { ClipboardItem } = require('electron');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

// The picture half of a computer's one-to-one clipboard (windows/clip.js, linux/clip.js,
// mac/clipboard.js keep the text): Clipboard › Pictures (settings.clipboard.images) both ways,
// only with a peer whose clip.policy says images, never through Bluetooth. Text wins: a copy
// with text in it (a spreadsheet's cells come as a picture too) goes as text. A screenshot goes
// when it is put on the clipboard (Win+Shift+S, ⌃⇧⌘4, the desktop's screenshot tool), as any
// picture; a phone's own screenshots come marked `shot` (Screenshots.kt).
class ClipImages {
  // o: {cfg() → settings.clipboard, send(msg), backlog(), connected(), ble(), peerName(),
  //     remember(dir, item), popup(kind, text), onChange(), pasteKeys ('Ctrl+V' | '⌘V'), clipboard (default Electron's)}
  get nativeImage() { return require('electron').nativeImage; }

  constructor(o) {
    this.o = o;
    // Electron's only when needed: a test (plain Node, no electron) gives its own clipboard and sends no pictures.
    this.clipboard = o.clipboard || require('electron').clipboard;
    this.peerImages = false; // the other side's clip.policy: it takes pictures
    this.sig = { sent: '', received: '' }; // the last picture each way (sigOf)
    this.out = new ImageOut({ send: o.send, backlog: o.backlog, open: () => this.canSend });
    this.in = new ImageIn();
  }

  get on() {
    const c = this.o.cfg();
    return !!(c.enabled && c.images);
  }

  // What our clip.policy says about pictures.
  get accept() {
    const c = this.o.cfg();
    return !!(this.on && c.receive);
  }

  get canSend() {
    const c = this.o.cfg();
    return !!(this.on && c.send && this.peerImages && this.o.connected() && !this.o.ble());
  }

  policy(m) {
    this.peerImages = !!m && m.images === true;
  }

  // The session ended or began again.
  reset() {
    this.peerImages = false;
    this.out.cancel();
    this.in.drop();
  }

  // A text copy went or came: a picture still on its way is out of date.
  text() {
    this.out.cancel();
    this.in.drop();
  }

  header(m) {
    this._got(this.in.header(m)).catch((e) => console.error('[clip] picture not copied:', e.message));
  }

  part(m) {
    this._got(this.in.part(m)).catch((e) => console.error('[clip] picture not copied:', e.message));
  }

  _read() {
    return readClipImage(this.clipboard, this.nativeImage);
  }

  // The clipboard holds no text: its picture, if there is one and it's new, goes over. Returns
  // what happened: '' (nothing to do), 'sent', or why not (for the tab's note).
  async offerClipboard(concealed) {
    if (!this.canSend) return '';
    const img = await this._read();
    if (img.isEmpty()) return '';
    const sig = sigOf(img);
    if (sig === this.sig.sent || sig === this.sig.received) return '';
    this.sig.sent = sig;
    if (concealed) return 'skipped a picture marked private';
    return this._send(img);
  }

  async _send(img) {
    const p = pngOf(img);
    if (!p) return 'skipped a picture over ' + Math.round(MAX / 1048576) + ' MB';
    const ok = await this.out.send(p.png, { w: p.w, h: p.h });
    if (!ok) return '';
    this.o.remember('out', this._item(p, img, false));
    this.o.onChange();
    return 'sent';
  }

  async _got(pic) {
    if (!pic || !this.accept) return;
    const img = this.nativeImage.createFromBuffer(pic.png);
    if (img.isEmpty()) return;
    this.out.cancel(); // theirs is newer than a picture of ours still going
    // Before the clipboard changes: the watcher's read of it must already know it came in.
    this.sig.received = sigOf(img);
    if (this.o.onReceiveStart) this.o.onReceiveStart();
    let written = false;
    try {
      await writeClipImage(this.clipboard, img, pic.png);
      written = true;
      // As the clipboard holds it now (it may re-encode it): never sent back.
      this.sig.received = sigOf(await this._read()) || sigOf(img);
      this.o.remember('in', this._item({ png: pic.png, w: pic.w || img.getSize().width, h: pic.h || img.getSize().height }, img, pic.shot));
      this.o.popup('driven', `${pic.shot ? 'Screenshot' : 'Picture'} from ${this.o.peerName()} copied: paste it with ${this.o.pasteKeys || 'Ctrl+V'}`, { key: pic.shot ? 'Screenshot from {name} copied: paste it with {keys}' : 'Picture from {name} copied: paste it with {keys}', vars: { name: this.o.peerName(), keys: this.o.pasteKeys || 'Ctrl+V' } });
      this.o.onChange();
    } finally {
      if (this.o.onReceiveEnd) this.o.onReceiveEnd(written);
    }
  }

  // A Recent item: a small preview, and the picture itself to copy again.
  _item(p, img, shot) {
    let thumb = '';
    try { thumb = img.resize({ height: 40, quality: 'good' }).toDataURL(); } catch (_) { /* no preview */ }
    return { image: true, png: p.png, w: p.w, h: p.h, size: p.png.length, thumb, shot: !!shot };
  }

  // A Recent picture back on the clipboard. dir 'out': it goes over again by the normal rules.
  async copy(item, dir) {
    if (!item || !item.png) return;
    const img = this.nativeImage.createFromBuffer(item.png);
    if (img.isEmpty()) return;
    if (dir !== 'out') this.sig.received = sigOf(img);
    await writeClipImage(this.clipboard, img, item.png);
    if (dir === 'out') this.sig.sent = '';
    else this.sig.received = sigOf(await this._read()) || sigOf(img);
  }
}

// Multi-device (mac|windows|linux/mesh clipboard): the same pictures with every connected device.
// Each device has its own clip.policy (images: it takes them), its own sender and receiver; a
// picture goes straight to each device that takes pictures (not relayed by the pool), never over
// Bluetooth. o, as ClipImages', with: ids() → connected device ids, send(id, msg), backlog(id),
// ble(id), peerName(id), remember(dir, item, fromName), log(line) (default console.log), and the
// text's Latest (shared/clipsync.js) so the latest copy wins between a text and a picture too:
// copied() → {ts, o} for a picture copied here, newest(pic) → false for one older than the newest copy.
// sendsTo(id) / takes(id), optional: our pair with that device (shared/consent.js), else the settings' Send
// and Receive for every device.
// Every picture copied here or come in is logged ([clip]): where it went, or why it stayed.
class MeshClipImages extends ClipImages {
  constructor(o) {
    super({ ...o, send: () => false, connected: () => false, ble: () => true, peerName: () => '' });
    // Those stubs are for the base class's one-device sender only; everything here asks per device.
    // Kept as this.o, they made every device 'over Bluetooth' and every send fail: Multi-device never
    // sent a picture, and named every sender 'another device'.
    this.o = o;
    this.peers = new Map(); // id → {images, out: ImageOut, in: ImageIn}
    this.log = o.log || ((line) => console.log(line));
    this.kept = ''; // the last picture that stayed here (sigOf): logged once
  }
  _name(id) {
    return this.o.peerName(id) || String(id).slice(0, 8);
  }
  _sendsTo(id) {
    return this.o.sendsTo ? this.o.sendsTo(id) : !!this.o.cfg().send;
  }
  _takesFrom(id) {
    return this.o.takes ? this.o.takes(id) : !!this.o.cfg().receive;
  }
  // Why a picture copied here doesn't go to a device (or to any): for the log.
  why(id) {
    const c = this.o.cfg();
    if (!this.on) return 'Pictures is off here';
    if (id === undefined ? !(this.o.sendsTo ? this.o.ids().some((x) => this._sendsTo(x)) : c.send) : !this._sendsTo(id)) return 'sending the clipboard is off here';
    if (id === undefined) {
      const ids = this.o.ids();
      return ids.length ? ids.map((x) => `${this._name(x)}: ${this.why(x)}`).join('; ') : 'no connected device takes this computer’s clipboard';
    }
    if (this.o.ble(id)) return 'over Bluetooth';
    return (this.peers.get(id) || {}).images ? 'takes pictures' : 'Pictures is off there (or an older TwinDesk)';
  }
  // No device takes it: the picture stays here, and the log says why (once per picture).
  async offerClipboard(concealed) {
    if (this.canSend) return super.offerClipboard(concealed);
    const img = await this._read();
    if (img.isEmpty()) return '';
    const sig = sigOf(img);
    if (sig === this.kept || sig === this.sig.sent || sig === this.sig.received) return '';
    this.kept = sig;
    const { width, height } = img.getSize();
    this.log(`[clip] a picture copied here (${width}x${height}) stays here: ${this.why()}`);
    return '';
  }
  _peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      p = { images: false, in: new ImageIn() };
      p.out = new ImageOut({ send: (m) => this.o.send(id, m), backlog: () => this.o.backlog(id), open: () => this._takes(id) });
      this.peers.set(id, p);
    }
    return p;
  }
  _takes(id) {
    const p = this.peers.get(id);
    return !!(this.on && this._sendsTo(id) && p && p.images && this.o.ids().includes(id) && !this.o.ble(id));
  }
  get targets() {
    return this.o.ids().filter((id) => this._takes(id));
  }
  get canSend() {
    return this.targets.length > 0;
  }
  // Some connected device takes pictures (the Clipboard tab's note).
  get peerImages() {
    return this.o.ids().some((id) => (this.peers.get(id) || {}).images === true);
  }
  set peerImages(_) { /* per device here */ }
  policy(m, id) {
    if (id) this._peer(id).images = !!m && m.images === true;
  }
  reset(id) {
    const p = id && this.peers.get(id);
    if (!p) return;
    p.images = false;
    p.out.cancel();
    p.in.drop();
  }
  text() {
    for (const p of this.peers.values()) { p.out.cancel(); p.in.drop(); }
  }
  header(m, from) {
    if (!from) return;
    this._gotFrom(this._peer(from).in.header(m), from).catch((e) => console.error('[clip] picture not copied:', e.message));
  }
  part(m, from) {
    if (!from) return;
    const p = this._peer(from);
    const had = p.in.cur;
    const pic = p.in.part(m);
    if (had && !pic && !p.in.cur) this.log(`[clip] a picture from ${this._name(from)} was dropped at piece ${had.got + 1} of ${had.parts} (out of order, too slow or a wrong size)`);
    this._gotFrom(pic, from).catch((e) => console.error('[clip] picture not copied:', e.message));
  }
  async _send(img) {
    const p = pngOf(img);
    if (!p) return 'skipped a picture over ' + Math.round(MAX / 1048576) + ' MB';
    const ids = this.targets;
    const others = this.o.ids().filter((id) => !ids.includes(id));
    const stamp = this.o.copied ? this.o.copied() : undefined;
    const went = await Promise.all(ids.map((id) => this._peer(id).out.send(p.png, { w: p.w, h: p.h, stamp })));
    const ok = went.some(Boolean);
    this.log(`[clip] picture ${p.w}x${p.h}, ${Math.round(p.png.length / 1024)} KB: ` +
      ids.map((id, i) => `${this._name(id)} ${went[i] ? 'sent' : 'not sent (a newer copy, or it left)'}`).join(', ') +
      (others.length ? '; not to ' + others.map((id) => `${this._name(id)} (${this.why(id)})`).join(', ') : ''));
    if (!ok) return '';
    this.o.remember('out', this._item(p, img, false), '');
    this.o.onChange();
    return 'sent';
  }
  async _gotFrom(pic, from) {
    if (!pic) return;
    const what = `[clip] ${pic.shot ? 'screenshot' : 'picture'} ${pic.w}x${pic.h}, ${Math.round(pic.png.length / 1024)} KB from ${this._name(from)}`;
    if (!this.on || !this._takesFrom(from)) return void this.log(`${what}: not taken, ${this.on ? 'receiving the clipboard is off here' : 'Pictures is off here'}`);
    const img = this.nativeImage.createFromBuffer(pic.png);
    if (img.isEmpty()) return void this.log(`${what}: not a picture this computer can read`);
    if (this.o.newest && !this.o.newest(pic)) return void this.log(`${what}: older than the newest copy here, not applied`);
    for (const p of this.peers.values()) p.out.cancel(); // theirs is newer than a picture of ours still going
    this.sig.received = sigOf(img);
    if (this.o.onReceiveStart) this.o.onReceiveStart();
    let written = false;
    try {
      await writeClipImage(this.clipboard, img, pic.png);
      written = true;
      this.sig.received = sigOf(await this._read()) || sigOf(img);
      this.log(`${what}: on the clipboard`);
      const name = this.o.peerName(from) || 'another device';
      this.o.remember('in', this._item({ png: pic.png, w: pic.w || img.getSize().width, h: pic.h || img.getSize().height }, img, pic.shot), name);
      this.o.popup('driven', `${pic.shot ? 'Screenshot' : 'Picture'} from ${name} copied: paste it with ${this.o.pasteKeys || 'Ctrl+V'}`, { key: pic.shot ? 'Screenshot from {name} copied: paste it with {keys}' : 'Picture from {name} copied: paste it with {keys}', vars: { name, keys: this.o.pasteKeys || 'Ctrl+V' } });
      this.o.onChange();
    } finally {
      if (this.o.onReceiveEnd) this.o.onReceiveEnd(written);
    }
  }
}

// Recent items keep at most this many pictures to copy again (each up to 10 MB); older picture
// items stay listed without one.
const KEEP_PICTURES = 5;
function trimPictures(history) {
  let n = 0;
  for (const h of history) if (h.png && ++n > KEEP_PICTURES) h.png = null;
}

// A Recent item for the tab: text cut short, a picture by its preview.
function itemView(h, preview) {
  if (h.image) return { dir: h.dir, at: h.at, size: h.size, text: '', image: { w: h.w, h: h.h, thumb: h.thumb, shot: h.shot, copy: !!h.png } };
  return { dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, preview) };
}

module.exports = { ImageOut, ImageIn, ClipImages, MeshClipImages, pngOf, sigOf, isPng, trimPictures, itemView, readClipImage, writeClipImage };
