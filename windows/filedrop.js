// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files dropped onto Monitor 2 → the Mac, and files and
// folders dragged across the edge (`drag.start` + `file.offer {drop:'drag', rel}`, the
// Mac shows a real drag and the drop target pulls the data): one file at a time over the control
// channel in base64 chunks, with a SHA-256 check. Waits while the socket is backed up so mouse and
// keyboard messages never sit behind a big file. Send files and pastes the other side
// asked for go the same way as batches (`drop:'send'|'paste'`, `batch`, `rel`), ended by `files.done`.
// With an app that can, on the network or a cable, the bytes go over HTTPS instead, up to four files
// at once (shared/fastfile.js, link.fx; not in Multi-device).
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
    this.sending = 0; // jobs being sent (one, or a few with fast files)
    this.active = new Map(); // id → {id, name, size, sent, index, count, …} being sent
    this.progressAt = -Infinity;
    this.current = null; // the newest of them, for the view
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
    if (!this.settings.files.dropToMac) return this._report(null, false, 'Dropping files onto Monitor 2 is off (Files tab)', 'Dropping files onto Monitor 2 is off (Files tab)');
    const files = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) files.push({ path: p, size: st.size });
      } catch (_) { /* gone */ }
    }
    if (!files.length) return this._report(null, false, 'Only files can be sent (not folders)', 'Only files can be sent (not folders)');
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
    if (this.link.status.state !== 'connected' || this.batches.has(batch)) return null;
    const d = plan(paths);
    if (!d || !d.jobs.length) return null;
    const name = d.items.length === 1 ? d.items[0].name : d.items.length + ' items';
    this.batches.set(batch, { kind, name, itemCount: d.items.length, files: d.jobs.length, bytes: d.bytes, sent: 0 });
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
    const folder = typeof m.where === 'string' ? m.where.slice(0, 300) : '';
    this._report(b.name, !!m.ok, m.ok ? 'Sent' + (folder ? ' to ' + folder : '') : 'Not everything arrived',
      m.ok ? (folder ? 'Sent to {folder}' : 'Sent') : 'Not everything arrived', folder ? { folder } : {}, b.itemCount);
  }

  // Right after kvm.take: describe everything in `drag.start`, then send the files.
  beginDrag(d) {
    this.cancelRelease(); // one drag at a time
    const { drag, items, dirs, list, jobs, bytes } = d;
    this.drag = { drag, name: items.length > 1 ? items.length + ' items' : items[0].name, itemCount: items.length };
    this.link.send({ t: T.DRAG_START, drag, items, dirs, list, files: list.length, bytes });
    jobs.forEach((j, i) => this.queue.push({ ...j, drag, index: i, count: jobs.length }));
    this._next();
  }

  // The Mac says how the drag ended: dropped (show where), or cancelled — stop sending.
  _dragEnd(m) {
    if (!this.drag || m.drag !== this.drag.drag) return;
    const d = this.drag;
    this.drag = null;
    if (m.result === 'dropped') {
      const folder = typeof m.where === 'string' ? m.where : '';
      this._report(d.name, true, 'Dropped on {name}' + (folder ? ' in ' + folder : ''),
        folder ? 'Dropped on {name} in {folder}' : 'Dropped on {name}', folder ? { folder } : {}, d.itemCount);
    }
    else {
      this._stopDrag(d.drag, false);
      const message = m.result === 'failed' ? '{Name} couldn’t take the drag' : 'Drag cancelled';
      this._report(d.name, false, message, message, {}, d.itemCount);
    }
  }

  _stopDrag(drag, tellMac) {
    if (tellMac) this.link.send({ t: T.DRAG_CANCEL, drag });
    this.queue = this.queue.filter((j) => j.drag !== drag);
    this._cancelWhere((c) => c.drag === drag);
  }

  _next() {
    const fx = this.link.fx;
    while (this.queue.length && this.sending < (fx ? fx.parallelFor(this.queue[0].size) : 1)) {
      const job = this.queue.shift();
      this.sending++;
      this._run(job).finally(() => {
        this.sending--;
        this._next();
      });
    }
  }

  async _run(job) {
    try {
      await this._send(job);
    } catch (e) {
      if (!job.batch) this._report(path.basename(job.path), false, e.message, e.messageKey, e.messageVars);
      else if (e.refused === 'not_allowed' && this.batches.has(job.batch)) { // turned off over there: the rest won't go either
        const b = this.batches.get(job.batch);
        this.batches.delete(job.batch);
        this.queue = this.queue.filter((j) => j.batch !== job.batch);
        this._report(b.name, false, e.message, e.messageKey, e.messageVars, b.itemCount);
      } // other failures: files.done says how the batch went
    }
  }

  async _send(job) {
    const name = path.basename(job.path);
    if (this.link.status.state !== 'connected') throw localError('Not connected to {name}');
    if (job.size > P.FILE_MAX_BYTES) throw localError('Too big');
    const id = crypto.randomBytes(8).toString('hex');
    const cur = { id, name, size: job.size, sent: 0, index: job.index, count: job.count, release: job.release, drag: job.drag, batch: job.batch };
    this.current = cur;
    this.active.set(id, cur);
    try {
      await this._sendFile(job, cur);
    } catch (e) {
      if (this.active.get(id) === cur && !cur.cancelled && this.link.status.state === 'connected') this.link.send({ t: T.FILE_CANCEL, id });
      throw e;
    } finally {
      this.active.delete(id);
      if (this.current === cur) this.current = [...this.active.values()].pop() || null;
    }
  }

  async _sendFile(job, cur) {
    const { id, name } = cur;
    this._progress();
    const offer = { t: T.FILE_OFFER, id, name, size: job.size, index: job.index, count: job.count };
    if (job.drag) Object.assign(offer, { drop: 'drag', drag: job.drag, rel: job.rel });
    else if (job.batch) Object.assign(offer, { drop: job.kind, batch: job.batch, rel: job.rel, bytes: (this.batches.get(job.batch) || {}).bytes }); // bytes: the batch, for the receiver's progress
    else if (job.release) offer.drop = 'release';
    else { offer.drop = 'point'; if (typeof job.x === 'number') { offer.x = job.x; offer.y = job.y; } }
    const c = this.link.current;
    const a = await this._request(offer, [T.FILE_ACCEPT, T.FILE_REFUSE, T.FILE_CANCEL], c && c.transport === 'ble' ? ANSWER_BLE_MS : ANSWER_MS);
    if (a.t !== T.FILE_ACCEPT) {
      const e = localError(a.t === T.FILE_REFUSE ? refuseText(a.why) : 'Cancelled');
      e.refused = a.t === T.FILE_REFUSE ? a.why : '';
      throw e;
    }

    const sha256 = (await this._fast(job, cur)) || (await this._chunks(job, cur));
    const fx2 = this.link.fx ? this.link.fx.endFields(id) : {}; // fx2: the ranges' hashes
    this._check(cur);
    if (job.drag) {
      this.link.send({ t: T.FILE_END, id, sha256, ...fx2 });
      return; // the Mac answers file.done when the drop target has it; drag.end says how it went
    }
    const d = await this._request({ t: T.FILE_END, id, sha256, ...fx2 }, [T.FILE_DONE, T.FILE_CANCEL], DONE_MS);
    if (d.t !== T.FILE_DONE || !d.ok) throw d.error ? new Error(d.error) : localError('{Name} couldn’t save it');
    if (job.batch) return; // listed once, on files.done
    this._report(name, true, d.path ? 'Saved on {name}: ' + d.path : 'Saved on {name}',
      d.path ? 'Saved on {name}: {path}' : 'Saved on {name}', d.path ? { path: d.path } : {});
  }

  // Fast files: the SHA-256 once it went, or null to send it the old way (an older app, Bluetooth, a
  // Wi-Fi link netlink made, or it didn't work before any byte went).
  async _fast(job, cur) {
    const fx = this.link.fx;
    if (!fx || !fx.usable()) return null;
    let shown = 0;
    try {
      return await fx.send(cur.id, job.path, job.size, (n) => {
        const now = Date.now();
        this._sent(job, cur, n, now - shown >= 100);
        if (now - shown >= 100) shown = now;
      });
    } catch (e) {
      if (this.active.get(cur.id) !== cur) throw localError('Cancelled');
      if (!e.early) {
        this.link.send({ t: T.FILE_CANCEL, id: cur.id });
        throw e;
      }
      console.log('[files] fast files didn’t work (' + e.message + '): sending the usual way');
      return null;
    }
  }

  // The usual way: base64 file.chunk messages on the session's socket. Returns the SHA-256.
  async _chunks(job, cur) {
    this._check(cur);
    const id = cur.id;
    const hash = crypto.createHash('sha256');
    let seq = 0;
    const stream = fs.createReadStream(job.path, { highWaterMark: P.FILE_CHUNK_BYTES });
    try {
      for await (const chunk of stream) {
        this._check(cur);
        while (this.link.bufferedAmount > HIGH_WATER) {
          await sleep(15);
          this._check(cur);
        }
        this._check(cur);
        hash.update(chunk);
        if (!this.link.send({ t: T.FILE_CHUNK, id, seq: seq++, data: chunk.toString('base64') })) throw new Error('{Name} disconnected');
        this._sent(job, cur, chunk.length, true);
      }
    } finally {
      stream.destroy();
    }
    return hash.digest('hex');
  }

  _check(cur) {
    if (this.active.get(cur.id) !== cur || cur.cancelled) throw localError('Cancelled');
    if (cur.error) throw new Error(cur.error);
    if (this.link.status.state !== 'connected') throw localError('{Name} disconnected');
  }

  _request(message, types, ms) {
    const answer = this._wait(message.id, types, ms);
    try {
      if (!this.link.send(message)) this.waiters.get(message.id)?.reject(localError('{Name} disconnected'));
    } catch (e) {
      this.waiters.get(message.id)?.reject(e);
    }
    return answer;
  }

  _sent(job, cur, n, show) {
    cur.sent += n;
    const b = job.batch && this.batches.get(job.batch);
    if (b) b.sent += n;
    const now = Date.now();
    if (!show || now - this.progressAt < 100) return;
    this.progressAt = now;
    if (b && this.onBatchProgress) this.onBatchProgress(b); // The popup for big batches
    this._progress();
  }

  _wait(id, types, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(localError('{Name} didn’t answer')); }, ms);
      this.waiters.set(id, { types, resolve: (m) => { clearTimeout(timer); this.waiters.delete(id); resolve(m); }, reject: (e) => { clearTimeout(timer); this.waiters.delete(id); reject(e); } });
    });
  }

  _answer(m) {
    const c = this.active.get(m.id);
    if (m.t === T.FILE_CANCEL && c) c.cancelled = true;
    if (m.t === T.FILE_DONE && c && !m.ok) c.error = m.error || '{Name} couldn’t save it';
    const w = this.waiters.get(m.id);
    if (w && w.types.includes(m.t)) w.resolve(m);
  }

  // Input went home before the button came up: the dragged files don't go, and a
  // Drag is cancelled on the Mac.
  cancelRelease() {
    this.queue = this.queue.filter((j) => !j.release);
    this._cancelWhere((c) => c.release);
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this._stopDrag(d.drag, true);
    }
  }

  // Stop what's being sent (with fast files, every file in flight).
  cancel() {
    this.queue = [];
    this._cancelWhere(() => true);
  }

  _cancelWhere(matches) {
    for (const c of [...this.active.values()]) {
      if (!matches(c)) continue;
      this.link.send({ t: T.FILE_CANCEL, id: c.id });
      const w = this.waiters.get(c.id);
      const b = c.batch && this.batches.get(c.batch);
      if (b) {
        this.batches.delete(c.batch);
        this.queue = this.queue.filter((j) => j.batch !== c.batch);
        this._report(b.name, false, 'Cancelled', 'Cancelled', {}, b.itemCount);
      }
      this.active.delete(c.id); // the chunk loop stops at its next check
      if (this.link.fx) this.link.fx.cancel(c.id);
      if (w) w.reject(localError('Cancelled'));
    }
    this.current = [...this.active.values()].pop() || null;
    this._progress();
  }

  _abortAll(why) {
    this.queue = [];
    for (const c of this.active.values()) if (this.link.fx) this.link.fx.cancel(c.id);
    this.active.clear();
    this.current = null;
    for (const w of [...this.waiters.values()]) w.reject(localError(why));
  }

  _progress() {
    this.onProgress(this.view());
  }

  _report(name, ok, text, messageKey, messageVars = {}, itemCount) {
    this.last = { name, ok, text, at: Date.now(), ...(messageKey ? { messageKey, messageVars } : {}), ...(itemCount > 1 ? { itemCount } : {}) };
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

// Local presentation metadata; the legacy message and file protocol stay unchanged.
function localError(message) {
  return Object.assign(new Error(message), { messageKey: message });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = FileDrop;
