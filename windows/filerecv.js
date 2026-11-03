// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files dragged from the Mac across the edge: `file.offer
// {drop:'release'}` from the Mac → a temp folder; when the Mac's left button comes up on this PC
// (k.mu b:0 while driven, see kvm.js) they go to the Explorer folder under the pointer, else the
// Desktop if the pointer is on it, else Downloads — never overwriting — and are shown in Explorer.
// `drop:'send'` / `'paste'` batches (Send files, the paste shortcut): every file with
// its `rel` path straight into Downloads or the folder chosen at paste time, then `files.done`.
const { app } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { streamPressure, receiverHook } = require('../shared/fastfile.js');
const { receivedDir } = require('../shared/received.js');

const T = P.T;

class FileRecv {
  // opts: link, helper, settings (shared), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.dir = path.join(app.getPath('userData'), 'incoming');
    // Fast files (shared/fastfile.js) wait while a file's bytes wait for the disk.
    if (this.link && this.link.fx) this.link.fx.pressure((id) => { const f = this.files.get(id) || (this.bfiles && this.bfiles.get(id)); return streamPressure(f && f.out); });
    // Fast files v2 (shared/fx2.js): the files engine writes the file into its tmp; we finish it.
    if (this.link && this.link.fx && this.link.fx.receiver) {
      this.link.fx.receiver(receiverHook({
        find: (id) => { const f = this.files.get(id) || this.bfiles.get(id); return f && !f.done ? f : null; },
        open: (f) => !!f.out || this._open(f),
        progress: (f, n) => {
          const b = f.batch && this.batches.get(f.batch);
          if (!b) return;
          b.got += n;
          if (this.onBatchProgress) this.onBatchProgress(b);
        },
        end: (f) => this._end({ t: T.FILE_END, id: f.id, sha256: '' }),
        fail: (f, why) => (f.batch ? this._batchFail(f, why) : this._fileFail(f, why)),
      }));
    }
    this.files = new Map(); // id → {name, size, got, seq, hash, out, tmp, done, released}
    this.placements = new Set(); // destination paths reserved while asynchronous placement finishes
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
      this.expected.clear();
      this.target = null;
    });
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
  }

  _offer(m) {
    if (typeof m.id !== 'string' || !m.id || m.id.length > 128 || this.files.has(m.id) || this.bfiles.has(m.id) || m.drop === 'drag') return; // drags: dragrecv.js
    if (this.claims && this.claims(m)) return; // a paste Windows copies itself (dragrecv.js)
    const refuse = (why) => this.link.send({ t: T.FILE_REFUSE, id: m.id, why });
    if (m.drop === 'send' || m.drop === 'paste' || m.drop === 'rezume') return this._offerBatch(m, refuse); // rezume: a document taken here (shared/rezume.js)
    if (!this.settings.files.acceptFromMac) return refuse('not_allowed');
    const size = Number(m.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > P.FILE_MAX_BYTES) return refuse('too_big');
    const name = safeName(m.name);
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) { return refuse('not_allowed'); }
    const tmp = path.join(this.dir, crypto.randomBytes(16).toString('hex') + '.part');
    const f = { id: m.id, name, size, got: 0, seq: 0, hash: crypto.createHash('sha256'), out: null, tmp, done: false };
    if (this.files.size === 0) this.target = null; // a new drag
    this.files.set(m.id, f);
    if (!this._open(f)) return;
    this.link.send({ t: T.FILE_ACCEPT, id: m.id });
    this.onChange();
  }

  _chunk(m) {
    const f = this.files.get(m.id) || this.bfiles.get(m.id);
    if (!f || f.done || m.seq !== f.seq || (typeof m.data !== 'string' && !Buffer.isBuffer(m.data))) return;
    const buf = (typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : m.data); // a Buffer from fast files (shared/fastfile.js)
    if (buf.length > f.size - f.got) return this._fileFail(f, 'size mismatch');
    if (!f.out && !this._open(f)) return;
    f.seq++;
    f.got += buf.length;
    f.hash.update(buf);
    try { f.out.write(buf); } catch (e) { return this._fileFail(f, e.message); }
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
    f.out.once('close', () => {
      if (this.files.get(f.id) !== f) return;
      const ok = f.got === f.size && (f.verified || f.hash.digest('hex') === m.sha256);
      if (!ok) {
        this._finish(f, false, 'checksum mismatch');
        return;
      }
      f.complete = true;
      if (this.target) this._place(f); // released already: put it where the drop was
    });
    f.out.end();
  }

  _fileFail(f, error) {
    if (f.batch) this._batchFail(f, error);
    else this._finish(f, false, error);
  }

  _open(f) {
    try {
      f.out = fs.createWriteStream(f.tmp, { flags: 'wx' });
      f.out.on('error', (e) => this._fileFail(f, e.message));
      f.out.once('close', () => { if (f.removed) removeTemp(f); });
      return true;
    } catch (e) {
      this._fileFail(f, e.message);
      return false;
    }
  }

  // The Mac's left button came up on this PC: decide the folder once, place what's complete.
  async onRelease() {
    if (!this.files.size || this.target) return;
    const first = this.files.values().next().value;
    let folder = '';
    try {
      const r = await this.helper.request('folderAt');
      folder = r.path || '';
    } catch (_) { /* helper busy: Downloads */ }
    if (this.files.get(first.id) !== first) return;
    this.target = folder && fs.existsSync(folder) ? folder : receivedDir(this.settings, app.getPath('downloads'));
    this.revealed = false;
    for (const f of this.files.values()) if (f.complete) this._place(f);
  }

  async _place(f) {
    if (this.files.get(f.id) !== f || f.placing) return;
    f.placing = true;
    const reserved = new Set([...this.placements, ...[...this.batches.values()].flatMap(b => b.placed).map(p => p.toLowerCase())]);
    const dest = uniquePath(this.target, f.name, reserved);
    this.placements.add(dest.toLowerCase());
    try {
      await placeFile(f.tmp, dest);
      if (this.files.get(f.id) !== f) {
        await fs.promises.unlink(dest).catch(() => {});
        return;
      }
      this._finish(f, true, dest);
      if (!this.revealed) { this.revealed = true; spawn('explorer.exe', ['/select,', dest], { detached: true, stdio: 'ignore' }).unref(); }
    } catch (e) {
      this._finish(f, false, e.message);
    } finally {
      if (f.removed) await fs.promises.unlink(f.tmp).catch(() => {});
      this.placements.delete(dest.toLowerCase());
    }
  }

  _finish(f, ok, pathOrError) {
    if (this.files.get(f.id) !== f) return;
    this.files.delete(f.id);
    f.removed = true;
    if (!ok) { if (f.out) f.out.destroy(); removeTemp(f); }
    this.link.send(ok ? { t: T.FILE_DONE, id: f.id, ok: true, path: pathOrError } : { t: T.FILE_DONE, id: f.id, ok: false, error: pathOrError });
    this.last = { name: f.name, ok, text: ok ? 'Saved to ' + path.dirname(pathOrError) : pathOrError, at: Date.now() };
    if (!this.files.size) this.target = null;
    this.onChange();
  }

  _drop(id) {
    const f = this.files.get(id);
    if (!f) return;
    this.files.delete(id);
    f.removed = true;
    if (f.out) f.out.destroy();
    removeTemp(f);
    if (!this.files.size) this.target = null;
    this.onChange();
  }

  // ---- Send files / paste batches ----

  // This PC pressed paste: the files of that batch go to `dir`. bytes: the batch's size from
  // fclip.offer, for the progress popup. app: they're for an app (fclip.js puts them on the
  // clipboard): no Explorer window to select them in.
  expectBatch(batch, dir, bytes = 0, app = false) {
    this.expected.set(batch, { dir, bytes, app });
    const expected = this.expected.get(batch);
    setTimeout(() => { if (this.expected.get(batch) === expected) this.expected.delete(batch); }, 10 * 60 * 1000).unref();
  }

  _offerBatch(m, refuse) {
    const size = Number(m.size);
    const count = Number(m.count);
    if (typeof m.batch !== 'string' || !m.batch || m.batch.length > 128 || !Number.isInteger(count) || count < 1 || count > 10000) return refuse('bad_message');
    if (!Number.isSafeInteger(size) || size < 0 || size > P.FILE_MAX_BYTES) return refuse('too_big');
    const rel = safeRel(m.rel || m.name);
    if (!rel) return refuse('bad_message');
    let b = this.batches.get(m.batch);
    if (!b) {
      const pasted = this.expected.get(m.batch);
      if ((m.drop === 'paste' || m.drop === 'rezume') && !pasted) return refuse('not_allowed'); // we never asked for it
      if (m.drop === 'send' && !this.settings.files.acceptFromMac) return refuse('not_allowed');
      // total: the whole batch's bytes (file.offer `bytes`, or what fclip.offer said); 0 = unknown.
      const total = Number(m.bytes) > 0 ? Number(m.bytes) : pasted ? pasted.bytes : 0;
      b = { kind: m.drop, dir: pasted ? pasted.dir : receivedDir(this.settings, app.getPath('downloads')), app: !!(pasted && pasted.app), count, offered: 0, done: 0, ok: 0, tops: new Map(), paths: new Set(), placed: [], total, got: 0, at: Date.now() };
      this.batches.set(m.batch, b);
      this.expected.delete(m.batch);
    }
    if (b.count !== count || b.kind !== m.drop || b.offered >= b.count) return refuse('bad_message');
    b.offered++;
    const segs = rel.split('/');
    if (!b.tops.has(segs[0])) { // "Photos 2" when Photos is already there
      const reserved = new Set([...this.placements, ...[...this.batches.values()].flatMap((batch) => batch.placed).map((p) => p.toLowerCase())]);
      const top = uniquePath(b.dir, segs[0], reserved);
      b.tops.set(segs[0], path.basename(top));
      b.placed.push(top);
    }
    const final = path.join(b.dir, b.tops.get(segs[0]), ...segs.slice(1));
    if (b.paths.has(final.toLowerCase())) { this._batchStep(m.batch, false); return refuse('bad_message'); }
    b.paths.add(final.toLowerCase());
    const tmp = final + '.' + crypto.randomBytes(16).toString('hex') + '.macshare-part';
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
    if (!f.out && !this._open(f)) return; // an empty file
    f.out.once('close', async () => {
      if (this.bfiles.get(f.id) !== f) return;
      if (f.got !== f.size || (!f.verified && f.hash.digest('hex') !== m.sha256)) return this._batchFail(f, f.got !== f.size ? 'size mismatch' : 'checksum mismatch');
      this.placements.add(f.final.toLowerCase());
      try {
        await placeFile(f.tmp, f.final);
        if (this.bfiles.get(f.id) !== f) {
          await fs.promises.unlink(f.final).catch(() => {});
          return;
        }
      } catch (e) {
        return this._batchFail(f, e.message);
      } finally {
        if (f.removed) await fs.promises.unlink(f.tmp).catch(() => {});
        this.placements.delete(f.final.toLowerCase());
      }
      this.bfiles.delete(f.id);
      f.removed = true;
      this.link.send({ t: T.FILE_DONE, id: f.id, ok: true, path: f.final });
      this._batchStep(f.batch, true);
    });
    f.out.end();
  }

  // error null: cancelled or disconnected (nothing to tell the sender).
  _batchFail(f, error) {
    if (this.bfiles.get(f.id) !== f) return;
    this.bfiles.delete(f.id);
    f.removed = true;
    if (f.out) f.out.destroy();
    removeTemp(f);
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
    if (b.ok && !b.app) {
      if (b.kind === 'paste') this.helper.request('selectItems', { dir: b.dir, names: b.placed.map((p) => path.basename(p)) }).catch(() => {});
      else spawn('explorer.exe', ['/select,', b.placed[0]], { detached: true, stdio: 'ignore' }).unref();
    }
    if (this.onBatch) this.onBatch({ batch, kind: b.kind, files: b.ok, count: b.count, ok: b.ok === b.count, placed: b.placed });
    this.onChange();
  }

  view() {
    return { receiving: this.files.size + this.bfiles.size, last: this.last };
  }
}

// A plain base name: no folders, no characters Windows forbids, no reserved device names.
function safeName(name) {
  let n = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + (n || 'file');
  return n.slice(0, 200);
}

function removeTemp(f) {
  try { fs.unlinkSync(f.tmp); } catch (_) { /* retried when the stream closes */ }
}

async function placeFile(tmp, final) {
  try { await fs.promises.link(tmp, final); }
  catch (e) {
    if (e.code === 'EEXIST') throw e;
    await fs.promises.copyFile(tmp, final, fs.constants.COPYFILE_EXCL);
  }
  try { await fs.promises.unlink(tmp); } catch (_) { /* the saved file is complete */ }
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
function uniquePath(dir, name, reserved = new Set()) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p) || reserved.has(p.toLowerCase()); i++) p = path.join(dir, base + ' ' + i + ext);
  return p;
}

module.exports = FileRecv;
