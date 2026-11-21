// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const P = require('./protocol.js');
const SECOND_MS = 1000;
const COUNTDOWN_MS = 15 * SECOND_MS;

function isAuthenticatedPhone(ctx) {
  return !!ctx && ctx.authed === true && P.isPhoneOs(ctx.os) && typeof ctx.deviceId === 'string' && ctx.deviceId.length > 0;
}

class ProximityLock {
  constructor({ enabled = () => false, canLock, prompt, lock, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { enabled, canLock, prompt, lock, now, setTimer, clearTimer });
    this.phones = new Map();
    this.countdown = null;
    this.stopped = false;
  }

  connected(ctx) {
    if (this.stopped || !isAuthenticatedPhone(ctx) || ctx.released === true) return;
    this.phones.set(ctx.deviceId, ctx);
    this.cancel(); // Any paired phone still present keeps a Multi-device Mac unlocked.
  }

  disconnected(ctx, unexpected) {
    if (!ctx || this.phones.get(ctx.deviceId) !== ctx) return;
    this.phones.delete(ctx.deviceId);
    if (unexpected !== true || this.countdown || !this._eligible(ctx)) return;

    const pending = { ctx, deadline: null, timer: null };
    this.countdown = pending;
    // The user gets 15 seconds from when the Cancel button is visible.
    this.prompt.show({
      seconds: COUNTDOWN_MS / SECOND_MS,
      cancel: () => { if (this.countdown === pending) this.cancel(); },
      ready: () => {
        if (this.countdown !== pending || pending.deadline !== null) return;
        pending.deadline = this.now() + COUNTDOWN_MS;
        this._tick(pending);
      },
    });
  }

  forget(deviceId) {
    this.phones.delete(deviceId);
    if (this.countdown?.ctx.deviceId === deviceId) this.cancel();
  }

  recheck() {
    if (this.countdown && !this._eligible(this.countdown.ctx)) this.cancel();
  }

  cancel() {
    const pending = this.countdown;
    if (!pending) return;
    this.countdown = null;
    if (pending.timer !== null) this.clearTimer(pending.timer);
    this.prompt.hide();
  }

  reset() {
    // A socket left over from before sleep or lock may report its loss after wake or unlock.
    this.phones.clear();
    this.cancel();
  }

  shutdown() {
    this.stopped = true;
    this.reset();
  }

  _eligible(ctx) {
    return !this.stopped && this.phones.size === 0 && ctx.released !== true && this.enabled() === true && this.canLock(ctx);
  }

  _tick(pending) {
    if (this.countdown !== pending) return;
    if (!this._eligible(pending.ctx)) return this.cancel();

    const left = pending.deadline - this.now();
    if (left <= 0) {
      this.cancel();
      this.lock();
      return;
    }
    const seconds = Math.ceil(left / SECOND_MS);
    this.prompt.update(seconds);
    pending.timer = this.setTimer(() => this._tick(pending), Math.ceil(left - (seconds - 1) * SECOND_MS));
  }
}

module.exports = { ProximityLock, isAuthenticatedPhone };
