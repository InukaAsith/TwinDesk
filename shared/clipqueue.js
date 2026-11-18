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
  constructor(clip, { concealed = async () => false, nameOf = (id) => id,
    activePair = (id) => id, knownPair = () => true, currentSocket = () => null, changed = () => clip.onChange() } = {}) {
    this.clip = clip;
    this.concealed = concealed;
    this.nameOf = nameOf;
    this.queues = new Map(); // device id -> ClipQueue
    this.changed = changed;
    this.activePair = activePair;
    this.knownPair = knownPair;
    this.currentSocket = currentSocket;
    this.known = new Map();
    this.epoch = 0;
    this.pasteEpoch = 0;
    this.seen = null;
    this.timer = setInterval(() => this._look(), 2000);
    if (this.timer.unref) this.timer.unref();
  }

  get size() {
    let n = 0;
    for (const q of this.queues.values()) n += q.size;
    return n;
  }

  welcome(id) {
    const pair = this.activePair(id);
    if (this.known.get(id) !== pair) this.queues.delete(id);
    if (pair) this.known.set(id, pair);
    else this.known.delete(id);
    ++this.epoch;
    ++this.pasteEpoch;
  }

  forget(id) {
    this.known.delete(id);
    this.queues.delete(id);
    ++this.epoch;
    ++this.pasteEpoch;
    this.changed();
  }

  applies() {
    const c = this.clip.cfg;
    return c.enabled && c.send && c.queue !== false;
  }

  configure() {
    ++this.epoch;
    ++this.pasteEpoch;
    if (!this.applies()) {
      this.queues.clear();
      this.seen = null;
    }
  }

  _away() {
    const on = new Set(this.clip.bus.connectedIds());
    return [...this.known].filter(([id, pair]) => !on.has(id) && this.knownPair(id, pair));
  }

  async _look() {
    const epoch = ++this.epoch;
    const away = this.applies() ? this._away() : [];
    if (!away.length) { this.seen = null; return; }
    let text;
    try { text = await this.clip._readText(); } catch (_) { return; }
    if (epoch !== this.epoch || !this.applies()) return;
    const previous = this.seen;
    this.seen = text;
    if (previous === null || !text || text === previous || text === this.clip.lastSync.received || require('./otp.js').isQuiet(text)) return;
    if (this.clip.cfg.skipConcealed && (await this.concealed().catch(() => true))) return;
    if (epoch !== this.epoch || !this.applies()) return;
    const stillAway = new Map(this._away());
    let added = false;
    for (const [id, pair] of away) {
      if (stillAway.get(id) !== pair) continue;
      if (!this.queues.has(id)) this.queues.set(id, new ClipQueue());
      if (this.queues.get(id).add(text, this.clip.cfg.maxKB)) added = true;
    }
    if (added) this.changed();
  }

  policy(id, m) {
    const pair = this.known.get(id);
    const q = this.queues.get(id);
    if (!q?.size || !pair || this.activePair(id) !== pair || !this.knownPair(id, pair) ||
        !this.applies() || m?.queue !== true || m.accept === false) return;
    const msg = q.take();
    if (!this.clip.bus.send(id, msg)) { q.items = msg.items; return; }
    this.changed();
  }

  // Copies a device made while we were away: in Recent; on the clipboard only the latest.
  async receive(m, from) {
    const clip = this.clip;
    const socket = this.currentSocket(from);
    const allowed = () => clip.cfg.enabled && clip.cfg.receive && socket === this.currentSocket(from);
    if (!allowed()) return;
    const items = itemsOf(m);
    if (!items.length) return;
    const epoch = ++this.pasteEpoch;
    const name = this.nameOf(from);
    for (const x of items) clip._remember('in', x.text, name, x.at);
    this.changed();
    if (clip.cfg.queueLatest) {
      const last = items[items.length - 1].text;
      let now = '';
      try { now = await clip._readText(); } catch (_) { /* write it */ }
      if (epoch !== this.pasteEpoch || !allowed() || !clip.cfg.queueLatest) return;
      clip.lastSync.received = last;
      clip.seen = last;
      this.seen = last;
      if (now !== last) clip.clipboard.writeText(last);
    }
  }

  destroy() { clearInterval(this.timer); }
}

module.exports = { ClipQueue, MeshClipQueue, itemsOf, MAX, MAX_BYTES };
