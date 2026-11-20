// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copies made while the other device is away (offline, asleep, out of range), kept in memory and
// handed over when it's back (clip.queue). They go in its Recent list, not on its clipboard: only
// a copy made while both are connected changes what the other side pastes. Clipboard › Queue
// copies while away (on by default) and Put the latest on the clipboard (off) on the receiving side.
// Text only, never on disk; at most MAX items (the oldest go) and MAX_BYTES in all.
'use strict';

const P = require('./protocol.js');

const MAX = 50;
const MAX_BYTES = 1024 * 1024;

class ClipQueue {
  constructor() {
    this.items = []; // oldest first: {text, at}
  }

  get size() { return this.items.length; }

  // A copy here while nobody took it. False: not kept (empty, too big, the same as the last one).
  add(text, maxKB = 256) {
    if (typeof text !== 'string' || !text || !P.clipAllowed(text) || Buffer.byteLength(text, 'utf8') > maxKB * 1024) return false;
    const last = this.items[this.items.length - 1];
    if (last && last.text === text) return false;
    this.items = this.items.filter((x) => x.text !== text); // copied again: it moves to the end
    this.items.push({ text, at: Date.now() });
    while (this.items.length > MAX) this.items.shift();
    while (this.items.length > 1 && bytes(this.items) > MAX_BYTES) this.items.shift();
    return true;
  }

  // The message to send (null: nothing queued); the queue empties.
  take() {
    if (!this.items.length) return null;
    const items = this.items;
    this.items = [];
    return { t: P.T.CLIP_QUEUE, items };
  }

  clear() { this.items = []; }
}

function bytes(items) {
  return items.reduce((n, x) => n + Buffer.byteLength(x.text, 'utf8'), 0);
}

// The items of a clip.queue that came in, oldest first, checked: [{text, at}].
function itemsOf(m) {
  const list = m && Array.isArray(m.items) ? m.items.slice(-MAX) : [];
  const out = [];
  let total = 0;
  for (const x of list) {
    if (!x || !P.clipAllowed(x.text) || !x.text) continue;
    total += Buffer.byteLength(x.text, 'utf8');
    if (total > MAX_BYTES) break;
    const at = Number(x.at);
    out.push({ text: x.text, at: Number.isFinite(at) && at > 0 && at <= Date.now() + 60000 ? at : Date.now() });
  }
  return out;
}


// Multi-device: a queue for each device seen since this app started that isn't connected now. A
// copy here (a look every 2 s, only while some device is away) goes in the queue of each one away;
// when one is back and its clip.policy says queue, its own queue goes to it (clip.queue, straight
// to it, not through the pool). clip: the mesh Clip (cfg, bus, lastSync, _readText, _remember,
// clipboard, onChange); concealed(): the clipboard holds a password now.
class MeshClipQueue {
  constructor(clip, { concealed = async () => false, nameOf = (id) => id } = {}) {
    this.clip = clip;
    this.concealed = concealed;
    this.nameOf = nameOf;
    this.queues = new Map(); // device id -> ClipQueue
    this.known = new Set();
    this.seen = null;
    this.timer = setInterval(() => this._look(), 2000);
    if (this.timer.unref) this.timer.unref();
  }

  get size() {
    let n = 0;
    for (const q of this.queues.values()) n += q.size;
    return n;
  }

  welcome(id) { this.known.add(id); }

  _away() {
    const on = new Set(this.clip.bus.connectedIds());
    return [...this.known].filter((id) => !on.has(id));
  }

  async _look() {
    const c = this.clip.cfg;
    const away = c.enabled && c.send && c.queue !== false ? this._away() : [];
    if (!away.length) { this.seen = null; return; }
    let t;
    try { t = await this.clip._readText(); } catch (_) { return; }
    if (this.seen === null) { this.seen = t; return; } // what was there already isn't a copy
    if (t === this.seen) return;
    this.seen = t;
    if (!t || t === this.clip.lastSync.received || require('./otp.js').isQuiet(t)) return;
    if (c.skipConcealed && (await this.concealed().catch(() => false))) return;
    let added = false;
    for (const id of this._away()) {
      if (!this.queues.has(id)) this.queues.set(id, new ClipQueue());
      if (this.queues.get(id).add(t, c.maxKB)) added = true;
    }
    if (added) this.clip.onChange();
  }

  // Its clip.policy: it takes queued copies (and the clipboard at all).
  policy(id, m) {
    const q = this.queues.get(id);
    const c = this.clip.cfg;
    if (!q || !q.size || !m || m.queue !== true || m.accept === false || !c.enabled || !c.send) return;
    const msg = q.take();
    if (!this.clip.bus.send(id, msg)) { for (const x of msg.items) q.add(x.text, c.maxKB); return; }
    this.clip.onChange();
  }

  // Copies a device made while we were away: in Recent; on the clipboard only the latest, with
  // Put the latest on the clipboard on.
  async receive(m, from) {
    const clip = this.clip;
    const c = clip.cfg;
    if (!c.enabled || !c.receive) return;
    const items = itemsOf(m);
    if (!items.length) return;
    const name = this.nameOf(from);
    for (const x of items) clip._remember('in', x.text, name, x.at);
    if (c.queueLatest) {
      const last = items[items.length - 1].text;
      let now = '';
      try { now = await clip._readText(); } catch (_) { /* write it */ }
      if (now !== last) clip.clipboard.writeText(last);
      clip.lastSync.received = last;
      clip.seen = last;
      this.seen = last;
    }
    clip.onChange();
  }

  destroy() { clearInterval(this.timer); }
}

module.exports = { ClipQueue, MeshClipQueue, itemsOf, MAX, MAX_BYTES };
