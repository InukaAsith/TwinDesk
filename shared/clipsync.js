// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// "The latest copy wins": what was copied last, on any device, is what every device pastes.
//
// Every copy gets a time {ts, o}: ts from a hybrid logical clock (milliseconds that never go
// backwards and always move past any time seen from another device), o = the device that copied.
// A device applies an incoming item only when it is newer than the newest copy it knows of (its own
// last copy counts), so a late or repeated push of an older copy can no longer replace a newer one.
// A copy made right after receiving another gets a larger ts (the clock moved past it), so the order
// of what a person did is kept even when the two clocks differ by a few seconds.
// Items from a device that sends no time (older apps) count as copied on arrival, as before.
// Pure: no sockets, no clipboard. Used by Windows, Mac, Linux (JS) and ported to Kotlin (Android).
'use strict';

const P = require('./protocol.js');

const MAX_ID = 128;
const ARRIVAL_SKEW_MS = 5000; // how far behind our clock a copy made after an untimed item may be

// Hybrid logical clock.
class Clock {
  constructor(now = Date.now) {
    this.now = now;
    this.last = 0;
  }

  // The time of a copy made here: wall clock, but always past every time given or seen before.
  tick() {
    this.last = Math.max(this.now(), this.last + 1);
    return this.last;
  }

  // A time seen on another device: later ticks move past it (clamped, so a clock far in the
  // future cannot push ours there).
  observe(ts) {
    if (!Number.isFinite(ts)) return;
    this.last = Math.max(this.last, Math.min(ts, this.now() + P.CLIP_SKEW_MS));
  }
}

// Newer first by time, then by device id so two devices always agree on a tie.
function compare(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.o === b.o) return 0;
  return a.o < b.o ? -1 : 1;
}

function validStamp(m) {
  return !!m && Number.isFinite(m.ts) && m.ts > 0 && m.ts < 2 ** 53 && typeof m.o === 'string' && m.o.length > 0 && m.o.length <= MAX_ID;
}

// The newest copy a device knows of: {ts, o, kind, id?} or null.
class Latest {
  constructor({ selfId, clock = new Clock() }) {
    this.selfId = selfId;
    this.clock = clock;
    this.cur = null;
  }

  // A copy happened here: its time, which becomes the newest. kind: 'text' | 'image' | 'files'.
  copied(kind, id) {
    const stamp = { ts: this.clock.tick(), o: this.selfId };
    this.cur = { ...stamp, kind, ...(id ? { id } : {}) };
    return stamp;
  }

  // An item from another device (msg has ts and o, or neither: an older app). True = apply it.
  // The item becomes the newest copy when it is applied.
  accept(msg, kind, id) {
    let stamp;
    if (validStamp(msg)) {
      stamp = { ts: Math.min(msg.ts, this.clock.now() + P.CLIP_SKEW_MS), o: msg.o };
      this.clock.observe(msg.ts);
    } else {
      stamp = { ts: this.clock.tick(), o: msg && typeof msg.from === 'string' ? msg.from : '~peer', arrival: true };
    }
    if (stamp.o === this.selfId) return false; // our own copy coming back
    if (this.cur && compare(stamp, this.cur) <= 0 && !this._afterArrival(stamp)) return false;
    this.cur = { ...stamp, kind, ...(id ? { id } : {}) };
    return true;
  }

  // The newest we know is an item without a time (an older app's, or relayed from one): its time is
  // only when it got here, on this clock. A copy made on another device after it can carry a time a
  // little behind that (its clock is a few ms or seconds behind ours, and it never saw ours): newer
  // all the same, as it came after. One far older than that is still a late repeat, and loses.
  _afterArrival(stamp) {
    return !!(this.cur && this.cur.arrival && !stamp.arrival && stamp.ts >= this.cur.ts - ARRIVAL_SKEW_MS);
  }

  // What to say after welcome (`clip.latest`): null when nothing was copied yet.
  latestMessage() {
    return this.cur ? { t: P.T.CLIP_LATEST, ts: this.cur.ts, o: this.cur.o, kind: this.cur.kind } : null;
  }

  // The other side's `clip.latest`: true when it holds a newer copy than we know of (ask it for it).
  isNewer(msg) {
    if (!validStamp(msg)) return false;
    this.clock.observe(msg.ts);
    return !this.cur || compare({ ts: msg.ts, o: msg.o }, this.cur) > 0;
  }
}

// ---- messages ----

const stampOf = (s) => ({ ts: s.ts, o: s.o });

function textMessage(text, stamp) {
  return { t: P.T.CLIP, text, ...stampOf(stamp) };
}

// png: a Buffer. Returns null when it is too big to send.
function imageMessage({ id, w, h, png }, stamp) {
  if (!png || png.length === 0 || png.length > P.CLIP_IMAGE_MAX_BYTES) return null;
  return { t: P.T.CLIP_IMAGE, id, w: w | 0, h: h | 0, png: Buffer.from(png).toString('base64'), ...stampOf(stamp) };
}

// An incoming clip.image checked: {id, w, h, png: Buffer} or null.
function readImage(m) {
  if (!m || typeof m.png !== 'string' || m.png.length === 0 || m.png.length > Math.ceil(P.CLIP_IMAGE_MAX_BYTES * 4 / 3) + 8) return null;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > MAX_ID) return null;
  const png = Buffer.from(m.png, 'base64');
  if (png.length === 0 || png.length > P.CLIP_IMAGE_MAX_BYTES) return null;
  // PNG signature: the receiver only ever writes a PNG to its clipboard.
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { id: m.id, w: Math.max(0, m.w | 0), h: Math.max(0, m.h | 0), png };
}

module.exports = { Clock, Latest, compare, validStamp, textMessage, imageMessage, readImage };
