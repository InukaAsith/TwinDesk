// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A drag from the Mac across the edge: on `drag.start` while the Mac
// drives this PC, the helper starts a real Windows drag at the pointer (virtual files: the whole
// tree described up front, contents streamed from temp files as `file.*` chunks arrive). The Mac's
// left-button-up drops it wherever the pointer is — Explorer, the Desktop, an app. `drag.end` tells
// the Mac how it went.
// The paste shortcut uses the same virtual files, dropped by the helper straight onto
// the folder that was in front (`into`), so Windows copies them with its own progress dialog. The
// files come as the paste batch (`file.offer drop:'paste'`); the end is `files.done`, not drag.end.
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { streamPressure, receiverHook } = require('../shared/fastfile.js');

const T = P.T;
const MAX_FILES = 10000, MAX_DEPTH = 32;

// "Photos/2024/a.jpg" → safe Windows segments, or null (.., empty, too deep).
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4000) return null;
  const segs = rel.split('/');
  if (segs.length > MAX_DEPTH) return null;
  const out = [];
  for (let s of segs) {
    if (!s || s === '.' || s === '..') return null;
    s = s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    if (!s) return null;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
    out.push(s.slice(0, 200));
  }
  return out.join('/');
}

class DragRecv {
  // opts: link, helper, settings (shared), isDriven(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.root = path.join(app.getPath('userData'), 'drag');
    if (this.link && this.link.fx) this.link.fx.pressure((id) => { const f = this.cur && this.cur.byId.get(id); return streamPressure(f && f.out); });
    // Fast files v2 (shared/fx2.js): the files engine writes the file into its tmp; we finish it.
    if (this.link && this.link.fx && this.link.fx.receiver) {
      this.link.fx.receiver(receiverHook({
        find: (id) => { const f = this.cur && this.cur.byId.get(id); return f && f.state === 'arriving' ? f : null; },
        end: (f) => this._end({ t: T.FILE_END, id: f.id, sha256: '' }),
        fail: (f, why) => this._fail(f),
      }));
    }
    this.cur = null; // {drag, dir, entries, files: Map(rel → file), byId: Map(id → file), where, state}
    this.last = null; // {text, ok, at}
    this.homeUntil = 0; // kvm.home said the Mac's files follow as a drag here at home (expectHome)
    const link = this.link;
    link.on(T.DRAG_START, (m) => this._start(m));
    link.on(T.DRAG_CANCEL, (m) => this.cur && m.drag === this.cur.drag && this.cancel('cancelled', false));
    link.on(T.FILE_OFFER, (m) => (m.drop === 'drag' || this._pasteOf(m)) && this._offer(m));
    link.on(T.FILE_CHUNK, (m) => this._chunk(m));
    link.on(T.FILE_END, (m) => this._end(m));
    link.on(T.FILE_CANCEL, (m) => { const f = this.cur && this.cur.byId.get(m.id); if (f) this._fail(f); });
    link.on('closed', () => this.cancel('cancelled', false));
    this.helper.on('event', (name, m) => this._event(name, m));
    this.helper.on('exit', () => this.cancel('failed', false));
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
  }

  _start(m) {
    const end = (result) => this.link.send({ t: T.DRAG_END, drag: m.drag, result });
    if (typeof m.drag !== 'string' || !m.drag) return;
    if (this.cur) this.cancel('cancelled', false);
    const home = Date.now() < this.homeUntil; // the Mac's drag came over with the pointer, back home
    this.homeUntil = 0;
    if (!this.settings.files.edgeDrag || !this.settings.files.acceptFromMac || !(this.isDriven() || home)) return end('cancelled');
    const list = Array.isArray(m.list) ? m.list : [];
    if (!list.length && !(Array.isArray(m.dirs) && m.dirs.length) || list.length > MAX_FILES) return end('failed');
    // Folders first (parents before children: Explorer creates them in order), then the files.
    const dirs = new Set();
    const addParents = (rel) => { const s = rel.split('/'); for (let i = 1; i < s.length; i++) dirs.add(s.slice(0, i).join('/')); };
    if (Array.isArray(m.dirs) && m.dirs.length > MAX_FILES) return end('failed');
    for (const d of Array.isArray(m.dirs) ? m.dirs : []) { const r = safeRel(d); if (!r) return end('failed'); dirs.add(r); addParents(r); }
    let built;
    try { built = this._build(list, dirs, addParents, m.items); } catch (_) { built = null; }
    if (!built) return end('failed');
    const { dir, files, entries, names, count } = built;
    this.cur = { drag: m.drag, dir, files, byId: new Map(), where: '', state: 'dragging', count, name: names[0] ? names[0].replace(/\/$/, '') : '' };
    this.helper.send('dragStart', { drag: m.drag, entries, names, home }); // home: our own button drops it
    this.onChange();
  }

  // kvm.js: the pointer came home with the Mac's button held in a drag of its files: the drag.start
  // that follows starts here although the Mac doesn't drive this PC.
  expectHome() {
    this.homeUntil = Date.now() + 3000;
  }

  // The temp files and the helper's entries for a tree (folders first, then the files), or null.
  _build(list, dirs, addParents, givenItems) {
    const dir = path.join(this.root, crypto.randomBytes(6).toString('hex'));
    const files = new Map();
    const fileEntries = [];
    const used = new Set();
    for (const f of list) {
      const rel = f && safeRel(f.rel);
      if (!rel || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > P.FILE_MAX_BYTES || used.has(rel.toLowerCase())) return null;
      used.add(rel.toLowerCase());
      addParents(rel);
      const tmp = path.join(dir, files.size + '.part');
      const file = { rel, size: f.size, tmp, index: -1, id: null, got: 0, seq: 0, hash: null, out: null, state: 'waiting' };
      files.set(rel, file);
      fileEntries.push(file);
    }
    if (dirs.size + files.size > MAX_FILES) return null;
    const dirKeys = new Set();
    for (const d of dirs) {
      const key = d.toLowerCase();
      if (used.has(key) || dirKeys.has(key)) return null;
      dirKeys.add(key);
    }
    const dirList = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const entries = dirList.map((d) => ({ rel: d, dir: true, size: 0 }));
    for (const f of fileEntries) { f.index = entries.length; entries.push({ rel: f.rel, size: f.size, temp: f.tmp }); }
    const items = Array.isArray(givenItems) && givenItems.length ? givenItems : [...new Set(fileEntries.map((f) => f.rel.split('/')[0]))].map((n) => ({ name: n, dir: dirs.has(n) }));
    const names = items.slice(0, 50).map((it) => (safeRel(String(it && it.name || 'item')) || 'item').split('/').pop() + (it && it.dir ? '/' : ''));
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fileEntries) fs.writeFileSync(f.tmp, '');
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      throw e;
    }
    return { dir, files, entries, names, count: items.length };
  }

  // This PC pasted (fclip.js) a tree it knows in full: the helper drops it onto `dir`
  // and Windows copies it (its dialog). Returns false when it can't (fclip.js then saves directly).
  startPaste({ batch, list, dirs, items, dir }) {
    if (typeof batch !== 'string' || !Array.isArray(list) || list.length > MAX_FILES || !(list.length || (dirs && dirs.length))) return false;
    if (this.cur) this.cancel('cancelled', false);
    if (Array.isArray(dirs) && dirs.length > MAX_FILES) return false;
    const set = new Set();
    const addParents = (rel) => { const s = rel.split('/'); for (let i = 1; i < s.length; i++) set.add(s.slice(0, i).join('/')); };
    for (const d of Array.isArray(dirs) ? dirs : []) { const r = safeRel(d); if (!r) return false; set.add(r); addParents(r); }
    let built;
    try { built = this._build(list, set, addParents, items); } catch (_) { built = null; }
    if (!built) return false;
    const { dir: tmp, files, entries, names, count } = built;
    const drag = 'paste-' + batch;
    this.cur = { drag, batch, dir: tmp, files, byId: new Map(), where: dir, state: 'pasting', count, name: names[0] ? names[0].replace(/\/$/, '') : '' };
    this.helper.send('dragStart', { drag, entries, names, into: dir });
    this.onChange();
    return true;
  }

  // A file of the paste we're doing natively (filerecv.js leaves it to us).
  _pasteOf(m) {
    return !!(m && m.drop === 'paste' && this.cur && this.cur.batch && m.batch === this.cur.batch);
  }

  _offer(m) {
    const refuse = (why) => this.link.send({ t: T.FILE_REFUSE, id: m.id, why });
    const c = this.cur;
    if (typeof m.id !== 'string' || !m.id || m.id.length > 256) return;
    if (!c || (c.batch ? m.batch !== c.batch : m.drag !== c.drag)) return refuse('not_allowed');
    const f = c.files.get(safeRel(m.rel));
    if (!f || f.id || c.byId.has(m.id) || m.size !== f.size) return refuse('not_allowed');
    f.id = m.id;
    f.hash = crypto.createHash('sha256');
    f.state = 'arriving';
    c.byId.set(m.id, f);
    try {
      f.out = fs.createWriteStream(f.tmp, { flags: 'w' });
      f.out.on('error', () => this._fail(f, c));
    } catch (_) { return this._fail(f, c); }
    this.link.send({ t: T.FILE_ACCEPT, id: m.id });
  }

  _chunk(m) {
    const f = this.cur && this.cur.byId.get(m.id);
    if (!f || f.state !== 'arriving' || m.seq !== f.seq || (typeof m.data !== 'string' && !Buffer.isBuffer(m.data))) return;
    const buf = (typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : m.data); // a Buffer from fast files (shared/fastfile.js)
    if (f.got + buf.length > f.size) return this._fail(f); // more than it offered: not written (it could fill the disk)
    try {
      f.seq++;
      f.got += buf.length;
      f.hash.update(buf);
      f.out.write(buf);
    } catch (_) { this._fail(f); }
  }

  _end(m) {
    const c = this.cur;
    const f = c && c.byId.get(m.id);
    if (!f || f.state !== 'arriving') return;
    f.state = 'closing';
    f.out.once('close', () => {
      if (this.cur !== c || f.state !== 'closing') return;
      const ok = f.got === f.size && (f.verified || f.hash.digest('hex') === m.sha256);
      f.state = ok ? 'ok' : 'failed';
      this.helper.send('dragFile', { drag: c.drag, index: f.index, state: ok ? 'ok' : 'failed' });
      // A paste batch's sender waits for each file's file.done before the next one (filedrop.js),
      // while Windows waits for the next file's bytes: say "got it" as soon as it's here.
      if (c.batch) {
        f.acked = true;
        this.link.send(ok ? { t: T.FILE_DONE, id: f.id, ok: true } : { t: T.FILE_DONE, id: f.id, ok: false, error: 'checksum mismatch' });
      }
    });
    try { f.out.end(); } catch (_) { this._fail(f, c); }
  }

  _fail(f, c = this.cur) {
    if (this.cur !== c || !c || f.state === 'failed' || f.state === 'ok') return;
    f.state = 'failed';
    if (f.out) f.out.destroy();
    this.helper.send('dragFile', { drag: c.drag, index: f.index, state: 'failed' });
    if (c.batch && f.id && !f.acked) {
      f.acked = true;
      this.link.send({ t: T.FILE_DONE, id: f.id, ok: false, error: 'transfer failed' });
    }
  }

  // The Mac's left button came up here (kvm.js injects it, which drops the drag): remember the
  // folder under the pointer for the "Dropped in …" line; tell the helper too, in case the
  // injected button-up didn't reach the drag loop.
  onRelease() {
    const c = this.cur;
    if (!c || c.state !== 'dragging') return;
    c.state = 'dropping';
    this.helper.request('folderAt').then((r) => { if (this.cur === c && r && r.path) c.where = r.path; }).catch(() => {});
    setTimeout(() => this.cur === c && c.state === 'dropping' && this.helper.send('dragDrop', { drag: c.drag }), 400);
  }

  get dragging() {
    return !!(this.cur && this.cur.state === 'dragging');
  }

  // Input went back to the Mac before the drop: the drag is cancelled (a drop being copied goes on).
  onHome() {
    if (this.cur && this.cur.state === 'dragging') this.cancel('cancelled', false);
  }

  // The Mac cancelled, or the link/helper went away: end the drag here.
  cancel(result, fromHelper) {
    const c = this.cur;
    if (!c) return;
    if (!fromHelper) this.helper.send('dragCancel', { drag: c.drag });
    this._finish(result);
  }

  _event(name, m) {
    const c = this.cur;
    if (!c || !m || m.drag !== c.drag) return;
    if (name === 'dragState') {
      if (m.result === 'dropped') { c.state = 'copying'; this.onChange(); } else this._finish(m.result === 'failed' ? 'failed' : 'cancelled');
    } else if (name === 'dragDone') {
      this._finish(m.ok ? 'dropped' : c.state === 'copying' ? 'failed' : 'cancelled');
    }
  }

  _finish(result) {
    const c = this.cur;
    this.cur = null;
    const where = c.where && /desktop$/i.test(c.where) ? 'Desktop' : c.where;
    if (!c.batch) this.link.send(where && result === 'dropped' ? { t: T.DRAG_END, drag: c.drag, result, where } : { t: T.DRAG_END, drag: c.drag, result });
    let ok = 0;
    for (const f of c.files.values()) {
      if (f.out) f.out.destroy();
      const good = result === 'dropped' && f.state === 'ok';
      if (good) ok++;
      if (f.id && !f.acked) this.link.send(good ? { t: T.FILE_DONE, id: f.id, ok: true } : { t: T.FILE_DONE, id: f.id, ok: false, error: result });
    }
    if (c.batch) { // a paste: the sender's batch ends with files.done; fclip.js shows the popup
      const all = ok === c.files.size && result === 'dropped';
      this.link.send({ t: T.FILES_DONE, batch: c.batch, ok: all, where: c.where, files: ok });
      if (this.onPasted) this.onPasted({ batch: c.batch, kind: 'paste', files: ok, count: c.files.size, ok: all });
    }
    const label = c.count > 1 ? c.count + ' items' : c.name;
    this.last = { ok: result === 'dropped', text: result === 'dropped' ? label + ' dropped' + (where ? ' in ' + where : '') : label + ': ' + result, at: Date.now() };
    setTimeout(() => fs.rm(c.dir, { recursive: true, force: true }, () => {}), 2000); // the target has read it
    this.onChange();
  }

  view() {
    const c = this.cur;
    return c ? { state: c.state, name: c.count > 1 ? c.count + ' items' : c.name, last: this.last } : { state: '', last: this.last };
  }
}

module.exports = DragRecv;
