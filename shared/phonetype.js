// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keys from this computer to an Android phone, by what they type here. The phone gets Android key
// codes, which its built-in virtual keyboard types as US QWERTY: an AZERTY Ctrl+A arrived as
// Ctrl+Q, its letters in the wrong places, and AltGr's @ or € as nothing (#260). So (unless Phone ›
// Type as a hardware keyboard is on, where the phone's own layout types the place):
//   - a key that types a letter here goes as that letter's key (Ctrl+A is Ctrl+A on any layout);
//   - a key that types another character here than it would on US QWERTY (é, @ with AltGr, the ç
//     key…) is typed as that text on the way down (again with each repeat), and its release is dropped;
//   - everything else (Enter, the arrows, digits where they match, shortcuts on non-letters, the
//     numpad) goes as it is.
// From a phone window the browser's `key` says what the key types; across the screen edge only the
// helper's `ch` (keylayout.js: the letter a key types alone here) is known, so there it's letters.
'use strict';

// What each place types on US QWERTY, alone and with Shift.
const US = {
  Backquote: '`~', Digit1: '1!', Digit2: '2@', Digit3: '3#', Digit4: '4$', Digit5: '5%', Digit6: '6^', Digit7: '7&',
  Digit8: '8*', Digit9: '9(', Digit0: '0)', Minus: '-_', Equal: '=+', BracketLeft: '[{', BracketRight: ']}',
  Backslash: '\\|', Semicolon: ';:', Quote: '\'"', Comma: ',<', Period: '.>', Slash: '/?', Space: '  ',
};
const LETTER = /^[a-z]$/i;

class PhoneType {
  constructor() {
    this.down = new Map(); // physical code -> the code pressed for it, or '' when it was typed as text
  }

  // A key from a phone window: {code} to press (the same or another), {text} to type, or {} for nothing.
  // ev: {code, down, key (KeyboardEvent.key), shift, ctrl, meta, altGr}
  fromWindow(ev) {
    const { code, down } = ev;
    if (!down) return this._up(code);
    if (!ev.repeat) this.down.delete(code); // a new press: its release was lost (the window lost focus)
    const key = typeof ev.key === 'string' ? ev.key : '';
    if (key === 'Dead') { // the accent key of é, ê…: the letter it makes comes next as text
      this.down.set(code, '');
      return {};
    }
    if ([...key].length !== 1 || /^Numpad/.test(code)) return this._press(code, code); // Enter, F1, the arrows, the numpad
    if (LETTER.test(key)) return this._press(code, 'Key' + key.toUpperCase());
    if ((ev.ctrl || ev.meta) && !ev.altGr) return this._press(code, code); // a shortcut on a non-letter: by place
    const us = US[code];
    if (us && us[ev.shift ? 1 : 0] === key) return this._press(code, code); // types the same on the phone (Shift is held there too)
    this.down.set(code, ''); // held, it repeats like typing does; its release is dropped
    return { text: key };
  }

  // A key across the screen edge (the helper's, tagged by keylayout.js): {code}, or {} for nothing.
  fromHelper(code, down, ch) {
    if (!down) return this._up(code);
    return this._press(code, typeof ch === 'string' && LETTER.test(ch) ? 'Key' + ch.toUpperCase() : code);
  }

  _press(code, as) {
    const was = this.down.get(code);
    if (was === '') return {};
    if (was) return { code: was }; // a repeat: the key it pressed
    this.down.set(code, as);
    return { code: as };
  }

  _up(code) {
    const was = this.down.get(code);
    this.down.delete(code);
    if (was === '') return {};
    return { code: was || code };
  }

  clear() {
    this.down.clear();
  }
}

module.exports = { PhoneType, US };
