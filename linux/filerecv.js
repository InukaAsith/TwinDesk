// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files from the other computer (copy of windows/filerecv.js): `file.offer {drop:'release'}`
// waits in a temp folder until the other computer's left button comes up here, then goes to the
// file manager folder under the pointer (fm.js), else Downloads — never overwriting — and is shown
// in the file manager. `drop:'send'` / `'paste'` batches (Send files, the paste shortcut): every file
// with its `rel` path straight into Downloads or the folder chosen at paste time, then `files.done`.
const { app, shell } = require('electron');
const fm = require('./fm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { receivedDir } = require('../shared/received.js');

const T = P.T;

class FileRecv {
  // opts: link, helper, settings (shared), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.dir = path.join(app.getPath('userData'), 'incoming');
    this.files = new Map(); // id → {name, size, got, seq, hash, out, tmp, done, released}
    this.target = null;     // folder chosen at release time for this drag
    this.last = null;       // {name, ok, text, at} for the Files tab
    this.batches = new Map(); // Batch → {kind, dir, count, done, ok, tops: Map, placed: []}
    this.bfiles = new Map();  // id → batch file {id, batch, name, size, final, tmp, got, seq, hash, out}
    this.expected = new Map(); // batch (fclip id) → {dir, bytes} chosen when this PC pasted
    const link = this.link;
    link.on(T.FILE_OFFER, (m) => this._offer(m));
    link.on(T.FILE_CHUNK, (m) => this._chunk(m));
    link.on(T.FILE_END, (m) => this._end(m));
    link.on(T.FILE_CANCEL, (m) => (this.bfiles.has(m.id) ? this._batchFail(this.bfiles.get(m.id), null) : this._drop(m.id)));
    link.on('closed', () => {
      for (const id of [...this.files.keys()]) this._drop(id);
      for (const f of [...this.bfiles.values()]) this._batchFail(f, null);
      this.batches.clear();
      this.target = null;
    });
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
  }

  _offer(m) {
    if (typeof m.id !== 'string' || this.files.has(m.id) || this.bfiles.has(m.id) || m.drop === 'drag') return; // drags: dragrecv.js
    if (this.claims && this.claims(m)) return; // a paste Windows copies itself (dragrecv.js)
    const refuse = (why) => this.link.send({ t: T.FILE_REFUSE, id: m.id, why });
    if (m.drop === 'send' || m.drop === 'paste' || m.drop === 'rezume') return this._offerBatch(m, refuse); // rezume: a document taken here (shared/rezume.js)
    if (!this.settings.files.acceptFromMac) return refuse('not_allowed');
    if (!(m.size >= 0) || m.size > P.FILE_MAX_BYTES) return refuse('too_big');
    const name = safeName(m.name);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, P.randomHex(16) + '.part'); // not m.id: the other computer's string
    const f = { id: m.id, name, size: m.size, got: 0, seq: 0, hash: crypto.createHash('sha256'), out: fs.createWriteStream(tmp), tmp, done: false };
    if (this.files.size === 0) this.target = null; // a new drag
    this.files.set(m.id, f);
    this.link.send({ t: T.FILE_ACCEPT, id: m.id });
    this.onChange();
  }

  _chunk(m) {
    const f = this.files.get(m.id) || this.bfiles.get(m.id);
    if (!f || f.done || m.seq !== f.seq || (typeof m.data !== 'string' && !Buffer.isBuffer(m.data))) return;
    if (!f.out) openOut(f);
    const buf = (typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : m.data); // a Buffer from fast files (shared/fastfile.js)
    f.seq++;
    f.got += buf.length;
    f.hash.update(buf);
    f.out.write(buf);
    const b = f.batch && this.batches.get(f.batch);
    if (b) { // Copy/paste and Send files show progress like a drag
      b.got += buf.length;
      if (this.onBatchProgress) this.onBatchProgress(b);
    }
  }

  _end(m) {
    if (this.bfiles.has(m.id)) return this._batchEnd(this.bfiles.get(m.id), m);
    const f = this.files.get(m.id);
    if (!f || f.done) return;
    f.done = true;
    f.out.end(() => {
      const ok = f.got === f.size && f.hash.digest('hex') === m.sha256;
      if (!ok) {
        this._finish(f, false, 'checksum mismatch');
        return;
      }
      f.complete = true;
      if (this.target) this._place(f); // released already: put it where the drop was
    });
  }

  // The Mac's left button came up on this PC: decide the folder once, place what's complete.
  async onRelease() {
    if (!this.files.size || this.target) return;
    const r = await fm.at(this.helper);
    const folder = (r && r.folder) || '';
    this.target = folder && fs.existsSync(folder) ? folder : receivedDir(this.settings, app.getPath('downloads'));
    this.revealed = this.target === folder; // dropped on a folder that's on screen: nothing to show
    for (const f of this.files.values()) if (f.complete) this._place(f);
  }

  _place(f) {
    try {
      const dest = uniquePath(this.target, f.name);
      try { fs.renameSync(f.tmp, dest); } catch (_) { fs.copyFileSync(f.tmp, dest); fs.unlinkSync(f.tmp); } // other drive
      this._finish(f, true, dest);
      if (!this.revealed) { this.revealed = true; shell.showItemInFolder(dest); }
    } catch (e) {
      this._finish(f, false, e.message);
    }
  }

  _finish(f, ok, pathOrError) {
    this.files.delete(f.id);
    try { if (!ok) fs.unlinkSync(f.tmp); } catch (_) { /* gone */ }
    this.link.send(ok ? { t: T.FILE_DONE, id: f.id, ok: true, path: pathOrError } : { t: T.FILE_DONE, id: f.id, ok: false, error: pathOrError });
    this.last = { name: f.name, ok, text: ok ? 'Saved to ' + path.dirname(pathOrError) : pathOrError, at: Date.now() };
    if (!this.files.size) this.target = null;
    this.onChange();
  }

  _drop(id) {
    const f = this.files.get(id);
    if (!f) return;
    this.files.delete(id);
    f.out.destroy();
    try { fs.unlinkSync(f.tmp); } catch (_) { /* not written yet */ }
    if (!this.files.size) this.target = null;
    this.onChange();
  }

  // ---- Send files / paste batches ----

  // This computer pressed paste: the files of that batch go to `dir`. bytes: the batch's size from
  // fclip.offer, for the progress popup. reveal: show them afterwards (not when `dir` is the file
  // manager window in front, where they appear anyway).
  expectBatch(batch, dir, bytes = 0, reveal = false) {
    this.expected.set(batch, { dir, bytes, reveal });
    setTimeout(() => this.expected.delete(batch), 10 * 60 * 1000);
  }

  _offerBatch(m, refuse) {
    const size = Number(m.size);
    const count = Number(m.count);
    if (typeof m.batch !== 'string' || !m.batch || !Number.isInteger(count) || count < 1) return refuse('bad_message');
    if (!(size >= 0) || size > P.FILE_MAX_BYTES) return refuse('too_big');
    const rel = safeRel(m.rel || m.name);
    if (!rel) return refuse('bad_message');
    let b = this.batches.get(m.batch);
    if (!b) {
      const pasted = this.expected.get(m.batch);
      if ((m.drop === 'paste' || m.drop === 'rezume') && !pasted) return refuse('not_allowed'); // we never asked for it
      if (m.drop === 'send' && !this.settings.files.acceptFromMac) return refuse('not_allowed');
      // total: the whole batch's bytes (file.offer `bytes`, or what fclip.offer said); 0 = unknown.
      const total = Number(m.bytes) > 0 ? Number(m.bytes) : pasted ? pasted.bytes : 0;
      b = { kind: m.drop, dir: pasted ? pasted.dir : receivedDir(this.settings, app.getPath('downloads')), reveal: pasted ? pasted.reveal : true, count, done: 0, ok: 0, tops: new Map(), placed: [], total, got: 0, at: Date.now() };
      this.batches.set(m.batch, b);
      this.expected.delete(m.batch);
    }
    const segs = rel.split('/');
    if (!b.tops.has(segs[0])) { // "Photos 2" when Photos is already there
      const top = uniquePath(b.dir, segs[0]);
      b.tops.set(segs[0], path.basename(top));
      b.placed.push(top);
    }
    const final = path.join(b.dir, b.tops.get(segs[0]), ...segs.slice(1));
    const tmp = final + '.macshare-part';
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
    } catch (e) {
      this._batchStep(m.batch, false);
      return refuse('not_allowed');
    }
    // The Mac offers a whole folder at once: the file is opened with its first chunk.
    this.bfiles.set(m.id, { id: m.id, batch: m.batch, name: segs[segs.length - 1], size, final, tmp, got: 0, seq: 0, hash: crypto.createHash('sha256'), out: null, done: false });
    this.link.send({ t: T.FILE_ACCEPT, id: m.id });
    this.onChange();
  }

  _batchEnd(f, m) {
    if (f.done) return;
    f.done = true;
    if (!f.out) openOut(f); // an empty file
    f.out.end(() => {
      if (f.got !== f.size || f.hash.digest('hex') !== m.sha256) return this._batchFail(f, f.got !== f.size ? 'size mismatch' : 'checksum mismatch');
      try {
        fs.renameSync(f.tmp, f.final);
      } catch (e) {
        return this._batchFail(f, e.message);
      }
      this.bfiles.delete(f.id);
      this.link.send({ t: T.FILE_DONE, id: f.id, ok: true, path: f.final });
      this._batchStep(f.batch, true);
    });
  }

  // error null: cancelled or disconnected (nothing to tell the sender).
  _batchFail(f, error) {
    if (!this.bfiles.delete(f.id)) return;
    if (f.out) f.out.destroy();
    try { fs.unlinkSync(f.tmp); } catch (_) { /* not written */ }
    if (error) this.link.send({ t: T.FILE_DONE, id: f.id, ok: false, error });
    this._batchStep(f.batch, false);
  }

  // A batch file finished (or failed); after the last one: files.done, show them, popup.
  _batchStep(batch, ok) {
    const b = this.batches.get(batch);
    if (!b) return;
    b.done++;
    if (ok) b.ok++;
    if (b.done < b.count) return this.onChange();
    this.batches.delete(batch);
    this.link.send({ t: T.FILES_DONE, batch, ok: b.ok === b.count, where: b.dir, files: b.ok });
    const name = b.placed.length === 1 ? path.basename(b.placed[0]) : b.placed.length + ' items';
    this.last = { name, ok: b.ok > 0, text: b.ok === b.count ? 'Saved to ' + b.dir : (b.count - b.ok) + ' of ' + b.count + ' failed', at: Date.now() };
    if (b.ok && b.reveal) fm.showItems(b.placed);
    if (this.onBatch) this.onBatch({ kind: b.kind, files: b.ok, count: b.count, ok: b.ok === b.count, placed: b.placed });
    this.onChange();
  }

  view() {
    return { receiving: this.files.size + this.bfiles.size, last: this.last };
  }
}

// A plain base name: no folders, no characters Windows forbids (the other side may be a PC), no reserved device names.
function safeName(name) {
  let n = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + (n || 'file');
  return n.slice(0, 200);
}

function openOut(f) {
  f.out = fs.createWriteStream(f.tmp);
  f.out.on('error', () => {}); // the size/checksum check at the end fails instead
}

// "Photos/2024/a.jpg" → safe Windows segments joined by '/', or null (.., empty, too deep).
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4000) return null;
  const segs = rel.split('/');
  if (segs.length > 32) return null;
  const out = [];
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return null;
    out.push(safeName(s));
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

module.exports = FileRecv;
