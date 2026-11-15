// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files waiting to go (Files › Send files), for the senders (mac/filesend.js, windows|linux/filedrop.js):
//   · sent while nothing is connected: they go when that device connects again;
//   · paused (Pause on a batch on its way): the files that hadn't arrived wait for Resume;
//   · cut off (the connection dropped mid-batch): the files that hadn't arrived go again on reconnect.
// Only paths are kept (no copies); a file that's gone by then is skipped. An entry that waited longer
// than Files › Keep files to send (settings.files.outboxHours, 0 = off) is dropped.
//
// Light: no timers, nothing polls. It's looked at when a device connects, when something is added,
// and when the Files page asks for its view. Kept in a small JSON file, so it outlives a restart.
//
// A continued batch (paused or cut off) is sent with cont: the first batch's id, and a receiver
// that knows it puts the rest into the same folders instead of "Photos 2" (mac/drop.js,
// windows|linux/filerecv.js). Older receivers ignore it.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_ENTRIES = 50;
const MAX_FILES = 10000;
const DEFAULT_HOURS = 24;
const HOURS = [0, 1, 24, 168]; // the choices on the Files page
const PAUSED_MS = 7 * 86400000;

class Outbox extends EventEmitter {
  // file: where it's kept (null: memory only, the tests). hours(): settings.files.outboxHours.
  // send(entry): hands an entry to the sender while connected → true when it went.
  // peer(): {id, name} of the device connected now, or null. paired(): {id, name} of the device this
  // one is paired with, for before any has connected since (just updated): files then wait for it.
  constructor({ file = null, hours = () => DEFAULT_HOURS, send, peer, paired = () => null, now = Date.now } = {}) {
    super();
    Object.assign(this, { file, hours, sendFn: send, peer, paired, now });
    this.entries = [];
    this.last = null; // the last device connected {id, name}: where files sent while offline go
    this._load();
  }

  get keepMs() {
    const h = Number(this.hours());
    return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_HOURS) * 3600 * 1000;
  }

  _load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(j.entries)) this.entries = j.entries.filter((e) => e && typeof e.id === 'string' && (Array.isArray(e.paths) || Array.isArray(e.list))).slice(0, MAX_ENTRIES);
      if (j.last && typeof j.last.id === 'string') this.last = { id: j.last.id, name: String(j.last.name || '') };
    } catch (_) { /* none yet */ }
    this._prune();
  }

  _save() {
    if (!this.file) return;
    try {
      if (!this.entries.length && !this.last) return fs.rmSync(this.file, { force: true });
      fs.writeFileSync(this.file, JSON.stringify({ entries: this.entries, last: this.last }));
    } catch (e) { console.error('[outbox] ' + e.message); }
  }

  _prune() {
    const keep = this.keepMs;
    const before = this.entries.length;
    // Paused ones wait for the user (even with Keep files to send off), but not forever either.
    this.entries = this.entries.filter((e) => this.now() - e.at < (e.state === 'paused' ? Math.max(keep, PAUSED_MS) : keep));
    return before !== this.entries.length;
  }

  _changed() {
    this._save();
    this.emit('change');
  }

  // A device connected (or the sender is ready again): remember it, send what waits for it.
  connected() {
    const p = this.peer();
    if (p && p.id) {
      const known = this.last && this.last.id === p.id && this.last.name === p.name;
      this.last = { id: p.id, name: String(p.name || '') };
      if (!known) this._save();
    }
    this.flush();
  }

  // Off-line (or right now while connected: then it simply goes). paths: what Send files got.
  // Returns 'sent' | 'queued' | null (nothing to keep: off, or no device ever connected).
  add(paths) {
    const p = this.peer();
    if (p && p.id && this.sendFn({ paths })) return 'sent';
    const to = (p && p.id) ? p : this.last || this._paired();
    if (!to || this.keepMs <= 0) return null;
    const list = paths.filter((x) => typeof x === 'string').slice(0, MAX_FILES);
    if (!list.length) return null;
    this._push({ id: crypto.randomUUID(), state: 'waiting', paths: list, name: nameOf(list), peer: to.id, peerName: to.name, at: this.now() });
    return 'queued';
  }

  // A batch that didn't finish: list [{path, rel, size}] of the files that didn't arrive.
  // why: 'paused' (waits for Resume) or 'cut' (goes again on reconnect). cont: the first batch's id.
  keep(list, { why, cont, name, peer }) {
    const files = list.filter((f) => f && typeof f.path === 'string' && typeof f.rel === 'string').slice(0, MAX_FILES);
    const to = peer || this.peer() || this.last || this._paired();
    if (!files.length || !to || !to.id) return null;
    if (why !== 'paused' && this.keepMs <= 0) return null;
    const e = { id: crypto.randomUUID(), state: why === 'paused' ? 'paused' : 'waiting', list: files, name: name || nameOf(files.map((f) => f.path)), cont, peer: to.id, peerName: to.name || '', at: this.now() };
    this._push(e);
    return e.id;
  }

  _paired() {
    const p = this.paired && this.paired();
    return p && typeof p.id === 'string' && p.id ? { id: p.id, name: String(p.name || '') } : null;
  }

  _push(e) {
    this.entries.push(e);
    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this._changed();
  }

  resume(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e || e.state !== 'paused') return false;
    e.state = 'waiting';
    e.at = this.now(); // its wait starts again
    this._changed();
    this.flush();
    return true;
  }

  remove(id) {
    const n = this.entries.length;
    this.entries = this.entries.filter((x) => x.id !== id);
    if (n !== this.entries.length) this._changed();
  }

  // Everything waiting for the device connected now goes, oldest first.
  flush() {
    const pruned = this._prune();
    const p = this.peer();
    if (!p || !p.id) { if (pruned) this._changed(); return; }
    let changed = pruned;
    for (const e of [...this.entries]) {
      if (e.state !== 'waiting' || e.peer !== p.id) continue;
      const entry = e.list ? { ...e, list: e.list.filter((f) => exists(f.path)) } : { ...e, paths: e.paths.filter(exists) };
      if (!(entry.list || entry.paths).length) { this.entries = this.entries.filter((x) => x !== e); changed = true; continue; }
      if (!this.sendFn(entry)) break; // the sender can't now: next time
      this.entries = this.entries.filter((x) => x !== e);
      changed = true;
    }
    if (changed) this._changed();
  }

  // For the Files page: [{id, state, name, files, peerName, at}].
  get view() {
    if (this._prune()) this._changed();
    return this.entries.map((e) => ({ id: e.id, state: e.state, name: e.name, files: (e.list || e.paths).length, peerName: e.peerName, at: e.at }));
  }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function nameOf(paths) {
  if (paths.length !== 1) return '';
  const s = String(paths[0]);
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

module.exports = { Outbox, HOURS, DEFAULT_HOURS };
