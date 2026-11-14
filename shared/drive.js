// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Drive: one folder kept the same on every device that turns it on (docs/drive.md). Each
// device keeps its own copy, so it works offline; when two devices meet they swap what changed.
// This file is the engine, one per device: the index, scanning, merging what another device has,
// and placing what it downloads. shared/drive-link.js carries it over a session.
//
// The index, per file (by its path in the folder, '/'-separated, NFC):
//   {s: size, m: mtime (ms), h: SHA-256 hex ('' when deleted), d: deleted, v: {deviceId: n}, by}
// v is a version vector: each device counts its own changes to that file. Comparing two:
//   one newer (every count ≥, one >): take it. The same: nothing to do. Neither (both changed it
//   since they last agreed): a conflict. Every device picks the same winner (the later mtime, then
//   the larger device id); the losing side keeps its own copy as "name (conflict from Device
//   date).ext" before taking the winner's, so nothing is lost. A deletion never wins against an edit.
// A deleted file stays in the index (d) so the deletion reaches devices that were away, and it goes
// to the Trash or Recycle Bin, never straight away, and only when the file is still what was seen.
// Downloads go to .twindesk/ inside the folder, are checked against their hash, and are renamed into
// place only if the file there didn't change meanwhile.
//
// Every change goes through one queue (_run), so a scan, a merge and a download never race.
//
// new Drive({me, meName, folder, indexFile, trash, watch}):
//   me, meName: this device's id and name. folder(): the folder now. indexFile: where the index is kept.
//   trash(abs) -> Promise: to the Trash (shell.trashItem). watch: fs.watch the folder (off in tests).
// Events: 'changed' (entries: what this device changed, for the others), 'change' (status).
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const TMP_DIR = '.twindesk';
const MAX_FILES = 100000;
const MAX_DEPTH = 32;
const MAX_REL = 1024;
const SETTLE_MS = 2000; // a file written this recently is still being written: looked at again later
const SCAN_MS = 60000; // a full scan this often, as well as on every change fs.watch sees
const WATCH_DEBOUNCE_MS = 1500;
const SAVE_MS = 1000;

// Never synced: system clutter, office lock files, unfinished downloads, our own temp folder.
const IGNORE = [
  /^\.twindesk$/, /^\.DS_Store$/, /^\._/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^Icon\r$/,
  /^~\$/, /^\.~lock\..*#$/, /\.(crdownload|part|partial|download)$/i, /^\.Trash/, /^\$RECYCLE\.BIN$/i,
  /^System Volume Information$/i, /^\.fseventsd$/, /^\.Spotlight-V100$/,
];
const ignored = (name) => IGNORE.some((r) => r.test(name));

// Names Windows can't hold (the file stays on the devices that can, and is listed as skipped here).
const WIN_BAD = /[<>:"|?*\u0000-\u001f]|[. ]$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// A path from another device, checked: relative, '/'-separated, no '..', nothing odd. null when bad.
function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_REL) return null;
  const n = rel.normalize('NFC');
  if (n.startsWith('/') || n.includes('\\') || n.includes('\u0000')) return null;
  const parts = n.split('/');
  if (parts.length > MAX_DEPTH) return null;
  for (const p of parts) if (!p || p === '.' || p === '..' || ignored(p)) return null;
  return n;
}

// Whether this system can hold that path (Windows' rules on Windows).
function holdable(rel, platform = process.platform) {
  if (platform !== 'win32') return true;
  return rel.split('/').every((p) => !WIN_BAD.test(p) && !WIN_RESERVED.test(p));
}

// ---- version vectors ----
function cleanV(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  let n = 0;
  for (const [k, c] of Object.entries(v)) {
    if (typeof k !== 'string' || k.length > 64 || !Number.isSafeInteger(c) || c < 1) continue;
    out[k] = c;
    if (++n >= 64) break;
  }
  return out;
}
// 'eq', 'gt' (a newer), 'lt' (b newer) or 'cc' (concurrent: a conflict).
function cmp(a, b) {
  let gt = false, lt = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] || 0, y = b[k] || 0;
    if (x > y) gt = true;
    else if (x < y) lt = true;
  }
  return gt && lt ? 'cc' : gt ? 'gt' : lt ? 'lt' : 'eq';
}
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, c] of Object.entries(b)) out[k] = Math.max(out[k] || 0, c);
  return out;
};
const bump = (v, me) => ({ ...v, [me]: (v[me] || 0) + 1 });

// The winner of a conflict between two files: the same answer on every device.
function wins(a, b) {
  if (a.m !== b.m) return a.m > b.m;
  return String(a.by) > String(b.by);
}

// An entry from another device, checked (null when bad).
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const p = cleanRel(e.p);
  const v = cleanV(e.v);
  if (!p || !Object.keys(v).length) return null;
  const d = e.d === true;
  const h = d ? '' : typeof e.h === 'string' && /^[0-9a-f]{64}$/.test(e.h) ? e.h : null;
  if (h === null) return null;
  const s = d ? 0 : Number.isSafeInteger(e.s) && e.s >= 0 ? e.s : -1;
  if (s < 0) return null;
  const m = Number.isFinite(e.m) && e.m > 0 ? Math.floor(e.m) : 0;
  return { p, s, m, h, d, v, by: typeof e.by === 'string' ? e.by.slice(0, 64) : '' };
}

function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs).on('error', reject).on('data', (b) => h.update(b)).on('end', () => resolve(h.digest('hex')));
  });
}

function stamp(t = Date.now()) {
  const d = new Date(t), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

// "report.docx" -> "report (conflict from Mac 2026-11-14 1530).docx"
function conflictName(rel, who, t) {
  const dir = path.posix.dirname(rel), base = path.posix.basename(rel);
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  const name = `${stem} (conflict from ${String(who || 'another device').replace(/[/\\:]/g, '_').slice(0, 40)} ${stamp(t)})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

class Drive extends EventEmitter {
  constructor({ me, meName = '', folder, indexFile, trash, watch = true, platform = process.platform, now = () => Date.now() }) {
    super();
    if (!me) throw new Error('Drive needs this device id');
    Object.assign(this, { me, meName, folderFn: folder, indexFile, trashFn: trash, watchOn: watch, platform, now });
    this.index = new Map(); // rel -> entry
    this.disk = new Map(); // rel -> its name on disk, when that isn't rel (another normalization)
    this.skipped = new Set(); // rels this system can't hold
    this.pending = new Map(); // rel -> downloads on their way: a scan meanwhile doesn't call it deleted
    this.q = Promise.resolve();
    this.state = 'off';
    this.lastError = '';
    this.lastSync = 0;
    this.conflicts = 0;
    this.saveTimer = null;
    this.scanTimer = null;
    this.watcher = null;
    this.watchTimer = null;
    this.retryTimer = null;
  }

  get folder() {
    return this.folderFn();
  }

  abs(rel) {
    return path.join(this.folder, ...(this.disk.get(rel) || rel).split('/'));
  }

  // ---- life ----
  async start() {
    if (this.state !== 'off') return;
    this.state = 'starting';
    await fsp.mkdir(this.folder, { recursive: true });
    await fsp.mkdir(path.join(this.folder, TMP_DIR), { recursive: true }).catch(() => {});
    this._clearTmp();
    this._load();
    this.state = 'idle';
    if (this.watchOn) this._watch();
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
    if (this.scanTimer.unref) this.scanTimer.unref();
    await this.scan();
  }

  async stop() {
    clearInterval(this.scanTimer);
    clearTimeout(this.watchTimer);
    clearTimeout(this.retryTimer);
    if (this.watcher) try { this.watcher.close(); } catch { /* closed */ }
    this.watcher = null;
    await this.q.catch(() => {});
    this._saveNow();
    this.state = 'off';
    this.emit('change');
  }

  _run(fn) {
    const p = this.q.then(fn, fn);
    this.q = p.catch((e) => { this.lastError = e && e.message ? e.message : String(e); });
    return p;
  }

  _clearTmp() {
    const dir = path.join(this.folder, TMP_DIR);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) if (n.startsWith('dl-')) try { fs.unlinkSync(path.join(dir, n)); } catch { /* gone */ }
  }

  // ---- the index on disk ----
  _load() {
    this.index.clear();
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { /* none yet */ }
    if (!data || data.v !== 1 || data.folder !== this.folder || !Array.isArray(data.entries)) return; // another folder: start over
    for (const raw of data.entries) {
      const e = cleanEntry(raw);
      if (e) this.index.set(e.p, e);
    }
  }

  _save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this._saveNow(), SAVE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  _saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.indexFile) return;
    const data = { v: 1, folder: this.folder, entries: [...this.index.values()] };
    const tmp = this.indexFile + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.indexFile);
    } catch (e) {
      this.lastError = e.message;
    }
  }

  // ---- watching ----
  _watch() {
    try {
      // Recursive on macOS and Windows, and on Linux with Node 20+; the minute's scan covers the rest.
      this.watcher = fs.watch(this.folder, { recursive: true }, (_ev, name) => {
        if (name && String(name).split(/[\\/]/).some((p) => p === TMP_DIR)) return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.scan(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch {
      this.watcher = null;
    }
  }

  // ---- scanning: what changed here ----
  scan() {
    return this._run(() => this._scan());
  }

  async _scan() {
    if (this.state === 'off') return [];
    this.state = 'scanning';
    this.emit('change');
    const root = this.folder;
    const seen = new Set();
    const changed = [];
    let unsettled = false;
    const files = [];
    const walk = async (dirAbs, relDir, depth) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let list;
      try { list = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const ent of list) {
        if (ignored(ent.name)) continue;
        const abs = path.join(dirAbs, ent.name);
        const relDisk = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) await walk(abs, relDisk, depth + 1);
        else if (ent.isFile() && files.length < MAX_FILES) files.push({ abs, relDisk });
        // symlinks and everything else: never followed, never synced
      }
    };
    await walk(root, '', 1);
    const now = this.now();
    for (const { abs, relDisk } of files) {
      const rel = relDisk.normalize('NFC');
      if (!cleanRel(rel)) continue;
      if (rel !== relDisk) this.disk.set(rel, relDisk);
      else this.disk.delete(rel);
      seen.add(rel);
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      const m = Math.floor(st.mtimeMs);
      const L = this.index.get(rel);
      if (L && !L.d && L.s === st.size && L.m === m) continue; // unchanged
      if (now - m < SETTLE_MS) { unsettled = true; continue; } // still being written
      let h;
      try { h = await hashFile(abs); } catch { continue; }
      if (L && !L.d && L.h === h) { // touched, not changed
        this.index.set(rel, { ...L, s: st.size, m });
        continue;
      }
      const e = { p: rel, s: st.size, m, h, d: false, v: bump(L ? L.v : {}, this.me), by: this.me };
      this.index.set(rel, e);
      changed.push(e);
    }
    for (const [rel, L] of this.index) {
      if (L.d || seen.has(rel) || this.skipped.has(rel) || this.pending.has(rel)) continue;
      const e = { p: rel, s: 0, m: now, h: '', d: true, v: bump(L.v, this.me), by: this.me };
      this.index.set(rel, e);
      changed.push(e);
    }
    if (unsettled) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.scan(), SETTLE_MS + 500);
      if (this.retryTimer.unref) this.retryTimer.unref();
    }
    this.state = 'idle';
    if (changed.length) {
      this._save();
      this.emit('changed', changed);
    }
    this.emit('change');
    return changed;
  }

  // Everything, for a device that just connected.
  entries() {
    return [...this.index.values()].filter((e) => !this.skipped.has(e.p));
  }

  // ---- merging: what another device has ----
  // remote: its entries (as sent). peerName: for a conflict copy's name. Resolves to the downloads
  // needed: [{p, h, s, m, entry}] — get each and hand it to adopt().
  merge(remote, peerName = '') {
    return this._run(() => this._merge(remote, peerName));
  }

  async _merge(remote, peerName) {
    if (this.state === 'off') return [];
    await this._scan(); // what's here first, so a change made a moment ago counts
    const pulls = [];
    const changed = [];
    for (const raw of Array.isArray(remote) ? remote : []) {
      const R = cleanEntry(raw);
      if (!R) continue;
      if (!holdable(R.p, this.platform)) {
        if (!R.d) this.skipped.add(R.p);
        continue;
      }
      const L = this.index.get(R.p);
      if (!L) {
        if (R.d) { this.index.set(R.p, R); changed.push(R); } // a deletion of something never here: remembered, and passed on
        else if (await this._exists(R.p)) { // there, but not seen yet (a scan will): a conflict later
          continue;
        } else pulls.push(this._pull(R, R.v));
        continue;
      }
      const c = cmp(R.v, L.v);
      if (c === 'eq' || c === 'lt') continue;
      if (c === 'gt') {
        if (R.d) {
          if (!L.d && !(await this._unchanged(L))) continue; // changed here meanwhile: the next scan makes it a conflict
          if (!L.d) await this._trash(R.p);
          this.index.set(R.p, R);
          changed.push(R);
        } else if (!L.d && L.h === R.h) {
          const e = { ...R, s: L.s, m: L.m }; // the same file: only the version
          this.index.set(R.p, e);
          changed.push(e);
        } else pulls.push(this._pull(R, R.v, L));
        continue;
      }
      // a conflict: both changed it
      if (R.d && L.d) {
        const e = { ...L, v: merge(L.v, R.v) };
        this.index.set(R.p, e);
        changed.push(e);
      } else if (R.d) { // deleted there, edited here: the edit stays, and now it's newer
        const e = { ...L, v: bump(merge(L.v, R.v), this.me), by: this.me };
        this.index.set(R.p, e);
        changed.push(e);
      } else if (L.d) { // deleted here, edited there: theirs comes back
        pulls.push(this._pull(R, merge(L.v, R.v), L));
      } else if (L.h === R.h) { // both made the same file
        const e = { ...L, v: merge(L.v, R.v) };
        this.index.set(R.p, e);
        changed.push(e);
      } else if (wins(R, L)) { // theirs wins: ours is kept beside it, then theirs comes
        if (!(await this._unchanged(L))) continue;
        await this._keepAsConflict(R.p);
        pulls.push(this._pull(R, merge(L.v, R.v), null));
      }
      // ours wins: nothing here; the other device keeps its copy as the conflict and takes ours
    }
    this._save();
    if (changed.length) this.emit('changed', changed);
    this.emit('change');
    return pulls;
  }

  _pull(R, v, L = null) {
    const pull = { p: R.p, h: R.h, s: R.s, m: R.m, entry: { ...R, v }, expect: L && !L.d ? { s: L.s, m: L.m } : null };
    this.pending.set(R.p, (this.pending.get(R.p) || 0) + 1);
    return pull;
  }

  // A download that won't come (the other device left, it failed): the file may be looked at again.
  release(pull) {
    const n = (this.pending.get(pull.p) || 0) - 1;
    if (n > 0) this.pending.set(pull.p, n);
    else this.pending.delete(pull.p);
  }

  async _exists(rel) {
    try { await fsp.lstat(this.abs(rel)); return true; } catch { return false; }
  }

  // The file is still what the index says (size and mtime), or gone.
  async _unchanged(L) {
    try {
      const st = await fsp.stat(this.abs(L.p));
      return st.size === L.s && Math.floor(st.mtimeMs) === L.m;
    } catch {
      return true;
    }
  }

  async _trash(rel) {
    const abs = this.abs(rel);
    try { await fsp.lstat(abs); } catch { return; }
    await this.trashFn(abs);
    await this._pruneDirs(path.dirname(abs));
  }

  // Folders a deletion emptied go too (never the Drive folder itself).
  async _pruneDirs(dir) {
    const root = path.resolve(this.folder);
    while (path.resolve(dir).startsWith(root + path.sep)) {
      try {
        const left = (await fsp.readdir(dir)).filter((n) => n !== '.DS_Store');
        if (left.length) return;
        await fsp.rm(path.join(dir, '.DS_Store'), { force: true });
        await fsp.rmdir(dir);
      } catch { return; }
      dir = path.dirname(dir);
    }
  }

  async _keepAsConflict(rel) {
    let name = conflictName(rel, this.meName, this.now());
    for (let i = 2; await this._exists(name); i++) name = conflictName(rel, `${this.meName} ${i}`, this.now());
    await fsp.rename(this.abs(rel), path.join(this.folder, ...name.split('/')));
    this.conflicts++;
    // The copy is a new file here: the next scan sends it to everyone.
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.scan(), 50);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // ---- downloads ----
  // Where a download goes first.
  tempPath() {
    return path.join(this.folder, TMP_DIR, 'dl-' + crypto.randomBytes(8).toString('hex'));
  }

  // A download finished at tmp: checked and put in place (resolves true), or thrown away (false).
  adopt(pull, tmp) {
    return this._run(() => this._adopt(pull, tmp));
  }

  async _adopt(pull, tmp) {
    try {
      return await this._place(pull, tmp);
    } finally {
      this.release(pull);
    }
  }

  async _place(pull, tmp) {
    const drop = () => fsp.rm(tmp, { force: true });
    if (this.state === 'off') { await drop(); return false; }
    let h;
    try { h = await hashFile(tmp); } catch { await drop(); return false; }
    if (h !== pull.h) { await drop(); return false; }
    const L = this.index.get(pull.p);
    // Something newer came in meanwhile, or the file here changed since the merge: not this one.
    if (L && cmp(pull.entry.v, L.v) === 'lt') { await drop(); return false; }
    const abs = this.abs(pull.p);
    let st = null;
    try { st = await fsp.stat(abs); } catch { /* not there */ }
    if (st && pull.expect && (st.size !== pull.expect.s || Math.floor(st.mtimeMs) !== pull.expect.m)) { await drop(); return false; }
    if (st && !pull.expect && !(L && L.d)) { await drop(); return false; } // a file appeared there meanwhile
    if (await this._caseClash(pull.p)) { await drop(); this.skipped.add(pull.p); return false; }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (st && pull.expect) await this.trashFn(abs).catch(() => {}); // the old version to the Trash, as a deletion would
    await fsp.rename(tmp, abs);
    const m = pull.m ? new Date(pull.m) : new Date();
    await fsp.utimes(abs, m, m).catch(() => {});
    const now = await fsp.stat(abs);
    const e = { ...pull.entry, s: now.size, m: Math.floor(now.mtimeMs) };
    this.index.set(pull.p, e);
    this.lastSync = this.now();
    this._save();
    this.emit('changed', [e]); // passed on: a device that only this one meets gets it from here
    this.emit('change');
    return true;
  }

  // On a Mac or a PC, "Report.txt" and "report.txt" are one file: the second can't come.
  async _caseClash(rel) {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return false;
    const dir = path.dirname(this.abs(rel)), base = path.basename(rel);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return false; }
    return names.some((n) => n !== base && n.normalize('NFC').toLowerCase() === base.toLowerCase());
  }

  // ---- serving another device ----
  // The file at rel when it's still the version with hash h: {abs, size}, else null.
  async open(rel, h) {
    const p = cleanRel(rel);
    const L = p && this.index.get(p);
    if (!L || L.d || L.h !== h) return null;
    try {
      const st = await fsp.stat(this.abs(p));
      if (st.size !== L.s || Math.floor(st.mtimeMs) !== L.m) return null; // changed: a scan will say so
      return { abs: this.abs(p), size: st.size };
    } catch {
      return null;
    }
  }

  // ---- for the page ----
  status() {
    let files = 0, bytes = 0;
    for (const e of this.index.values()) if (!e.d) { files++; bytes += e.s; }
    return { state: this.state, files, bytes, skipped: this.skipped.size, conflicts: this.conflicts, lastSync: this.lastSync, error: this.lastError };
  }
}

module.exports = { Drive, cleanRel, cleanEntry, holdable, cmp, merge, bump, wins, conflictName, ignored, TMP_DIR };
