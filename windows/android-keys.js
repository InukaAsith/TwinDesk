// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// DOM KeyboardEvent.code -> Android KeyEvent keycodes and meta-state bits, for the keys the PC
// sends to the phone (the phone window and the mouse and keyboard across the edge). Copy of
// mac/android-keys.js.
'use strict';

const KEYCODE = {
  Enter: 66, NumpadEnter: 160, Escape: 111, Backspace: 67, Delete: 112, Tab: 61, Space: 62,
  Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75,
  Backquote: 68, Comma: 55, Period: 56, Slash: 76, IntlBackslash: 73,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, PageUp: 92, PageDown: 93,
  Home: 122, End: 123, Insert: 124, CapsLock: 115,
  ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114, AltLeft: 57, AltRight: 58,
  MetaLeft: 117, MetaRight: 118, ContextMenu: 82,
  NumpadDivide: 154, NumpadMultiply: 155, NumpadSubtract: 156, NumpadAdd: 157, NumpadDecimal: 158, NumpadEqual: 161,
  AudioVolumeUp: 24, AudioVolumeDown: 25, AudioVolumeMute: 164, MediaPlayPause: 85, MediaTrackNext: 87, MediaTrackPrevious: 88,
};
for (let i = 0; i < 26; i++) KEYCODE[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
for (let i = 0; i < 10; i++) {
  KEYCODE[`Digit${i}`] = 7 + i;
  KEYCODE[`Numpad${i}`] = 144 + i;
}
for (let i = 1; i <= 12; i++) KEYCODE[`F${i}`] = 130 + i;

// Modifier keys -> meta-state bits (KeyEvent.META_*).
const META = {
  ShiftLeft: 0x1 | 0x40, ShiftRight: 0x1 | 0x80,
  AltLeft: 0x2 | 0x10, AltRight: 0x2 | 0x20,
  ControlLeft: 0x1000 | 0x2000, ControlRight: 0x1000 | 0x4000,
  MetaLeft: 0x10000 | 0x20000, MetaRight: 0x10000 | 0x40000,
};

const ANDROID = { BACK: 4, HOME: 3, APP_SWITCH: 187, ALL_APPS: 284, POWER: 26, MENU: 82, NOTIFICATION: 83, VOLUME_UP: 24, VOLUME_DOWN: 25, VOLUME_MUTE: 164 };

// Keeps the held modifiers, so every key goes with the right meta state.
class KeyState {
  constructor() {
    this.held = new Set();
  }

  meta() {
    let m = 0;
    for (const c of this.held) m |= META[c] || 0;
    return m;
  }

  // -> {keycode, meta} or null for keys Android has no code for.
  event(code, down) {
    if (META[code]) {
      if (down) this.held.add(code);
      else this.held.delete(code);
    }
    const keycode = KEYCODE[code];
    return keycode ? { keycode, meta: this.meta() } : null;
  }

  clear() {
    this.held.clear();
  }
}

module.exports = { KEYCODE, META, ANDROID, KeyState };
