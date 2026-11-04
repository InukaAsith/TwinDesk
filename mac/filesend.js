// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sends files to the PC: a drag
// of files and folders is planned (every folder and file by relative path), announced with
// `drag.start`, then each file is offered (`drop:'drag'`, `rel`) and sent one at a time in order —
// chunks with backpressure on the socket (so input and pings never wait behind a big file), then
// `file.end` with the SHA-256. The PC answers `drag.end` (dropped / cancelled / failed).
//
// With an app that can, on the network or a cable, the bytes go over HTTPS instead, up to four files
// at once (shared/fastfile.js, this.server.fx; not in Multi-device).
//
// `drag.policy {accept}` both ways: our Files switch "Drag files across the screen edge" and the PC's.
//
// Events: 'change' — this.view changed; 'dragEnd' (drag id) — the PC finished or dropped a drag;
//         'policy' — the PC's drag.policy changed.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const HIGH_WATER = 1024 * 1024; // pause reading while the socket has more than this queued
const MAX_FILES = 10000;
const MAX_DEPTH = 32;

// A name as one protocol path segment (no `:`, `\` or control characters).
const segment = (n) => String(n).replace(/[\u0000-\u001f:\\]/g, '_');

// Files and folders as a drag: items (top level), dirs and list (every file, sending order) by
// relative path. Symlinks are skipped; a package (.app…) goes as the folder it is.
function planDrag(paths) {
  const items = [], dirs = [], list = [];
  const walk = (abs, rel, depth) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return null; }
    if (st.isFile()) {
      if (list.length >= MAX_FILES) return null;
      list.push({ rel, size: st.size, path: abs });
      return st.size;
    }
    if (!st.isDirectory() || depth > MAX_DEPTH) return null;
    dirs.push(rel);
    let total = 0;
    let names = [];
    try { names = fs.readdirSync(abs).sort(); } catch { /* unreadable: sent empty */ }
    for (const n of names) {
      if (n === '.DS_Store') continue;
      total += walk(path.join(abs, n), `${rel}/${segment(n)}`, depth + 1) || 0;
    }
    return total;
  };
  const seen = new Set();
  for (const p of paths) {
    const name = segment(path.basename(p));
    if (!name || name === '.' || name === '..' || seen.has(name)) continue;
    let dir;
    try { dir = fs.lstatSync(p).isDirectory(); } catch { continue; }
    const size = walk(p, name, 1);
    if (size === null) continue;
    seen.add(name);
    items.push({ name, dir, size });
  }
  if (!items.length) return null;
  return { items, dirs, list, files: list.length, bytes: list.reduce((s, f) => s + f.size, 0) };
}

class FileSend extends EventEmitter {
  constructor(server, getSettings) {
    super();
    this.server = server;
    this.getSettings = getSettings;
    this.peerDrag = true; // the PC takes drags across the edge (assumed until it says otherwise)
    server.on('client', () => {
      this.peerDrag = true;
      this.sendPolicy();
      this.emit('policy');
    });
    server.on(`t:${P.T.DRAG_POLICY}`, (m) => {
      this.peerDrag = m.accept !== false;
      this.emit('policy');
      this._changed();
    });
    this.outgoing = new Map(); // id -> { id, name, size, path, sent, state, drag? } in sending order
    this.recent = []; // newest first: { name, size, at, ok, where|error }
    this.drags = new Map(); // drag id -> { name, bytes }
    this.batches = new Map(); // Batch id -> { kind: 'send'|'paste', name, files, bytes }
    this.pumping = 0; // files being sent
    this.ready = []; // ids accepted and not sending yet, in the order they were accepted (= offered)
    server.on(`t:${P.T.FILE_ACCEPT}`, (m) => {
      const f = this.outgoing.get(m.id);
      if (f && f.state === 'offered') {
        f.state = 'accepted';
        this.ready.push(f.id);
      }
      this._next();
    });
    server.on(`t:${P.T.DRAG_END}`, (m) => this._dragEnd(m));
    server.on(`t:${P.T.FILES_DONE}`, (m) => this._batchDone(m));
    server.on(`t:${P.T.FILE_REFUSE}`, (m) => this._finish(m.id, false, `refused (${m.why || 'no reason'})`));
    server.on(`t:${P.T.FILE_DONE}`, (m) => this._finish(m.id, !!m.ok, m.ok ? m.path : m.error));
    server.on(`t:${P.T.FILE_CANCEL}`, (m) => this._finish(m.id, false, `cancelled on ${this.server.current ? this.server.current.name : 'the other computer'}`));
    server.on('closed', () => {
      if (!server.current) {
        for (const id of [...this.outgoing.keys()]) this._finish(id, false, 'the other computer disconnected');
        for (const drag of [...this.drags.keys()]) this._dragEnd({ drag, result: 'failed' });
        for (const batch of [...this.batches.keys()]) this._batchDone({ batch, ok: false });
      }
    });
  }

  // Our "Drag files across the screen edge" switch (both directions).
  get dragOn() {
    return this.getSettings().files.dragEdge !== false;
  }

  sendPolicy() {
    this.server.sendToClient({ t: P.T.DRAG_POLICY, accept: this.dragOn });
  }

  planDrag(paths) {
    return planDrag(paths);
  }

  // drag.start + one offer per file (call right after kvm.take). Returns the drag id.
  startDrag(plan) {
    const drag = crypto.randomUUID();
    const one = plan.items.length === 1;
    this.drags.set(drag, { name: one ? plan.items[0].name : `${plan.items.length} items`, bytes: plan.bytes });
    this.server.sendToClient({
      t: P.T.DRAG_START, drag, items: plan.items, dirs: plan.dirs,
      list: plan.list.map((f) => ({ rel: f.rel, size: f.size })), files: plan.files, bytes: plan.bytes,
    });
    plan.list.forEach((f, index) => {
      const id = crypto.randomUUID();
      const name = f.rel.slice(f.rel.lastIndexOf('/') + 1);
      this.outgoing.set(id, { id, name, size: f.size, path: f.path, sent: 0, state: 'offered', drag });
      this.server.sendToClient({ t: P.T.FILE_OFFER, id, name, size: f.size, drop: 'drag', drag, rel: f.rel, index, count: plan.files });
    });
    this._changed();
    return drag;
  }

  // Send files (kind 'send') or a paste the peer asked for (kind 'paste', batch = the
  // fclip id). Every file is offered in order with its relative path; the peer answers files.done.
  sendBatch(paths, kind, batch = crypto.randomUUID()) {
    const plan = planDrag(paths);
    if (!plan || !plan.files) return null;
    const one = plan.items.length === 1;
    this.batches.set(batch, { kind, name: one ? plan.items[0].name : `${plan.items.length} items`, items: plan.items.length, files: plan.files, bytes: plan.bytes, at: Date.now() });
    plan.list.forEach((f, index) => {
      const id = crypto.randomUUID();
      const name = f.rel.slice(f.rel.lastIndexOf('/') + 1);
      this.outgoing.set(id, { id, name, size: f.size, path: f.path, sent: 0, state: 'offered', batch });
      this.server.sendToClient({ t: P.T.FILE_OFFER, id, name, size: f.size, drop: kind, batch, rel: f.rel, index, count: plan.files, bytes: plan.bytes }); // bytes: batch total, for the receiver's progress
    });
    this._changed();
    return { batch, files: plan.files, bytes: plan.bytes, name: this.batches.get(batch).name };
  }

  _batchDone(m) {
    const b = this.batches.get(m.batch);
    if (!b) return;
    this.batches.delete(m.batch);
    for (const f of [...this.outgoing.values()]) if (f.batch === m.batch) this.outgoing.delete(f.id);
    const where = typeof m.where === 'string' ? m.where.slice(0, 300) : '';
    this.recent.unshift({ name: b.name, size: b.bytes, at: Date.now(), ok: !!m.ok, ...(m.ok ? { where } : { error: 'not everything arrived' }) });
    this.recent.length = Math.min(this.recent.length, 20);
    this.emit('batchDone', { ...b, batch: m.batch, ok: !!m.ok });
    this._changed();
  }

  // Went home before the drop (tell: send drag.cancel), or the PC ended the drag.
  cancelDrag(drag, tell) {
    if (tell && this.drags.has(drag)) this.server.sendToClient({ t: P.T.DRAG_CANCEL, drag });
    for (const f of [...this.outgoing.values()]) {
      if (f.drag !== drag) continue;
      if (this.server.fx) this.server.fx.cancel(f.id);
      this.server.sendToClient({ t: P.T.FILE_CANCEL, id: f.id });
      this._finish(f.id, false, 'cancelled');
    }
    if (tell) this._dragEnd({ drag, result: 'cancelled' });
  }

  // Our drag came back home with the button still held (kvm.home drag.back): it goes on here as our
  // own drag, so its transfer stops and it isn't listed as cancelled.
  forgetDrag(drag) {
    this.cancelDrag(drag, false);
    this.drags.delete(drag);
    this._changed();
  }

  _dragEnd(m) {
    const d = this.drags.get(m.drag);
    if (!d) return;
    console.log(`[drag] out ${m.drag}: ${m.result}${m.where ? ` in ${m.where}` : ''}`);
    this.drags.delete(m.drag);
    const ok = m.result === 'dropped';
    if (!ok) this.cancelDrag(m.drag, false);
    const where = typeof m.where === 'string' ? m.where.slice(0, 300) : '';
    this.recent.unshift({ name: d.name, size: d.bytes, at: Date.now(), ok, ...(ok ? { where } : { error: m.result === 'failed' ? `${this.server.current ? this.server.current.name : 'the other computer'} couldn’t take it` : 'cancelled' }) });
    this.recent.length = Math.min(this.recent.length, 20);
    this.emit('dragEnd', m.drag);
    this._changed();
  }

  // In offer order (a drag's files arrive in the order the PC listed them): one at a time, or a
  // few at once with fast files.
  _next() {
    const fx = this.server.fx;
    for (;;) {
      let f = null;
      while (this.ready.length && !f) { // a queue, not a scan of every file (10,000 files took seconds)
        const x = this.outgoing.get(this.ready[0]);
        if (x && x.state === 'accepted') f = x;
        else this.ready.shift(); // gone (cancelled, finished): skipped
      }
      if (!f || this.pumping >= (fx ? fx.parallelFor(f.size) : 1)) return;
      this.ready.shift();
      this.pumping++;
      this._pump(f.id).catch(() => {}).finally(() => {
        this.pumping--;
        this._next();
      });
    }
  }

  // Fast files: true when it went (or failed for good), false to send it the old way.
  async _fast(f) {
    const fx = this.server.fx;
    if (!fx || !fx.usable()) return false;
    const id = f.id;
    let shown = 0;
    try {
      const sha256 = await fx.send(id, f.path, f.size, (n) => {
        f.sent += n;
        if (f.sent - shown >= 4 * 1024 * 1024) {
          shown = f.sent;
          this._changed();
        }
      });
      if (this.outgoing.has(id)) this.server.sendToClient({ t: P.T.FILE_END, id, sha256, ...fx.endFields(id) }); // fx2: the ranges' hashes
    } catch (e) {
      if (!this.outgoing.has(id)) return true; // cancelled
      if (e.early) {
        console.log(`[files] fast files didn’t work (${e.message}): sending the usual way`);
        return false;
      }
      this.server.sendToClient({ t: P.T.FILE_CANCEL, id });
      this._finish(id, false, e.message);
    }
    return true;
  }

  async _pump(id) {
    const f = this.outgoing.get(id);
    if (!f || f.state !== 'accepted') return;
    f.state = 'sending';
    if (await this._fast(f)) return;
    const ws = this.server.current && this.server.current.ws;
    const hash = crypto.createHash('sha256');
    let seq = 0;
    try {
      const stream = fs.createReadStream(f.path, { highWaterMark: P.FILE_CHUNK_BYTES });
      for await (const chunk of stream) {
        if (!this.outgoing.has(id) || !ws || ws.readyState !== ws.OPEN) return stream.destroy();
        while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 10));
        hash.update(chunk);
        this.server.sendToClient({ t: P.T.FILE_CHUNK, id, seq: seq++, data: chunk.toString('base64') });
        f.sent += chunk.length;
        if (seq % 64 === 0) this._changed();
      }
      if (this.outgoing.has(id)) this.server.sendToClient({ t: P.T.FILE_END, id, sha256: hash.digest('hex') });
    } catch (e) {
      this.server.sendToClient({ t: P.T.FILE_CANCEL, id });
      this._finish(id, false, e.message);
    }
  }

  _finish(id, ok, info) {
    const f = this.outgoing.get(id);
    if (!f) return;
    this.outgoing.delete(id);
    if (f.drag || f.batch) return this._changed(); // listed once, on drag.end / files.done
    this.recent.unshift({ name: f.name, size: f.size, at: Date.now(), ok, ...(ok ? { where: info } : { error: info }) });
    this.recent.length = Math.min(this.recent.length, 20);
    this._changed();
  }

  // 'change', at most every 250 ms (the last one always goes): 10,000 small files redrew the window
  // for each one.
  _changed() {
    if (this._changeTimer) return void (this._changeLater = true);
    this.emit('change');
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      if (this._changeLater) { this._changeLater = false; this._changed(); }
    }, 250);
    if (this._changeTimer.unref) this._changeTimer.unref();
  }

  // Files on their way: a batch as one entry {name, items, files, left, bytes, sent, at}; the others
  // one by one (the first few).
  get view() {
    const batches = new Map([...this.batches].map(([id, b]) => [id, { kind: b.kind, name: b.name, items: b.items, files: b.files, left: 0, bytes: b.bytes, sent: b.bytes, at: b.at }]));
    const sending = [];
    let more = 0;
    for (const f of this.outgoing.values()) {
      const b = f.batch && batches.get(f.batch);
      if (b) { b.left++; b.sent -= f.size - f.sent; }
      else if (sending.length < 5) sending.push({ name: f.name, size: f.size, sent: f.sent });
      else more++;
    }
    return {
      peerDrag: this.peerDrag,
      sending,
      sendingMore: more,
      outBatches: [...batches.values()],
      sent: this.recent,
    };
  }
}

module.exports = { FileSend };
