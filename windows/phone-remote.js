// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone as this PC's remote: its Remote page (a touchpad, a keyboard, a gamepad whose buttons
// are keys) moves this PC's pointer, clicks, scrolls and types. Relative input (remote.*) goes
// straight to the helper as k.* events, only while Cursor › "Use {phone}'s mouse and keyboard on
// {me}" (kvm.beDriven, also the tray's "Let {phone} Control {me}") is on and this PC's own mouse
// is at home (not driving the phone or another computer).
'use strict';

const P = require('../shared/protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const num = (v, max) => Math.max(-max, Math.min(max, Number(v) || 0));
const BUTTONS = new Set(Object.values(P.BUTTON));
const CODE = /^[A-Za-z0-9]{1,32}$/; // KeyboardEvent.code names (KeyA, ArrowLeft, MediaPlayPause…)

class PhoneRemote {
  // server: phone-link.js; helper: helper.js; getSettings(); atHome(): this PC's mouse is its own
  constructor({ server, helper, getSettings, atHome }) {
    Object.assign(this, { server, helper, getSettings, atHome });
    this.held = false; // keys or buttons the phone may still hold down here
    this.refusedAt = 0;
    const on = (t, fn) => server.on(`t:${t}`, (m, ctx) => isPhone(ctx) && fn(m || {}));
    on(T.REMOTE_HELLO, () => this._state());
    // smooth: the helper eases the move out over about a frame instead of jumping (Smoother.cs).
    on(T.REMOTE_MOVE, (m) => this._ev({ t: T.K_MOVE, dx: num(m.dx, 4000), dy: num(m.dy, 4000), smooth: m.smooth === true }));
    on(T.REMOTE_DOWN, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_DOWN, b: m.b }));
    on(T.REMOTE_UP, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_UP, b: m.b }));
    on(T.REMOTE_WHEEL, (m) => this._ev({ t: T.K_WHEEL, dx: num(m.dx, 4000), dy: num(m.dy, 4000), mode: 'pixel' }));
    on(T.REMOTE_KEY_DOWN, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_DOWN, code: m.code }));
    on(T.REMOTE_KEY_UP, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_UP, code: m.code }));
    on(T.REMOTE_RELEASE, () => this.release());
    // The phone went away holding a key (Wi-Fi dropped mid-press): let it go here.
    server.on('closed', () => this.release());
  }

  get allowed() {
    const s = this.getSettings();
    return !!(s.kvm && s.kvm.beDriven !== false) && this.atHome();
  }

  _state() {
    this.server.sendToClient({ t: T.REMOTE_STATE, allowed: this.allowed });
  }

  _ev(ev) {
    if (!this.allowed) {
      // Tell the phone (it says why on its Remote page), at most once a second.
      const now = Date.now();
      if (now - this.refusedAt > 1000) { this.refusedAt = now; this._state(); }
      return;
    }
    if (ev.t === T.K_DOWN || ev.t === T.K_KEY_DOWN) this.held = true;
    this.helper.send('inject', { ev });
  }

  release() {
    if (!this.held) return;
    this.held = false;
    if (this.atHome()) this.helper.send('releaseAll');
  }
}

module.exports = { PhoneRemote };
