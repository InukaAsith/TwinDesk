// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's mouse and keyboard on a phone without wireless debugging (the session through
// Bluetooth, or adb not set up): the same calls phone-bridge.js makes on scrcpy's control channel,
// sent as phone.in messages that TwinDesk on the phone applies itself (its Accessibility service:
// taps, drags, scrolls, typing, Back/Home/Recents). The pointer is drawn as always (phone.pointer).
// A drag is replayed as one gesture when the button comes up (Accessibility can't hold a touch
// open across messages); moves while a button is down are thinned to keep Bluetooth light.
//   phone.in {a: 'd'|'m'|'u', x, y}            touch down / move / up (phone pixels)
//   phone.in {a: 's', x, y, h, v}              scroll (wheel steps, + = up / left)
//   phone.in {a: 'k', d: 0|1, k, m}            key (Android keycode, meta state)
//   phone.in {a: 'z', x, y, from, to, vert}    pinch: two fingers from `from` px off (x, y) to `to`,
//                                              up and down when vert is 1 (shared/pinch.js)
'use strict';

const P = require('./protocol.js');

const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7, HOVER_EXIT: 10 }; // scrcpy.js's
const MOVE_MS = 30;
const SCROLL_MS = 60;

class PhoneInput {
  // send(msg): to the phone (the session)
  constructor(send) {
    this.send = send;
    this.closed = false;
    this.lastMove = 0;
    this.scrollAcc = null;
  }

  mouse(action, x, y, w, h, actionButton, buttons) {
    x = Math.round(x);
    y = Math.round(y);
    if (action === ACTION.HOVER_MOVE || action === ACTION.HOVER_EXIT) return; // only the pointer moves (phone.pointer)
    if (action === ACTION.MOVE) {
      const now = Date.now();
      if (now - this.lastMove < MOVE_MS) return;
      this.lastMove = now;
      return this.send({ t: P.T.PHONE_IN, a: 'm', x, y });
    }
    if (actionButton !== 1) return; // the left button touches; the others are mapped to keys by the bridge
    this.send({ t: P.T.PHONE_IN, a: action === ACTION.DOWN ? 'd' : 'u', x, y });
  }

  scroll(x, y, w, h, hs, vs) {
    const acc = this.scrollAcc || (this.scrollAcc = { x, y, h: 0, v: 0 });
    acc.h += hs;
    acc.v += vs;
    if (acc.timer) return;
    acc.timer = setTimeout(() => {
      this.scrollAcc = null;
      if (acc.h || acc.v) this.send({ t: P.T.PHONE_IN, a: 's', x: Math.round(acc.x), y: Math.round(acc.y), h: acc.h, v: acc.v });
    }, SCROLL_MS);
  }

  pinch(x, y, from, to, vertical) {
    if (!this.closed) this.send({ t: P.T.PHONE_IN, a: 'z', x: Math.round(x), y: Math.round(y), from: Math.round(from), to: Math.round(to), vert: vertical ? 1 : 0 });
  }

  key(action, keycode, meta = 0) {
    this.send({ t: P.T.PHONE_IN, a: 'k', d: action === ACTION.DOWN ? 1 : 0, k: keycode, m: meta });
  }

  tap(keycode, meta = 0) {
    this.key(ACTION.DOWN, keycode, meta);
    this.key(ACTION.UP, keycode, meta);
  }

  backOrScreenOn(action) {
    if (action === ACTION.DOWN) this.tap(4); // KEYCODE_BACK
  }

  stop() {}
}

module.exports = { PhoneInput };
