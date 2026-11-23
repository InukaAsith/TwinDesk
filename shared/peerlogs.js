// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: the other devices' logs, here (docs/peer-logs.md). Every device answers `log.get` with a
// piece of its own TwinDesk.log or crash.log (shared/applog.js), unless "Let the other devices read
// this computer's log" is off; and every device copies the log of each connected device into its own log
// folder, under peers/<name>-<id>/, as it grows (every 30 s, only what's new). Anyone at any computer then
// reads every device's log as a file, and a report can carry them all.
//
// Wire (nothing else changes; an older app ignores both, logging the type once):
//   log.get  {req, file: 'TwinDesk.log' | 'crash.log', from: byte offset | null (the last INITIAL bytes)}
//   log.data {req, file, size, from, data: base64, more} | {req, error: 'off'}
// From: the offset in that device's current file. A smaller file than the offset (rotated, or a new
// start) is read from its last INITIAL bytes, and the copy here says so.
'use strict';

const fs = require('fs');
const path = require('path');

const CHUNK = 128 * 1024; // bytes in one log.data
const INITIAL = 1024 * 1024; // the first copy of a device's log: its last 1 MB
const KEEP = 10 * 1024 * 1024; // a copy here is rotated (.1.log) past this
const TICK_MS = 30000;
const RETRY_MS = 120000; // a device that didn't answer (an older app) is asked again after this
const CRASH_EVERY = 10; // crash.log every 10th tick (5 minutes)
const FILES = ['TwinDesk.log', 'crash.log'];

class PeerLogs {
  // bus: the hub's (on, send, connectedIds); nameOf(id); dir(): this app's log folder (applog.dir());
  // share(), collect(): the switches; log: console.log; now: Date.now.
  constructor(opts) {
    Object.assign(this, { log: (l) => console.log(l), now: () => Date.now(), tickMs: TICK_MS, share: () => true, collect: () => true }, opts);
    this.peers = new Map(); // id -> { next, pending: {req, file, at}, ticks, said: {} }
    this.req = 0;
    this.timer = null;
  }

  start() {
    this.bus.on('log.get', (m, from) => this._serve(m, from));
    this.bus.on('log.data', (m, from) => this._got(m, from));
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---- ours, to a device that asks ----

  _serve(m, from) {
    if (!m || typeof m !== 'object') return;
    const reply = (x) => this.bus.send(from, { t: 'log.data', req: m.req, ...x });
    if (!this.share()) return reply({ error: 'off' });
    const file = FILES.includes(m.file) ? m.file : 'TwinDesk.log';
    const dir = this.dir();
    if (!dir) return reply({ error: 'no log' });
    let fd = null;
    try {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) return reply({ file, size: 0, from: 0, data: '', more: false });
      fd = fs.openSync(p, 'r');
      const size = fs.fstatSync(fd).size;
      const asked = Number(m.from);
      const start = Number.isFinite(asked) && asked >= 0 && asked <= size && m.from !== null ? asked : Math.max(0, size - INITIAL);
      const len = Math.min(CHUNK, size - start);
      const buf = Buffer.alloc(len);
      if (len) fs.readSync(fd, buf, 0, len, start);
      reply({ file, size, from: start, data: buf.toString('base64'), more: start + len < size });
    } catch (e) {
      reply({ error: String(e.message || e).slice(0, 200) });
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* gone */ }
    }
  }

  // ---- theirs, copied here ----

  tick() {
    if (!this.collect()) return;
    const now = this.now();
    for (const id of this.bus.connectedIds()) {
      const p = this._peer(id);
      p.ticks++;
      if (p.pending && now - p.pending.at < (p.answered ? TICK_MS : RETRY_MS)) continue;
      if (p.ticks % CRASH_EVERY === 0) this._ask(id, 'crash.log', 0); // TwinDesk.log first, then now and then
      else this._ask(id, 'TwinDesk.log', p.next);
    }
  }

  _peer(id) {
    if (!this.peers.has(id)) this.peers.set(id, { next: null, pending: null, ticks: 0, answered: false, said: {} });
    return this.peers.get(id);
  }

  _ask(id, file, from) {
    const p = this._peer(id);
    const req = ++this.req;
    p.pending = { req, file, at: this.now() };
    this.bus.send(id, { t: 'log.get', req, file, from: from == null ? null : from });
  }

  _got(m, id) {
    const p = this.peers.get(id);
    if (!m || !p || !p.pending || m.req !== p.pending.req) return; // not ours, or late
    const file = p.pending.file;
    p.pending = null;
    p.answered = true;
    const folder = this._folder(id);
    if (m.error) {
      if (p.said.error !== m.error) {
        p.said.error = m.error;
        this._note(folder, m.error === 'off' ? 'Its log isn’t shared (its Multi-device tab).' : 'It couldn’t read its log: ' + m.error);
      }
      return;
    }
    p.said.error = null;
    const data = Buffer.from(typeof m.data === 'string' ? m.data : '', 'base64');
    try {
      fs.mkdirSync(folder, { recursive: true });
      if (file === 'crash.log') {
        if (m.from === 0) fs.writeFileSync(path.join(folder, 'crash.log'), data);
        if (m.more) this._ask(id, 'TwinDesk.log', p.next); // only its start: crash.log is short
        return;
      }
      const out = path.join(folder, 'TwinDesk.log');
      if (p.next !== null && m.from !== p.next) {
        this._append(out, Buffer.from(`\n---- ${new Date(this.now()).toISOString()} its log was rotated or started again: from here on, its last ${Math.round((m.size - m.from) / 1024)} KB ----\n`));
      } else if (p.next === null) {
        this._append(out, Buffer.from(`\n---- ${new Date(this.now()).toISOString()} copied from ${this.nameOf(id)} (${id}), its last ${Math.round((m.size - m.from) / 1024)} KB ----\n`));
      }
      this._append(out, data);
      p.next = m.from + data.length;
      if (m.more) this._ask(id, 'TwinDesk.log', p.next); // the rest now, not in 30 s
    } catch (e) {
      if (p.said.write !== e.code) {
        p.said.write = e.code;
        this.log(`[peerlogs] can't keep ${this.nameOf(id)}'s log in ${folder}: ${e.message}`);
      }
    }
  }

  _append(file, buf) {
    if (!buf.length) return;
    try {
      if (fs.statSync(file).size + buf.length > KEEP) fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
    } catch (_) { /* not there yet */ }
    fs.appendFileSync(file, buf);
  }

  _note(folder, text) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(path.join(folder, 'TwinDesk.log'), `\n---- ${new Date(this.now()).toISOString()} ${text} ----\n`);
    } catch (_) { /* nothing to do */ }
  }

  // peers/<name>-<id8>: the name for people, the id so that two devices with one name stay apart.
  _folder(id) {
    const name = String(this.nameOf(id) || 'device').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'device';
    return path.join(this.dir(), 'peers', `${name}-${String(id).slice(0, 8)}`);
  }
}

module.exports = { PeerLogs, CHUNK, INITIAL };
