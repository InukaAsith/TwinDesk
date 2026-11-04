// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Pointer moves summed into one message: on the driving side before they go to the other computer,
// on the driven side before they go to the helper. A move goes on the next turn of the event loop
// (all that came in meanwhile, summed), or after delay() ms (through Bluetooth every message is a
// round trip on the radio). While the way out is backed up (backlog() bytes above limit(): the
// other side or the link fell behind), moves keep summing instead of queueing, so the pointer goes
// to where it is now rather than replaying old moves: until there's room, or at most maxWait() ms
// (then one goes anyway: behind a big message the pointer still moves). Anything else (a click, a
// key) flush()es first, so it lands where the moves before it took the pointer.
'use strict';

const RETRY_MS = 2; // backed up: look again this often

class KvmMoves {
  // opts: send({dx, dy}); delay() -> ms (0: next turn); backlog() -> bytes waiting; limit() -> bytes;
  //   maxWait() -> ms backed up before one goes anyway (Infinity: wait for room). All but send optional.
  // Nothing is allocated per move: the sum is two numbers, send() gets the same object each time (it
  // reads dx and dy, or copies it to keep it), and the callback the timers run is bound once.
  constructor(opts) {
    this.o = opts;
    this.has = false; // something summed (px, py)
    this.px = 0;
    this.py = 0;
    this.out = { dx: 0, dy: 0 };
    this.timer = null; // a Timeout or an Immediate (timerIsTimeout says which), or null
    this.timerIsTimeout = false;
    this.since = 0; // first held back at (backed up)
    this._go = () => {
      this.timer = null;
      this._try();
    };
  }

  // What's summed and not yet sent ({dx, dy}), or null.
  get pending() {
    return this.has ? { dx: this.px, dy: this.py } : null;
  }

  add(dx, dy) {
    KvmMoves.count++;
    if (!this.has) {
      this.has = true;
      this.px = 0;
      this.py = 0;
      this._schedule(this.o.delay ? this.o.delay() : 0);
    }
    this.px += dx;
    this.py += dy;
  }

  // Send what's summed now.
  flush() {
    this._clear();
    const had = this.has;
    this.has = false;
    this.since = 0;
    if (!had) return;
    const m = this.out;
    m.dx = this.px;
    m.dy = this.py;
    this.o.send(m);
  }

  // Forget what's summed (driving ended).
  drop() {
    this._clear();
    this.has = false;
    this.since = 0;
  }

  _schedule(ms) {
    if (this.timer) return;
    this.timerIsTimeout = ms > 0;
    this.timer = ms > 0 ? setTimeout(this._go, ms) : setImmediate(this._go);
  }

  _clear() {
    if (!this.timer) return;
    if (this.timerIsTimeout) clearTimeout(this.timer);
    else clearImmediate(this.timer);
    this.timer = null;
  }

  _try() {
    if (!this.has) return;
    const backlog = this.o.backlog ? this.o.backlog() : 0;
    const limit = this.o.limit ? this.o.limit() : Infinity;
    if (backlog > limit) {
      const now = Date.now();
      if (!this.since) this.since = now;
      const maxWait = this.o.maxWait ? this.o.maxWait() : Infinity;
      if (now - this.since < maxWait) return this._schedule(Math.max(RETRY_MS, this.o.delay ? this.o.delay() : 0));
    }
    this.flush();
  }
}

KvmMoves.count = 0; // moves added, all of them (shared/applog.js: moves a second in the log)

module.exports = { KvmMoves };
