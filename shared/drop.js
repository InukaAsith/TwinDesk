// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop: one conversation for every TwinDesk device you have (phase 5 of the 2026-11-28 plan). Computers,
// Android and iPhone apps; a message goes to everyone or to one device; text, links, pictures and files
// (up to MAX_FILE, carried in the message). TwinDesk Web keeps its own Drop with its computer
// (shared/web/webhub.js); this is the apps' room.
//
// No server: each device keeps the room (capped: KEEP items, KEEP_BYTES of files) and passes on what a
// neighbour lacks. Computers keep every item, also one between two other devices (they relay for the
// devices behind them; it isn't shown), a phone keeps what it may see. A message is sent once to each
// direct link and passed on by whoever gets it the first time (de-duplicated by its id); a device that
// was away says which ids it has when a link comes up (drop.hi) and gets the rest back (drop.msgs).
// The order is the sender's time, then the id, so the room reads the same everywhere.
//
// On every direct link (computer↔computer, computer↔phone), both ways:
//   drop.hi   {ids: [..newest HI_IDS], gone: [ids], since?}   a link came up: what I have, which of those
//                                                 were deleted (since: my oldest listed item's time when
//                                                 the list is full: older ones aren't asked)
//   drop.msgs {items: [item]}                      what you lacked, newest MAX_ANSWER, a few MB at a time
//   drop.msg  {item}                               a new message
//   drop.del  {id, from, at, to}                   deleted for everyone by its sender (a tombstone)
//   drop.who  {} ← phone; {members: [{id, name, os, online}]} → phone: who it can send to (this computer
//             first), on link up and whenever the phone asks (its Drop page opened)
//   item: {id, from, name, os, at, to: '*' | device id, text?, file?: {name, size, mime, data (base64)}}
// A phone (leaf) is sent only what it may see: to everyone, to it, or from it. Older apps ignore drop.*.
//
// settings().drop: {on (default true), blocked: {id: name}}: a blocked device's messages aren't shown or
// announced here (a computer still passes them on, as it does the others' private ones). Off: drop.* is
// ignored and nothing is sent.
//
//   const room = new DropRoom({ selfId, name(), os, dir, settings(), save(), neighbors() → [ids],
//     send(id, msg) → bool, isLeaf(id), members() → [{id, name, os, online}], onChange(), onNew(item) })
//   room.up(id)              a direct link came up (sends drop.hi)
//   room.heard(t, m, from)   a drop.* message from a direct link
//   room.post({to, text, file: {path} | {name, mime, data}}) → {ok, id?, why?}  (why: off, empty, big, read)
//   room.del(id, everyone), room.clear(), room.read(), room.view(), room.state(), room.filePath(id)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const T = { HI: 'drop.hi', MSGS: 'drop.msgs', MSG: 'drop.msg', DEL: 'drop.del', WHO: 'drop.who' };
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TEXT = 8000;
const KEEP = 500;
const KEEP_BYTES = 200 * 1024 * 1024;
const HI_IDS = 300;
const MAX_ANSWER = 150;
const BATCH_BYTES = 6 * 1024 * 1024;
const VIEW = 300;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{8,64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const safeName = (n) => (str(n, 200).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim() || 'file');
const byTime = (a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// A received item, checked; null when it isn't one. Keeps the file's data (base64) when there is one.
function clean(m) {
  if (!m || typeof m !== 'object' || !ITEM_ID.test(m.id || '') || !ID.test(m.from || '')) return null;
  const at = Number(m.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const to = m.to === '*' || m.to === undefined ? '*' : ID.test(m.to) ? m.to : null;
  if (!to) return null;
  const it = { id: m.id, from: m.from, name: str(m.name, 64), os: str(m.os, 10), at: Math.round(at), to };
  if (m.gone === true) return { ...it, gone: true };
  const text = str(m.text, MAX_TEXT);
  if (text) it.text = text;
  if (m.file && typeof m.file === 'object') {
    const f = m.file;
    const size = Number(f.size);
    const data = typeof f.data === 'string' ? f.data : '';
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE || data.length > Math.ceil(MAX_FILE / 3) * 4 + 4 || !B64.test(data)) return null;
    const buf = Buffer.from(data, 'base64');
    if (buf.length !== size) return null;
    it.file = { name: safeName(f.name), size, mime: str(f.mime, 100) };
    it.data = buf;
  }
  if (!it.text && !it.file) return null;
  return it;
}

class DropRoom extends EventEmitter {
  constructor(o) {
    super();
    Object.assign(this, {
      os: '', neighbors: () => [], send: () => false, isLeaf: () => false, members: () => [], onChange: () => {}, onNew: () => {},
      keep: KEEP, keepBytes: KEEP_BYTES, now: () => Date.now(),
    }, o);
    this.root = path.join(this.dir, 'drop');
    this.file = path.join(this.root, 'room.json');
    this.items = null; // loaded on first use
    this.byId = new Map();
    this.k = 0; // local arrival counter: unread = theirs with k > read
    this.readK = 0;
    this.rev = 0;
    this.saveT = null;
  }

  get self() { return typeof this.selfId === 'function' ? this.selfId() : this.selfId; }
  get myName() { return typeof this.name === 'function' ? this.name() : this.name; }

  get cfg() {
    const s = this.settings();
    if (!s.drop || typeof s.drop !== 'object') s.drop = {};
    const d = s.drop;
    if (typeof d.on !== 'boolean') d.on = false; // off on a new install, as every feature
    if (!d.blocked || typeof d.blocked !== 'object') d.blocked = {};
    return d;
  }

  get isOn() { return this.cfg.on; }

  // ---- storage ----

  _load() {
    if (this.items) return;
    this.items = [];
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.k = Number(j.k) || 0;
      this.readK = Number(j.read) || 0;
      for (const x of Array.isArray(j.items) ? j.items : []) {
        if (!x || !ITEM_ID.test(x.id || '') || this.byId.has(x.id)) continue;
        this.items.push(x);
        this.byId.set(x.id, x);
      }
      this.items.sort(byTime);
    } catch (_) { /* a new room */ }
  }

  _save() {
    this.rev += 1;
    if (this.saveT) return;
    this.saveT = setTimeout(() => { this.saveT = null; this.flush(); }, 300);
    if (this.saveT.unref) this.saveT.unref();
  }

  flush() {
    if (!this.items) return;
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, k: this.k, read: this.readK, items: this.items }));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn('[drop] save: ' + e.message); }
  }

  filePath(id) {
    this._load();
    const x = this.byId.get(id);
    return x && x.file && x.file.path ? path.join(this.root, 'files', x.id, x.file.path) : '';
  }

  _writeFile(it, buf) {
    const dir = path.join(this.root, 'files', it.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, it.file.name), buf);
    it.file.path = it.file.name;
  }

  _dropFile(x) {
    if (x && x.file && x.file.path) fs.rm(path.join(this.root, 'files', x.id), { recursive: true, force: true }, () => {});
  }

  // The oldest go past KEEP items or KEEP_BYTES of files.
  _trim() {
    let bytes = 0;
    for (const x of this.items) if (x.file && x.file.path) bytes += x.file.size || 0;
    while (this.items.length > this.keep || (bytes > this.keepBytes && this.items.length)) {
      const x = this.items.shift();
      this.byId.delete(x.id);
      if (x.file && x.file.path) bytes -= x.file.size || 0;
      this._dropFile(x);
    }
  }

  // ---- who sees what ----

  _mine(x) { return x.to === '*' || x.to === this.self || x.from === this.self; }
  _shown(x) { return !x.hid && !x.gone && this._mine(x) && !(x.from !== this.self && this.cfg.blocked[x.from]); }
  _canSee(peer, x) { return !this.isLeaf(peer) || x.to === '*' || x.to === peer || x.from === peer; }

  // The item as it goes on a link (its file's data read here).
  _wire(x) {
    if (x.gone) return { id: x.id, from: x.from, name: x.name, os: x.os, at: x.at, to: x.to, gone: true };
    const w = { id: x.id, from: x.from, name: x.name, os: x.os, at: x.at, to: x.to };
    if (x.text) w.text = x.text;
    if (x.file) {
      let data = '';
      try { data = fs.readFileSync(this.filePath(x.id)).toString('base64'); } catch (_) { return null; }
      w.file = { name: x.file.name, size: x.file.size, mime: x.file.mime, data };
    }
    return w;
  }

  _flood(msg, except, x) {
    for (const id of this.neighbors()) {
      if (id === except || id === this.self || !this._canSee(id, x)) continue;
      this.send(id, msg);
    }
  }

  // ---- the links ----

  up(id) {
    if (!this.isOn || !id) return;
    this._load();
    const list = this.items.filter((x) => this._canSee(id, x)).slice(-HI_IDS);
    const hi = { t: T.HI, ids: list.map((x) => x.id), gone: list.filter((x) => x.gone).map((x) => x.id) };
    if (list.length === HI_IDS) hi.since = list[0].at;
    this.send(id, hi);
    if (this.isLeaf(id)) this._who(id);
  }

  // A phone's To picker: this computer and every device it knows (the phone itself left out).
  _who(id) {
    const me = { id: this.self, name: str(this.myName, 64), os: this.os, online: true };
    const others = (this.members() || []).filter((d) => d && d.id && d.id !== id && d.id !== this.self).slice(0, 32)
      .map((d) => ({ id: d.id, name: str(d.name, 64) || d.id.slice(0, 8), os: str(d.os, 10), online: !!d.online }));
    this.send(id, { t: T.WHO, members: [me, ...others] });
  }

  heard(t, m, from) {
    if (!this.isOn || !m || typeof m !== 'object' || !from) return;
    this._load();
    if (t === T.HI) return this._answer(m, from);
    if (t === T.WHO) { if (this.isLeaf(from)) this._who(from); return; }
    if (t === T.MSGS) {
      let any = false;
      for (const raw of Array.isArray(m.items) ? m.items.slice(0, MAX_ANSWER) : []) any = this._take(raw, from) || any;
      if (any) this.onChange();
      return;
    }
    if (t === T.MSG) { if (this._take(m.item, from)) this.onChange(); return; }
    if (t === T.DEL) { if (this._take({ ...m, gone: true }, from)) this.onChange(); }
  }

  _answer(m, from) {
    const have = new Set(Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string').slice(0, HI_IDS * 2) : []);
    const buried = new Set(Array.isArray(m.gone) ? m.gone.filter((x) => typeof x === 'string').slice(0, HI_IDS) : []);
    const since = Number(m.since) || 0;
    // What it hasn't got, and deletions it hasn't heard of (it still has the message).
    const lack = this.items.filter((x) => !x.hid && (!have.has(x.id) || (x.gone && !buried.has(x.id))) && x.at >= since && this._canSee(from, x)).slice(-MAX_ANSWER);
    let batch = [];
    let size = 0;
    for (const x of lack) {
      const w = this._wire(x);
      if (!w) continue;
      const n = w.file ? w.file.data.length : 200 + (w.text ? w.text.length : 0);
      if (batch.length && size + n > BATCH_BYTES) { this.send(from, { t: T.MSGS, items: batch }); batch = []; size = 0; }
      batch.push(w);
      size += n;
    }
    if (batch.length) this.send(from, { t: T.MSGS, items: batch });
  }

  // An item from a link: kept and passed on the first time. True when the room changed.
  _take(raw, from) {
    const it = clean(raw);
    if (!it) return false;
    if (this.isLeaf(from) && it.from !== from) return false; // a phone only speaks for itself
    if (it.from === this.self && !this.byId.has(it.id) && !it.gone) return false; // ours, cleared here: not back
    const old = this.byId.get(it.id);
    if (old) {
      if (!it.gone || old.gone || old.from !== it.from) return false;
      this._bury(old);
      this._flood({ t: T.DEL, id: it.id, from: it.from, at: it.at, to: it.to }, from, it);
      this._save();
      return true;
    }
    const data = it.data;
    delete it.data;
    if (it.file) {
      try { this._writeFile(it, data); } catch (e) { console.warn('[drop] file: ' + e.message); return false; }
    }
    it.k = ++this.k;
    this._insert(it);
    this._save();
    // Passed on: the wire form again (the data still in hand).
    const w = it.gone ? { t: T.DEL, id: it.id, from: it.from, at: it.at, to: it.to } : { t: T.MSG, item: { ...this._strip(it), ...(it.file ? { file: { name: it.file.name, size: it.file.size, mime: it.file.mime, data: data.toString('base64') } } : {}) } };
    this._flood(w, from, it);
    if (this._shown(it) && it.from !== this.self) this.onNew(this._public(it));
    return true;
  }

  _strip(x) {
    const w = { id: x.id, from: x.from, name: x.name, os: x.os, at: x.at, to: x.to };
    if (x.text) w.text = x.text;
    return w;
  }

  _insert(it) {
    let i = this.items.length;
    while (i > 0 && byTime(this.items[i - 1], it) > 0) i -= 1;
    this.items.splice(i, 0, it);
    this.byId.set(it.id, it);
    this._trim();
  }

  _bury(x) {
    this._dropFile(x);
    delete x.text;
    delete x.file;
    x.gone = true;
  }

  // ---- this device ----

  post({ to = '*', text = '', file = null } = {}) {
    if (!this.isOn) return { ok: false, why: 'off' };
    this._load();
    const it = { id: crypto.randomUUID(), from: this.self, name: str(this.myName, 64), os: this.os, at: this.now(), to: to === '*' || !ID.test(to || '') ? '*' : to };
    const t = str(String(text || '').trim(), MAX_TEXT);
    if (t) it.text = t;
    let buf = null;
    if (file) {
      try {
        if (file.path) {
          const st = fs.statSync(file.path);
          if (!st.isFile()) return { ok: false, why: 'read' };
          if (st.size > MAX_FILE) return { ok: false, why: 'big' };
          buf = fs.readFileSync(file.path);
          it.file = { name: safeName(path.basename(file.path)), size: buf.length, mime: str(file.mime, 100) || mimeOf(file.path) };
        } else {
          buf = Buffer.from(String(file.data || ''), 'base64');
          if (buf.length > MAX_FILE) return { ok: false, why: 'big' };
          it.file = { name: safeName(file.name), size: buf.length, mime: str(file.mime, 100) || mimeOf(file.name || '') };
        }
        this._writeFile(it, buf);
      } catch (_) { return { ok: false, why: 'read' }; }
    }
    if (!it.text && !it.file) return { ok: false, why: 'empty' };
    it.k = ++this.k;
    this.readK = this.k;
    this._insert(it);
    this._save();
    const w = { ...this._strip(it) };
    if (it.file) w.file = { name: it.file.name, size: it.file.size, mime: it.file.mime, data: buf.toString('base64') };
    this._flood({ t: T.MSG, item: w }, null, it);
    this.onChange();
    return { ok: true, id: it.id };
  }

  // Delete for me (hidden here, never sent again) or for everyone (only the sender's own).
  del(id, everyone) {
    this._load();
    const x = this.byId.get(id);
    if (!x || x.gone) return false;
    if (everyone) {
      if (x.from !== this.self) return false;
      this._bury(x);
      this._flood({ t: T.DEL, id: x.id, from: x.from, at: x.at, to: x.to }, null, x);
    } else {
      this._dropFile(x);
      delete x.text;
      delete x.file;
      x.hid = true;
    }
    this._save();
    this.onChange();
    return true;
  }

  clear() {
    this._load();
    for (const x of this.items) if (this._mine(x) && !x.hid && !x.gone) { this._dropFile(x); delete x.text; delete x.file; x.hid = true; }
    this._save();
    this.onChange();
  }

  read() {
    this._load();
    if (this.readK === this.k) return;
    this.readK = this.k;
    this._save();
    this.onChange();
  }

  setOn(on) {
    this.cfg.on = !!on;
    this.save();
    if (on) for (const id of this.neighbors()) this.up(id);
    this.onChange();
  }

  block(id, on, name) {
    if (!ID.test(id || '') || id === this.self) return;
    if (on) this.cfg.blocked[id] = str(name, 64) || id.slice(0, 8);
    else delete this.cfg.blocked[id];
    this.save();
    this.onChange();
  }

  unread() {
    if (!this.items) return 0;
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const x = this.items[i];
      if (x.k > this.readK && x.from !== this.self && this._shown(x)) n += 1;
    }
    return n;
  }

  _public(x) {
    const p = { id: x.id, from: x.from, name: x.name, os: x.os, at: x.at, to: x.to, mine: x.from === this.self };
    if (x.text) p.text = x.text;
    if (x.file) p.file = { name: x.file.name, size: x.file.size, mime: x.file.mime, image: /^image\/(?:png|jpe?g|gif|webp|bmp)$/.test(x.file.mime || '') };
    return p;
  }

  // The page: the room as this device sees it.
  view() {
    const on = this.isOn;
    if (on) this._load();
    const members = (this.members() || []).filter((d) => d && d.id && d.id !== this.self).map((d) => ({ id: d.id, name: str(d.name, 64) || d.id.slice(0, 8), os: str(d.os, 10), online: !!d.online }));
    const names = new Map(members.map((d) => [d.id, d.name]));
    const items = on ? this.items.filter((x) => this._shown(x)).slice(-VIEW).map((x) => {
      const p = this._public(x);
      if (x.to !== '*') p.toName = x.to === this.self ? str(this.myName, 64) : names.get(x.to) || '';
      return p;
    }) : [];
    const blocked = Object.entries(this.cfg.blocked).map(([id, name]) => ({ id, name }));
    return { on, me: this.self, members, items, unread: this.unread(), blocked, maxFile: MAX_FILE };
  }

  // What every state push carries (small): the page asks for view() when rev changes.
  state() {
    return { on: this.isOn, unread: this.isOn ? this.unread() : 0, rev: this.rev };
  }
}

// settings.drop as the settings files keep it (Windows and Linux normalize every section): off until
// turned on, and up to 64 blocked devices.
function normalize(d) {
  const o = d && typeof d === 'object' ? d : {};
  const blocked = {};
  if (o.blocked && typeof o.blocked === 'object') for (const [id, name] of Object.entries(o.blocked).slice(0, 64)) if (ID.test(id)) blocked[id] = str(name, 64);
  return { on: o.on === true, blocked };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', zip: 'application/zip' };
function mimeOf(p) { return MIME[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream'; }

module.exports = { DropRoom, T, clean, normalize, MAX_FILE, MAX_TEXT, KEEP, HI_IDS, mimeOf };
