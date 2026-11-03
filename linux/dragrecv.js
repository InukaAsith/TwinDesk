// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A drag from the other computer across the edge while it drives this computer: `drag.start`
// (the whole tree), then `file.offer {drop:'drag', rel}` for every file. Port of
// windows/dragrecv.js as a drop into a folder: a Linux desktop lets only the app under a pressed
// button start a drag (Wayland), so nothing here can hand the files to any app the way Windows'
// virtual files do. The files stream into a temp folder; when the other computer's left button
// comes up here (kvm.js) the folder under the pointer is chosen (fm.js: a file manager window or
// the desktop; on Wayland the file manager window in front), else Downloads, and the tree goes
// there — never overwriting — each file as soon as it's complete. `drag.end` says how it went.
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { streamPressure, receiverHook } = require('../shared/fastfile.js');
const fm = require('./fm');
const { receivedDir } = require('../shared/received.js');

const T = P.T;
const MAX_FILES = 10000, MAX_DEPTH = 32;

// "Photos/2024/a.jpg" → safe segments, or null (.., empty, too deep). Names stay valid on a PC too.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4000) return null;
  const segs = rel.split('/');
  if (segs.length > MAX_DEPTH) return null;
  const out = [];
  for (let s of segs) {
    if (!s || s === '.' || s === '..') return null;
    s = s.replace(/[\x00-\x1f]/g, '_');
    out.push(s.slice(0, 200));
  }
  return out.join('/');
}

// "name.txt" → "name 2.txt", "name 3.txt"… if taken.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, base + ' ' + i + ext);
  return p;
}

class DragRecv {
  // opts: link, helper, settings (shared), isDriven(), popup(kind, text), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.root = path.join(app.getPath('userData'), 'drag');
    if (this.link && this.link.fx) this.link.fx.pressure((id) => { const f = this.cur && this.cur.byId.get(id); return streamPressure(f && f.out); });
    // Fast files v2 (shared/fx2.js): the files engine writes the file into its tmp; we finish it.
    if (this.link && this.link.fx && this.link.fx.receiver) {
      this.link.fx.receiver(receiverHook({
        find: (id) => { const f = this.cur && this.cur.byId.get(id); return f && f.state === 'arriving' ? f : null; },
        end: (f) => this._end({ t: T.FILE_END, id: f.id, sha256: '' }),
        fail: (f, why) => this._fail(f, why),
      }));
    }
    this.cur = null; // {drag, tmp, files: Map(rel → file), byId, dirs, items, count, name, state, dest, tops, placed}
    this.last = null; // {text, ok, at}
    this.homeUntil = 0; // kvm.home said the other computer's files follow as a drag here at home (expectHome)
    const link = this.link;
    link.on(T.DRAG_START, (m) => this._start(m));
    link.on(T.DRAG_CANCEL, (m) => this.cur && m.drag === this.cur.drag && this.cancel('cancelled'));
    link.on(T.FILE_OFFER, (m) => m.drop === 'drag' && this._offer(m));
    link.on(T.FILE_CHUNK, (m) => this._chunk(m));
    link.on(T.FILE_END, (m) => this._end(m));
    link.on(T.FILE_CANCEL, (m) => { const f = this.cur && this.cur.byId.get(m.id); if (f) this._fail(f, ''); });
    link.on('closed', () => this.cancel('cancelled'));
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
  }

  _start(m) {
    const end = (result) => this.link.send({ t: T.DRAG_END, drag: m.drag, result });
    if (typeof m.drag !== 'string' || !m.drag) return;
    if (this.cur) this.cancel('cancelled');
    const home = Date.now() < this.homeUntil; // its drag came over with the pointer, back home
    this.homeUntil = 0;
    if (!this.settings.files.edgeDrag || !this.settings.files.acceptFromMac || !(this.isDriven() || home)) return end('cancelled');
    const list = Array.isArray(m.list) ? m.list : [];
    const dirList = Array.isArray(m.dirs) ? m.dirs : [];
    if ((!list.length && !dirList.length) || list.length > MAX_FILES) return end('failed');
    const dirs = new Set();
    for (const d of dirList) { const r = safeRel(d); if (!r) return end('failed'); dirs.add(r); }
    const tmp = path.join(this.root, crypto.randomBytes(6).toString('hex'));
    const files = new Map();
    try {
      fs.mkdirSync(tmp, { recursive: true });
      for (const f of list) {
        const rel = f && safeRel(f.rel);
        if (!rel || !(f.size >= 0) || f.size > P.FILE_MAX_BYTES || files.has(rel)) return end('failed');
        files.set(rel, { rel, size: f.size, tmp: path.join(tmp, files.size + '.part'), id: null, got: 0, seq: 0, hash: null, out: null, state: 'waiting' });
      }
    } catch (_) { return end('failed'); }
    const tops = [...new Set([...files.keys(), ...dirs].map((r) => r.split('/')[0]))];
    const name = tops.length > 1 ? tops.length + ' items' : tops[0];
    this.cur = { drag: m.drag, tmp, files, byId: new Map(), dirs, count: tops.length, name, state: 'dragging', dest: '', tops: new Map(), placed: [], shown: false };
    if (this.popup) this.popup('driven', 'Drop ' + name + ' on a folder or the desktop');
    this.onChange();
  }

  // kvm.js: the pointer came home with the other computer's button held in a drag of its files: the
  // drag.start that follows is taken here, and our own button-up (the helper's `released`) drops it.
  expectHome() {
    this.homeUntil = Date.now() + 3000;
  }

  _offer(m) {
    const refuse = (why) => this.link.send({ t: T.FILE_REFUSE, id: m.id, why });
    const c = this.cur;
    if (typeof m.id !== 'string') return;
    if (!c || m.drag !== c.drag) return refuse('not_allowed');
    const f = c.files.get(safeRel(m.rel));
    if (!f || f.id || m.size !== f.size) return refuse('not_allowed');
    f.id = m.id;
    f.hash = crypto.createHash('sha256');
    f.out = fs.createWriteStream(f.tmp, { flags: 'w' });
    f.out.on('error', () => {}); // the checksum check fails instead
    f.state = 'arriving';
    c.byId.set(m.id, f);
    this.link.send({ t: T.FILE_ACCEPT, id: m.id });
  }

  _chunk(m) {
    const f = this.cur && this.cur.byId.get(m.id);
    if (!f || f.state !== 'arriving' || m.seq !== f.seq || (typeof m.data !== 'string' && !Buffer.isBuffer(m.data))) return;
    const buf = (typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : m.data); // a Buffer from fast files (shared/fastfile.js)
    if (f.got + buf.length > f.size) return this._fail(f, 'size mismatch'); // more than it offered: not written (it could fill the disk)
    f.seq++;
    f.got += buf.length;
    f.hash.update(buf);
    f.out.write(buf);
  }

  _end(m) {
    const c = this.cur;
    const f = c && c.byId.get(m.id);
    if (!f || f.state !== 'arriving') return;
    f.state = 'closing';
    f.out.end(() => {
      if (this.cur !== c) return;
      if (f.got !== f.size || (!f.verified && f.hash.digest('hex') !== m.sha256)) return this._fail(f, 'checksum mismatch');
      f.state = 'ok';
      if (c.dest) this._place(f);
    });
  }

  _fail(f, error) {
    const c = this.cur;
    if (f.out) f.out.destroy();
    f.state = 'failed';
    if (f.id && error) this.link.send({ t: T.FILE_DONE, id: f.id, ok: false, error });
    if (c && c.dest) this._check();
  }

  // Where rel goes in the chosen folder: its top item gets a free name ("Photos 2") once.
  _final(rel) {
    const c = this.cur;
    const segs = rel.split('/');
    if (!c.tops.has(segs[0])) {
      const top = uniquePath(c.dest, segs[0]);
      c.tops.set(segs[0], path.basename(top));
      c.placed.push(top);
    }
    return path.join(c.dest, c.tops.get(segs[0]), ...segs.slice(1));
  }

  _place(f) {
    try {
      const final = this._final(f.rel);
      fs.mkdirSync(path.dirname(final), { recursive: true });
      try { fs.renameSync(f.tmp, final); } catch (_) { fs.copyFileSync(f.tmp, final); fs.unlinkSync(f.tmp); } // another file system
      f.state = 'placed';
      this.link.send({ t: T.FILE_DONE, id: f.id, ok: true, path: final });
    } catch (e) {
      f.state = 'failed';
      this.link.send({ t: T.FILE_DONE, id: f.id, ok: false, error: e.message });
    }
    this._check();
  }

  // The other computer's left button came up here (kvm.js): choose the folder, put the folders
  // and every complete file there; the rest follow as they arrive.
  async onRelease() {
    const c = this.cur;
    if (!c || c.state !== 'dragging') return;
    c.state = 'placing';
    this.onChange();
    const r = await fm.at(this.helper);
    if (this.cur !== c) return;
    const folder = r && r.folder && fs.existsSync(r.folder) ? r.folder : '';
    c.dest = folder || receivedDir(this.settings, app.getPath('downloads'));
    c.shown = !!folder; // dropped on a folder that's on screen: nothing to reveal
    c.desktop = !!(r && r.desktop && folder);
    try {
      fs.mkdirSync(c.dest, { recursive: true });
      for (const d of [...c.dirs].sort((a, b) => a.split('/').length - b.split('/').length)) fs.mkdirSync(this._final(d), { recursive: true });
    } catch (_) { /* the files say how it went */ }
    for (const f of c.files.values()) if (f.state === 'ok') this._place(f);
    this._check();
  }

  get dragging() {
    return !!(this.cur && this.cur.state === 'dragging');
  }

  // Input went back to the other computer before the drop: the drag is cancelled there too
  // (files already being placed carry on).
  onHome() {
    if (this.dragging) this.cancel('cancelled');
  }

  // Every file placed (or failed) after the drop: done.
  _check() {
    const c = this.cur;
    if (!c || c.state !== 'placing' || !c.dest) return;
    const files = [...c.files.values()];
    if (files.some((f) => f.state !== 'placed' && f.state !== 'failed')) return this.onChange();
    const ok = files.every((f) => f.state === 'placed');
    this._finish(ok ? 'dropped' : 'failed');
  }

  // The other computer cancelled, or the link went away, or Esc: end the drag here.
  cancel(result) {
    if (!this.cur) return;
    this._finish(result);
  }

  _finish(result) {
    const c = this.cur;
    this.cur = null;
    const where = result === 'dropped' ? (c.desktop ? 'Desktop' : c.dest) : '';
    this.link.send(where ? { t: T.DRAG_END, drag: c.drag, result, where } : { t: T.DRAG_END, drag: c.drag, result });
    for (const f of c.files.values()) {
      if (f.out) f.out.destroy();
      if (f.id && f.state !== 'placed' && f.state !== 'failed') this.link.send({ t: T.FILE_DONE, id: f.id, ok: false, error: result });
    }
    if (result === 'dropped' && !c.shown && c.placed.length) fm.showItems(c.placed);
    this.last = { ok: result === 'dropped', text: result === 'dropped' ? c.name + ' dropped in ' + (where === 'Desktop' ? 'Desktop' : path.basename(where) || where) : c.name + ': ' + result, at: Date.now() };
    fs.rm(c.tmp, { recursive: true, force: true }, () => {});
    this.onChange();
  }

  view() {
    const c = this.cur;
    return c ? { state: c.state === 'placing' ? 'copying' : c.state, name: c.name, last: this.last } : { state: '', last: this.last };
  }
}

module.exports = DragRecv;
