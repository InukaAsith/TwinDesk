// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// `in.*` from a Mac window that shows something of this PC (the screen: an app
// window), injected by the helper. Only while KVM is at home and "Let the Mac control it" is on;
// keys go through P.mapKeyFromOtherPlatform when Ctrl/Cmd swapping is on.
const P = require('../shared/protocol.js');

const T = P.T;
const POINTER = new Set([T.IN_MOVE, T.IN_DOWN, T.IN_UP]);

class RemoteInput {
  // opts: link (peer.js), helper, settings (shared), inputAllowed() (KVM at home)
  constructor(opts) {
    Object.assign(this, opts);
    this.keyCodes = new Map();
    this.held = false; // keys/buttons may be held down by the Mac
  }

  get allowed() {
    return this.settings.pcScreen.input && this.inputAllowed();
  }

  // move(x, y): put the pointer at x,y normalized over what the Mac sees (helper command).
  // before(): called before a button/key goes down (e.g. raise the app window).
  // pen(x, y, state): a phone's stylus at x,y normalized, its P.penOf state (the helper's `pen`);
  // without it, the stylus is a mouse.
  // force: a window moved there with Move windows (shared/movewin.js), whose copy takes input even
  // while this computer drives the other one (it is the only place that window is used).
  handle(m, move, before, pen, force) {
    if (!force && !this.allowed) return;
    if (force) this.forced = true;
    const ev = (e) => this.helper.send('inject', { ev: e });
    if (POINTER.has(m.t)) {
      const x = Number(m.x), y = Number(m.y);
      const st = pen && P.penOf(m.pen);
      if (st) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (m.t === T.IN_DOWN && before) before();
        pen(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), st);
        if (m.t === T.IN_DOWN) this.held = true;
        return;
      }
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (m.t === T.IN_DOWN && before) before();
        move(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)));
      }
      if (m.t !== T.IN_MOVE && Number.isInteger(m.b) && m.b >= 0 && m.b <= 4) {
        ev({ t: m.t === T.IN_DOWN ? T.K_DOWN : T.K_UP, b: m.b });
        this.held = true;
      }
    } else if (m.t === T.IN_WHEEL) {
      const dx = Number(m.dx) || 0, dy = Number(m.dy) || 0;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      ev({ t: T.K_WHEEL, dx, dy, mode: 'pixel' });
    } else if ((m.t === T.IN_KEY_DOWN || m.t === T.IN_KEY_UP) && typeof m.code === 'string') {
      if (m.t === T.IN_KEY_DOWN && before) before();
      const code = this.keyCodes.get(m.code) || (this.settings.keys.swapCtrlCmd && P.keySwapNeeded(P.OS.WIN, this.link.peerOs) ? P.mapKeyFromOtherPlatform(m.code) : m.code);
      if (m.t === T.IN_KEY_DOWN) this.keyCodes.set(m.code, code);
      else this.keyCodes.delete(m.code);
      ev({ t: m.t === T.IN_KEY_DOWN ? T.K_KEY_DOWN : T.K_KEY_UP, code });
      this.held = true;
    }
  }

  // Let go of anything the Mac still holds (a session ended, input switched off).
  release() {
    this.keyCodes.clear();
    if (!this.held) return;
    this.held = false;
    if (this.inputAllowed() || this.forced) this.helper.send('releaseAll');
    this.forced = false;
  }
}

RemoteInput.TYPES = [T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL, T.IN_KEY_DOWN, T.IN_KEY_UP];
module.exports = RemoteInput;
