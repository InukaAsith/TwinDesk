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

module.exports = { ClipQueue, itemsOf, MAX, MAX_BYTES };
