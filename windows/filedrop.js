// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files dropped onto Monitor 2 → the Mac, and files and
// folders dragged across the edge (`drag.start` + `file.offer {drop:'drag', rel}`, the
// Mac shows a real drag and the drop target pulls the data): one file at a time over the control
// channel in base64 chunks, with a SHA-256 check. Waits while the socket is backed up so mouse and
// keyboard messages never sit behind a big file. Send files and pastes the other side
// asked for go the same way as batches (`drop:'send'|'paste'`, `batch`, `rel`), ended by `files.done`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;
const HIGH_WATER = 1024 * 1024;
const MAX_DRAG_FILES = 10000; // pause sending chunks above this many queued bytes
const ANSWER_MS = 15000; // offer → accept/refuse
// … through Bluetooth: the offer waits for Wi-Fi first (netlink.js holdOut, up to its 60 s
// ASK_TIMEOUT_MS, then it goes through Bluetooth), so the answer can't come before that.
const ANSWER_BLE_MS = 90000;
const DONE_MS = 120000; // end → done (the Mac hashes and moves the file)

class FileDrop {
  // opts: link, settings (shared), onProgress(view)
  constructor(opts) {
    Object.assign(this, opts);
    this.queue = [];
    this.busy = false;
    this.current = null; // {id, name, size, sent, index, count}
    this.last = null; // {name, ok, text}
    this.waiters = new Map(); // id → {resolve, types}
    for (const t of [T.FILE_ACCEPT, T.FILE_REFUSE, T.FILE_DONE, T.FILE_CANCEL]) this.link.on(t, (m) => this._answer(m));
    this.drag = null; // {drag, name} while a drag's files are being sent
    this.link.on(T.DRAG_END, (m) => this._dragEnd(m));
    this.batches = new Map(); // Batch → {kind, name, files, bytes}
    this.link.on(T.FILES_DONE, (m) => this._batchDone(m));
    this.link.on('closed', () => {
      this._abortAll('{Name} disconnected');
      for (const batch of [...this.batches.keys()]) this._batchDone({ batch, ok: false });
    });
  }

  // paths from the Monitor 2 drop (x/y normalized over the video, or null), or from a drag across
  // the edge (release = true: the Mac places them where its pointer is when the button comes up).
  drop(paths, x, y, release) {
    if (!this.settings.files.dropToMac) return this._report(null, false, 'Dropping files onto Monitor 2 is off (Files tab)');
    const files = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) files.push({ path: p, size: st.size });
      } catch (_) { /* gone */ }
    }
    if (!files.length) return this._report(null, false, 'Only files can be sent (not folders)');
    files.forEach((f, i) => this.queue.push({ ...f, x, y, release: !!release, index: i, count: files.length }));
    this._next();
  }

  // A drag across the edge: walk the folders. Returns what kvm.take and
  // beginDrag need, or null when nothing can go. Nothing is sent yet: kvm.take goes first.
  prepareDrag(paths) {
    if (!this.settings.files.dropToMac || this.link.status.state !== 'connected') return null;
    const d = plan(paths);
    return d && { drag: crypto.randomBytes(8).toString('hex'), ...d, count: d.items.length };
  }

  // Send files (kind 'send') or a paste the other side asked for (kind 'paste', batch =
  // the fclip id): every file offered in order with its folder path. Returns the plan, or null.
  sendBatch(paths, kind, batch = crypto.randomUUID()) {
    if (this.link.status.state !== 'connected') return null;
    const d = plan(paths);
    if (!d || !d.jobs.length) return null;
    const name = d.items.length === 1 ? d.items[0].name : d.items.length + ' items';
    this.batches.set(batch, { kind, name, files: d.jobs.length, bytes: d.bytes, sent: 0 });
    d.jobs.forEach((j, i) => this.queue.push({ ...j, batch, kind, index: i, count: d.jobs.length }));
    this._progress();
    this._next();
    return { batch, name, files: d.jobs.length, bytes: d.bytes, items: d.items };
  }

  // What a set of paths would send (fclip.js announces it before anything is sent).
  plan(paths) {
    return plan(paths);
  }

  _batchDone(m) {
    const b = this.batches.get(m.batch);
    if (!b) return;
    this.batches.delete(m.batch);
    this.queue = this.queue.filter((j) => j.batch !== m.batch);
    if (this.onBatchProgress) this.onBatchProgress({ ...b, done: true, ok: !!m.ok });
    this._report(b.name, !!m.ok, m.ok ? 'Sent' + (typeof m.where === 'string' && m.where ? ' to ' + m.where.slice(0, 300) : '') : 'Not everything arrived');
  }

  // Right after kvm.take: describe everything in `drag.start`, then send the files.
  beginDrag(d) {
    this.cancelRelease(); // one drag at a time
    const { drag, items, dirs, list, jobs, bytes } = d;
    this.drag = { drag, name: items.length > 1 ? items.length + ' items' : items[0].name };
    this.link.send({ t: T.DRAG_START, drag, items, dirs, list, files: list.length, bytes });
    jobs.forEach((j, i) => this.queue.push({ ...j, drag, index: i, count: jobs.length }));
    this._next();
  }

  // The Mac says how the drag ended: dropped (show where), or cancelled — stop sending.
  _dragEnd(m) {
    if (!this.drag || m.drag !== this.drag.drag) return;
    const d = this.drag;
    this.drag = null;
    if (m.result === 'dropped') this._report(d.name, true, 'Dropped on {name}' + (typeof m.where === 'string' && m.where ? ' in ' + m.where : ''));
    else {
      this._stopDrag(d.drag, false);
      this._report(d.name, false, m.result === 'failed' ? '{Name} couldn’t take the drag' : 'Drag cancelled');
    }
  }

  _stopDrag(drag, tellMac) {
    if (tellMac) this.link.send({ t: T.DRAG_CANCEL, drag });
    this.queue = this.queue.filter((j) => j.drag !== drag);
    if (this.current && this.current.drag === drag) this.cancel();
  }

  async _next() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      await this._send(job);
    } catch (e) {
      if (!job.batch) this._report(path.basename(job.path), false, e.message);
      else if (e.refused === 'not_allowed' && this.batches.has(job.batch)) { // turned off over there: the rest won't go either
        const b = this.batches.get(job.batch);
        this.batches.delete(job.batch);
        this.queue = this.queue.filter((j) => j.batch !== job.batch);
        this._report(b.name, false, e.message);
      } // other failures: files.done says how the batch went
    }
    this.current = null;
    this.busy = false;
    this._next();
  }

  async _send(job) {
    const name = path.basename(job.path);
    if (this.link.status.state !== 'connected') throw new Error('Not connected to {name}');
    if (job.size > P.FILE_MAX_BYTES) throw new Error('Too big');
    const id = crypto.randomBytes(8).toString('hex');
    this.current = { id, name, size: job.size, sent: 0, index: job.index, count: job.count, release: job.release, drag: job.drag, batch: job.batch };
    this._progress();
    const offer = { t: T.FILE_OFFER, id, name, size: job.size, index: job.index, count: job.count };
    if (job.drag) Object.assign(offer, { drop: 'drag', drag: job.drag, rel: job.rel });
    else if (job.batch) Object.assign(offer, { drop: job.kind, batch: job.batch, rel: job.rel, bytes: (this.batches.get(job.batch) || {}).bytes }); // bytes: the batch, for the receiver's progress
    else if (job.release) offer.drop = 'release';
    else { offer.drop = 'point'; if (typeof job.x === 'number') { offer.x = job.x; offer.y = job.y; } }
    this.link.send(offer);
    const c = this.link.current;
    const a = await this._wait(id, [T.FILE_ACCEPT, T.FILE_REFUSE, T.FILE_CANCEL], c && c.transport === 'ble' ? ANSWER_BLE_MS : ANSWER_MS);
    if (a.t !== T.FILE_ACCEPT) {
      const e = new Error(a.t === T.FILE_REFUSE ? refuseText(a.why) : 'Cancelled');
      e.refused = a.t === T.FILE_REFUSE ? a.why : '';
      throw e;
    }

    const hash = crypto.createHash('sha256');
    let seq = 0;
    const stream = fs.createReadStream(job.path, { highWaterMark: P.FILE_CHUNK_BYTES });
    try {
      for await (const chunk of stream) {
        if (!this.current || this.current.id !== id) throw new Error('Cancelled');
        while (this.link.bufferedAmount > HIGH_WATER) await sleep(15);
        if (this.link.status.state !== 'connected') throw new Error('{Name} disconnected');
        hash.update(chunk);
        this.link.send({ t: T.FILE_CHUNK, id, seq: seq++, data: chunk.toString('base64') });
        this.current.sent += chunk.length;
        if (job.batch && this.batches.has(job.batch)) {
          const b = this.batches.get(job.batch);
          b.sent += chunk.length;
          if (this.onBatchProgress) this.onBatchProgress(b); // The popup for big batches
        }
        this._progress();
      }
    } finally {
      stream.destroy();
    }
    this.link.send({ t: T.FILE_END, id, sha256: hash.digest('hex') });
    if (job.drag) return; // the Mac answers file.done when the drop target has it; drag.end says how it went
    const d = await this._wait(id, [T.FILE_DONE, T.FILE_CANCEL], DONE_MS);
    if (d.t !== T.FILE_DONE || !d.ok) throw new Error(d.error || '{Name} couldn’t save it');
    if (job.batch) return; // listed once, on files.done
    this._report(name, true, d.path ? 'Saved on {name}: ' + d.path : 'Saved on {name}');
  }

  _wait(id, types, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('{Name} didn’t answer')); }, ms);
      this.waiters.set(id, { types, resolve: (m) => { clearTimeout(timer); this.waiters.delete(id); resolve(m); }, reject: (e) => { clearTimeout(timer); this.waiters.delete(id); reject(e); } });
    });
  }

  _answer(m) {
    if (m.t === T.FILE_CANCEL && this.current && this.current.id === m.id) this.current.cancelled = true;
    const w = this.waiters.get(m.id);
    if (w && w.types.includes(m.t)) w.resolve(m);
  }

  // Input went home before the button came up: the dragged files don't go, and a
  // Drag is cancelled on the Mac.
  cancelRelease() {
    this.queue = this.queue.filter((j) => !j.release);
    if (this.current && this.current.release) this.cancel();
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this._stopDrag(d.drag, true);
    }
  }

  cancel() {
    if (!this.current) return;
    this.link.send({ t: T.FILE_CANCEL, id: this.current.id });
    const w = this.waiters.get(this.current.id);
    const b = this.current.batch && this.batches.get(this.current.batch);
    if (b) {
      this.batches.delete(this.current.batch);
      this._report(b.name, false, 'Cancelled');
    }
    if (!this.current.drag) this.queue = [];
    this.current = null; // the chunk loop stops at its next check
    if (w) w.reject(new Error('Cancelled'));
  }

  _abortAll(why) {
    this.queue = [];
    for (const w of [...this.waiters.values()]) w.reject(new Error(why));
  }

  _progress() {
    this.onProgress(this.view());
  }

  _report(name, ok, text) {
    this.last = { name, ok, text, at: Date.now() };
    this.onProgress(this.view());
  }

  view() {
    const c = this.current;
    const b = c && c.batch && this.batches.get(c.batch);
    return {
      current: c ? { name: c.name, size: c.size, sent: c.sent, index: c.index, count: c.count } : null,
      // The Send files / paste batch being sent, for the Files tab's progress bar
      batch: b ? { name: b.name, files: b.files, index: c.index, bytes: b.bytes, sent: b.sent, kind: b.kind } : null,
      queued: this.queue.length,
      last: this.last,
    };
  }
}

// Walk the paths (folders too): what drag.start and the batches need. Symbolic links are skipped.
function plan(paths) {
  const items = [], dirs = [], list = [], jobs = [];
  let bytes = 0;
  const walk = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      dirs.push(rel);
      let names = [];
      try { names = fs.readdirSync(abs); } catch (_) { /* unreadable: sent empty */ }
      for (const n of names.sort()) { if (list.length >= MAX_DRAG_FILES) return; walk(path.join(abs, n), rel + '/' + n); }
    } else if (st.isFile() && st.size <= P.FILE_MAX_BYTES && list.length < MAX_DRAG_FILES) {
      list.push({ rel, size: st.size });
      jobs.push({ path: abs, size: st.size, rel });
      bytes += st.size;
    }
  };
  for (const p of paths) {
    const name = path.basename(p);
    const before = bytes;
    let dir = false;
    try { dir = fs.lstatSync(p).isDirectory(); } catch (_) { continue; }
    walk(p, name);
    items.push({ name, dir, size: bytes - before });
  }
  if (!items.length) return null;
  return { items, dirs, list, jobs, bytes };
}

function refuseText(why) {
  return { not_allowed: '{Name} doesn’t accept dropped files (its Files tab)', too_big: 'Too big for {name}', busy: '{Name} is busy with another file' }[why] || '{Name} refused it';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = FileDrop;
