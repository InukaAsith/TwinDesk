// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files from the PC: receive file.* chunks, check size + SHA-256, save where
// they were dropped — the Finder window under the point, else the Desktop if dropped on it, else
// the Files folder — never overwriting, then reveal in Finder.
//   drop:'point'   (Monitor 2) x,y normalized over the shared display
//   drop:'release' (dragged across the edge) wait in a temp folder until the PC's left button comes
//                  up while it drives this Mac (release()), then go where the pointer is.
//   drop:'drag' part of a native drag here: dragin.js says where it lands.
//   drop:'send' / 'paste' a batch with folders by `rel`: Send files goes to the Files
//                  folder, a paste to the folder chosen when the paste shortcut was pressed.
//
// Events: 'change' — this.view changed (at most 4 times a second: 10,000 small files are 20,000
//   changes, and each one redrew the window), 'batch' — a Send files / paste batch ended.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell, screen } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { receiverHook } = require('../shared/fastfile.js');
const { DragIn } = require('./dragin');

const DESKTOP = path.join(os.homedir(), 'Desktop');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const MAX_RECENT = 20;
// Received bytes are written in order but off the main thread's way (a write chain per file);
// fast files (shared/fastfile.js) pause the transfer while more than this waits for the disk.
const HIGH_WATER = 8 * 1024 * 1024;
const writes = () => ({ q: Promise.resolve(), pending: 0, err: null, wake: null });

// All of buf at the file's current end.
function writeAll(fd, buf) {
  return new Promise((resolve, reject) => {
    const go = (off) => fs.write(fd, buf, off, buf.length - off, null, (err, n) => {
      if (err) return reject(err);
      if (off + n < buf.length) return go(off + n);
      resolve();
    });
    go(0);
  });
}
const INCOMING = path.join(os.tmpdir(), 'macshare-incoming');

function cleanName(name) {
  let n = path.basename(String(name || '')).replace(/[\u0000-\u001f/:\\]/g, '_').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

// "name.ext", "name 2.ext", "name 3.ext"…
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? name : `${base} ${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

// Finder windows with their bounds {left, top, right, bottom} and folder.
function finderWindows() {
  const script = 'tell application "Finder" to set out to ""\n'
    + 'tell application "Finder" to repeat with w in (every Finder window)\n'
    + '  try\n    set b to bounds of w\n'
    + '    set out to out & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & "," & (POSIX path of (target of w as alias)) & linefeed\n'
    + '  end try\nend repeat\nreturn out';
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split('\n').filter(Boolean).map((l) => {
        const [x1, y1, x2, y2, ...rest] = l.split(',');
        return { x1: +x1, y1: +y1, x2: +x2, y2: +y2, dir: rest.join(',') };
      }));
    });
  });
}

class Drop extends EventEmitter {
  constructor({ server, helper, displays, getSettings }) {
    super();
    Object.assign(this, { server, helper, displays, getSettings });
    this.active = new Map(); // id -> transfer
    this.recent = []; // newest first: {name, size, path, at, ok, error}
    this.drag = null; // { dest: null|dir, waiting: [transfer] } while files are dragged in (drop:'release')
    this.batches = new Map(); // Batch -> { kind, dir, count, done, ok, tops: Map, placed: [] }
    if (server.fx) server.fx.pressure((id) => this.pressure(id)); // fast files wait for our disk
    // Fast files v2 (shared/fx2.js): the files engine writes the file into its tmp; we finish it.
    if (server.fx && server.fx.receiver) {
      server.fx.receiver(receiverHook({
        find: (id) => { const t = this.active.get(id); return t && !t.ending ? t : null; },
        progress: (t) => {
          if (t.got - (t.shown || 0) < 4 * 1024 * 1024) return;
          t.shown = t.got;
          this._changed();
        },
        end: (t) => this._end({ id: t.id, sha256: '' }),
        fail: (t, why) => this._abort(t.id, why, true),
      }));
    }
    this.expected = new Map(); // batch (fclip id) -> dir chosen when this Mac pasted
    this.dragIn = new DragIn({ server, helper, getSettings, remember: (r) => this._remember(r) });
    this.dragIn.replayOffer = (m) => this._offer(m);
    this.dragIn.onAbort = (drag) => {
      for (const t of [...this.active.values()]) if (t.drag === drag) this._abort(t.id, 'cancelled', false);
    };

    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(P.T.FILE_OFFER, (m) => this._offer(m));
    on(P.T.FILE_CHUNK, (m) => this._chunk(m));
    on(P.T.FILE_END, (m) => this._end(m));
    on(P.T.FILE_CANCEL, (m) => this._abort(m.id, 'cancelled', false));
    server.on('closed', () => {
      if (!server.current) {
        for (const id of [...this.active.keys()]) this._abort(id, 'disconnected', false);
        this.batches.clear();
      }
    });
  }

  get cfg() {
    return this.getSettings().files;
  }

  // Where a drop at normalized (x, y) on the shared display should land.
  async _destination(m) {
    const t = this.displays.target();
    if (!t || typeof m.x !== 'number' || typeof m.y !== 'number') return this.cfg.folder || DOWNLOADS;
    return this._destAt(t.bounds.x + m.x * t.bounds.width, t.bounds.y + m.y * t.bounds.height);
  }

  // Folder for a drop at a global point: Finder window under it, the desktop, or the Files folder.
  async _destAt(gx, gy) {
    const fallback = this.cfg.folder || DOWNLOADS;
    try {
      const w = await this.helper.request('windowAt', { x: gx, y: gy });
      if (!w.owner) return DESKTOP; // dropped on the desktop itself
      if (w.owner === 'Finder') {
        const hit = (await finderWindows()).find((f) => Math.abs(f.x1 - w.bounds.x) < 6 && Math.abs(f.y1 - w.bounds.y) < 30 && Math.abs(f.x2 - (w.bounds.x + w.bounds.width)) < 6);
        if (hit && fs.existsSync(hit.dir)) return hit.dir;
      }
    } catch { /* fall back */ }
    return fallback;
  }

  async _offer(m) {
    const refuse = (why) => this.server.sendToClient({ t: P.T.FILE_REFUSE, id: m.id, why });
    if (typeof m.id !== 'string' || this.active.has(m.id)) return;
    if (m.drop === 'send' || m.drop === 'paste' || m.drop === 'rezume') return this._offerBatch(m, refuse); // rezume: a document taken here (shared/rezume.js)
    if (!this.cfg.acceptDrops) return refuse('not_allowed');
    const size = Number(m.size);
    if (!Number.isFinite(size) || size < 0 || size > P.FILE_MAX_BYTES) return refuse('too_big');
    const name = cleanName(m.name);
    if (m.drop === 'drag') return this._offerDrag(m, size, name);
    const release = m.drop === 'release';
    if (release && !this.drag) this.drag = { dest: null, waiting: [] }; // offer before kvm.take: fine
    const dir = release ? INCOMING : await this._destination(m);
    const tmp = path.join(dir, `.${name}.${P.randomHex(4)}.macshare-part`); // not m.id: the PC's string
    let fd;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(tmp, 'w', 0o644);
    } catch (e) {
      console.error(`[drop] ${tmp}: ${e.message}`);
      return refuse('not_allowed');
    }
    this.active.set(m.id, { id: m.id, name, size, dir, tmp, fd, release, got: 0, seq: 0, hash: crypto.createHash('sha256'), at: Date.now(), ...writes() });
    this.server.sendToClient({ t: P.T.FILE_ACCEPT, id: m.id });
    this._changed();
  }

  // This Mac pressed paste: files of that batch go to `dir`. app: they're for an app in front
  // (fclip.js puts them on the clipboard), so Finder doesn't show them.
  expectBatch(batch, dir, app = false) {
    this.expected.set(batch, { dir, app });
    setTimeout(() => this.expected.delete(batch), 10 * 60 * 1000);
  }

  // One file of a Send files / paste batch.
  _offerBatch(m, refuse) {
    const size = Number(m.size);
    const count = Number(m.count);
    if (typeof m.batch !== 'string' || !m.batch || !Number.isInteger(count) || count < 1) return refuse('bad_message');
    if (!Number.isFinite(size) || size < 0 || size > P.FILE_MAX_BYTES) return refuse('too_big');
    let b = this.batches.get(m.batch);
    if (!b) {
      const pasted = this.expected.get(m.batch);
      if ((m.drop === 'paste' || m.drop === 'rezume') && !pasted) return refuse('not_allowed'); // we never asked for it
      if (m.drop === 'send' && !this.cfg.acceptDrops) return refuse('not_allowed');
      b = { kind: m.drop, dir: (pasted && pasted.dir) || this.cfg.folder || DOWNLOADS, app: !!(pasted && pasted.app), count, done: 0, ok: 0, tops: new Map(), placed: [],
        bytes: Number(m.bytes) > 0 ? Number(m.bytes) : 0, doneBytes: 0, at: Date.now() }; // bytes: the batch's total, when the sender says
      this.batches.set(m.batch, b);
      this.expected.delete(m.batch);
    }
    const segs = String(m.rel || m.name).split('/').filter(Boolean).map(cleanName);
    if (!segs.length) segs.push(cleanName(m.name));
    if (!b.tops.has(segs[0])) {
      const top = uniquePath(b.dir, segs[0]); // "Photos 2" when Photos is already there
      b.tops.set(segs[0], path.basename(top));
      b.placed.push(top);
    }
    const final = path.join(b.dir, b.tops.get(segs[0]), ...segs.slice(1));
    const tmp = `${final}.macshare-part`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fd = fs.openSync(tmp, 'w', 0o644);
    } catch (e) {
      console.error(`[drop] ${tmp}: ${e.message}`);
      this._batchStep(m.batch, false);
      return refuse('not_allowed');
    }
    this.active.set(m.id, { id: m.id, name: segs[segs.length - 1], size, tmp, final, fd, batch: m.batch, got: 0, seq: 0, hash: crypto.createHash('sha256'), at: Date.now(), ...writes() });
    this.server.sendToClient({ t: P.T.FILE_ACCEPT, id: m.id });
    this._changed();
  }

  // A batch file finished (or failed); after the last one: files.done, reveal, popup.
  _batchStep(batch, ok) {
    const b = this.batches.get(batch);
    if (!b) return;
    b.done++;
    if (ok) b.ok++;
    if (b.done < b.count) return this._changed();
    this.batches.delete(batch);
    const where = b.dir.replace(os.homedir(), '~');
    this.server.sendToClient({ t: P.T.FILES_DONE, batch, ok: b.ok === b.count, where, files: b.ok });
    const name = b.placed.length === 1 ? path.basename(b.placed[0]) : `${b.placed.length} items`;
    this._remember({ name, size: 0, path: b.placed[0] || null, ok: b.ok > 0, ...(b.ok === b.count ? {} : { error: `${b.count - b.ok} of ${b.count} failed` }) });
    if (b.ok && !b.app && (this.cfg.reveal || b.kind === 'paste')) shell.showItemInFolder(b.placed[0]);
    this.emit('batch', { kind: b.kind, files: b.ok, count: b.count, ok: b.ok === b.count, placed: b.placed });
  }

  // A file of a native drag (dragin.js): streamed into the drag's temp tree.
  _offerDrag(m, size, name) {
    if (this.dragIn.holdOffer(m)) return;
    const final = this.dragIn.tmpFor(m);
    if (!final) return this.server.sendToClient({ t: P.T.FILE_REFUSE, id: m.id, why: 'not_allowed' });
    const tmp = `${final}.macshare-part`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fd = fs.openSync(tmp, 'w', 0o644);
    } catch (e) {
      console.error(`[drop] ${tmp}: ${e.message}`);
      this.dragIn.arrived({ drag: m.drag, rel: m.rel, id: m.id }, false);
      return this.server.sendToClient({ t: P.T.FILE_REFUSE, id: m.id, why: 'not_allowed' });
    }
    this.active.set(m.id, { id: m.id, name, size, tmp, final, fd, drag: m.drag, rel: m.rel, got: 0, seq: 0, hash: crypto.createHash('sha256'), at: Date.now(), ...writes() });
    this.server.sendToClient({ t: P.T.FILE_ACCEPT, id: m.id });
    this._changed();
  }

  _chunk(m) {
    const t = this.active.get(m.id);
    if (!t) return;
    if (m.seq !== t.seq || (typeof m.data !== 'string' && !Buffer.isBuffer(m.data))) return this._abort(m.id, 'chunks out of order', true);
    const buf = (typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : m.data); // a Buffer from fast files (shared/fastfile.js)
    if (t.got + buf.length > t.size) return this._abort(m.id, 'more data than offered', true);
    this._write(t, buf);
    t.hash.update(buf);
    t.got += buf.length;
    t.seq++;
    if (t.got - (t.shown || 0) >= 4 * 1024 * 1024) { // progress, every 4 MB
      t.shown = t.got;
      this._changed();
    }
  }

  // Queued after the writes before it; a failed write fails the file at its end.
  _write(t, buf) {
    t.pending += buf.length;
    t.q = t.q.then(() => (t.err || t.fd === null ? null : writeAll(t.fd, buf).catch((e) => { t.err = e; }))).then(() => {
      t.pending -= buf.length;
      if (t.pending <= HIGH_WATER / 2) this._wake(t);
    });
  }

  _wake(t) {
    const w = t.wake;
    t.wake = null;
    if (w) w();
  }

  // shared/fastfile.js asks after each chunk: a promise while the disk is behind (the transfer
  // waits for it), else null.
  pressure(id) {
    const t = this.active.get(id);
    if (!t || t.pending <= HIGH_WATER) return null;
    return new Promise((resolve) => {
      const prev = t.wake;
      t.wake = () => { if (prev) prev(); resolve(); };
    });
  }

  // file.end: once every byte before it is on the disk.
  _end(m) {
    const t = this.active.get(m.id);
    if (!t || t.ending) return;
    t.ending = true;
    t.q.then(() => this._ended(t, m));
  }

  _ended(t, m) {
    if (this.active.get(t.id) !== t) return; // aborted meanwhile
    const digest = t.hash.digest('hex');
    try { fs.closeSync(t.fd); } catch (e) { t.err = t.err || e; }
    t.fd = null;
    if (t.err) return this._abort(t.id, t.err.message, true);
    if (t.got !== t.size || (!t.verified && String(m.sha256).toLowerCase() !== digest)) {
      return this._abort(t.id, t.got !== t.size ? 'size mismatch' : 'checksum mismatch', true);
    }
    this.active.delete(t.id);
    if (t.batch) {
      const b = this.batches.get(t.batch);
      if (b) b.doneBytes += t.size;
      try {
        fs.renameSync(t.tmp, t.final);
        this.server.sendToClient({ t: P.T.FILE_DONE, id: t.id, ok: true, path: t.final.replace(os.homedir(), '~') });
      } catch (e) {
        fs.rmSync(t.tmp, { force: true });
        this.server.sendToClient({ t: P.T.FILE_DONE, id: t.id, ok: false, error: e.message });
        return this._batchStep(t.batch, false);
      }
      return this._batchStep(t.batch, true);
    }
    if (t.drag) {
      try {
        fs.renameSync(t.tmp, t.final);
      } catch (e) {
        return this._abort(t.id, e.message, true);
      }
      this.dragIn.arrived(t, true);
      return this._changed();
    }
    if (t.release && !(this.drag && this.drag.dest)) {
      // Not dropped yet: wait for the release (kept complete in the temp folder).
      if (!this.drag) this.drag = { dest: null, waiting: [] };
      this.drag.waiting.push(t);
      return this._changed();
    }
    this._place(t, t.release ? this.drag.dest : t.dir);
  }

  _place(t, dir) {
    let final;
    try {
      fs.mkdirSync(dir, { recursive: true });
      final = uniquePath(dir, t.name);
      try {
        fs.renameSync(t.tmp, final);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(t.tmp, final); // temp folder on another volume
        fs.rmSync(t.tmp, { force: true });
      }
    } catch (e) {
      fs.rmSync(t.tmp, { force: true });
      this.server.sendToClient({ t: P.T.FILE_DONE, id: t.id, ok: false, error: e.message });
      return this._remember({ name: t.name, size: t.size, path: null, ok: false, error: e.message });
    }
    this.server.sendToClient({ t: P.T.FILE_DONE, id: t.id, ok: true, path: final.replace(os.homedir(), '~') });
    this._remember({ name: path.basename(final), size: t.size, path: final, ok: true });
    if (this.cfg.reveal) shell.showItemInFolder(final);
  }

  // kvm.take with `drag`: files are about to be dragged in.
  armDrag() {
    if (!this.drag) this.drag = { dest: null, waiting: [] };
  }

  // The PC's left button came up while it drives this Mac: drop here.
  async release() {
    if (!this.drag || this.drag.dest) return;
    if (!this.drag.waiting.length && ![...this.active.values()].some((t) => t.release)) {
      this.drag = null; // a drag (dragin.js) or nothing sent: nothing to place
      return;
    }
    const p = screen.getCursorScreenPoint();
    const dest = await this._destAt(p.x, p.y);
    if (!this.drag) return;
    this.drag.dest = dest;
    for (const t of this.drag.waiting.splice(0)) this._place(t, dest);
    // Later files of this drag go straight there; forget the drag once nothing is in flight.
    setTimeout(() => {
      if (this.drag && this.drag.dest === dest && ![...this.active.values()].some((t) => t.release)) this.drag = null;
    }, 30000);
  }

  // The PC went home without dropping: throw the waiting files away.
  cancelDrag() {
    if (!this.drag || this.drag.dest) return;
    for (const t of this.drag.waiting.splice(0)) fs.rmSync(t.tmp, { force: true });
    this.drag = null;
    this._changed();
  }

  _abort(id, error, tell) {
    const t = this.active.get(id);
    if (!t) return;
    this.active.delete(id);
    this._wake(t);
    // After the writes in flight: closing the fd under them could hand its number to another file.
    t.q.then(() => {
      if (t.fd !== null) try { fs.closeSync(t.fd); } catch { /* already closed */ }
      t.fd = null;
      fs.rmSync(t.tmp, { force: true });
    });
    if (tell) this.server.sendToClient({ t: P.T.FILE_DONE, id, ok: false, error });
    if (t.batch) return this._batchStep(t.batch, false);
    if (t.drag) {
      this.dragIn.arrived(t, false);
      return this._changed();
    }
    this._remember({ name: t.name, size: t.size, path: null, ok: false, error });
  }

  // 'change', at most every 250 ms (the last one always goes).
  _changed() {
    if (this._changeTimer) return void (this._changeLater = true);
    this.emit('change');
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      if (this._changeLater) { this._changeLater = false; this._changed(); }
    }, 250);
    if (this._changeTimer.unref) this._changeTimer.unref();
  }

  _remember(r) {
    this.recent.unshift({ ...r, at: Date.now() });
    this.recent.length = Math.min(this.recent.length, MAX_RECENT);
    this._changed();
  }

  reveal(index) {
    const r = this.recent[index];
    if (r && r.path && fs.existsSync(r.path)) shell.showItemInFolder(r.path);
  }

  // Files on their way: a batch (Send files, a paste) as one entry, {count, done, bytes, got, at}; the
  // others one by one (the first few: a drag of 10,000 files isn't 10,000 lines).
  get view() {
    const batches = new Map([...this.batches].map(([id, b]) => [id, { kind: b.kind, count: b.count, done: b.done, bytes: b.bytes, got: b.doneBytes, at: b.at }]));
    const receiving = [];
    let more = 0;
    for (const t of this.active.values()) {
      const b = t.batch && batches.get(t.batch);
      if (b) b.got += t.got;
      else if (receiving.length < 5) receiving.push({ name: t.name, size: t.size, got: t.got });
      else more++;
    }
    return {
      receiving,
      receivingMore: more,
      inBatches: [...batches.values()],
      recent: this.recent,
      defaultFolder: DOWNLOADS,
    };
  }
}

module.exports = { Drop };
