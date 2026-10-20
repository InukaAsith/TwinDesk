// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A loop breaker for the notification pool. A notification shown on one device can be read back as a
// new one and sent on (a loop between devices), and each trip has its own id, so the pool's own
// duplicate check never sees it. The same text from the same app within a few seconds is shown or
// sent once, however many times it comes. Plain Node, no Electron.
'use strict';

class NotifGuard {
  constructor({ windowMs = 15000, limit = 300, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.now = now;
    this.last = new Map(); // key -> time of the last one let through
  }

  // true when this notification is a repeat of one let through a moment ago (drop it).
  repeat(...parts) {
    const t = this.now();
    const key = parts.map((p) => String(p == null ? '' : p).slice(0, 200)).join('\u0001');
    const was = this.last.get(key);
    if (was !== undefined && t - was < this.windowMs) return true;
    this.last.set(key, t);
    if (this.last.size > this.limit) {
      for (const [k, v] of this.last) if (t - v >= this.windowMs) this.last.delete(k);
      if (this.last.size > this.limit) this.last.delete(this.last.keys().next().value);
    }
    return false;
  }
}

// TwinDesk's own notifications are never forwarded: they would only come back.
const isOwn = (...names) => names.some((n) => /twindesk|macshare/i.test(String(n || '')));

module.exports = { NotifGuard, isOwn };
