// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's keyboard on a phone as a real USB keyboard (#123): scrcpy's UHID messages make a
// HID keyboard on the phone (/dev/uhid), and every key goes as a HID report, so Android applies the
// physical keyboard layout set on the phone (Settings › System › Keyboard › Physical keyboard) to
// every key, letters, digits, symbols and accented ones alike, instead of keycodes in the US layout.
// Only through wireless debugging (scrcpy's control channel): Phone › Settings › Type as a hardware
// keyboard (settings.phone.uhid, off by default). Used by phone-bridge.js and phoneview.js.
'use strict';

// KeyboardEvent.code -> HID usage (Keyboard/Keypad page 0x07).
const USAGE = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
  BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, NumLock: 0x53,
  NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
  NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65, NumpadEqual: 0x67,
  AudioVolumeMute: 0x7f, AudioVolumeUp: 0x80, AudioVolumeDown: 0x81, NumpadComma: 0x85,
  IntlRo: 0x87, KanaMode: 0x88, IntlYen: 0x89, Convert: 0x8a, NonConvert: 0x8b, Lang1: 0x90, Lang2: 0x91,
};
for (let i = 0; i < 26; i++) USAGE[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) { USAGE[`Digit${i}`] = 0x1e + i - 1; USAGE[`Numpad${i}`] = 0x59 + i - 1; }
USAGE.Digit0 = 0x27;
USAGE.Numpad0 = 0x62;
for (let i = 1; i <= 12; i++) USAGE[`F${i}`] = 0x3a + i - 1;
for (let i = 13; i <= 24; i++) USAGE[`F${i}`] = 0x68 + i - 13;

// Modifier keys -> the report's first byte.
const MOD = { ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08, ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80 };

// A boot keyboard: modifiers, a reserved byte, six keys; five LEDs back (Android sends them, unread).
const DESCRIPTOR = Buffer.from([
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, // Generic Desktop, Keyboard, Application
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // 8 modifier bits
  0x75, 0x08, 0x95, 0x01, 0x81, 0x01, // reserved byte
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x75, 0x01, 0x95, 0x05, 0x91, 0x02, // 5 LEDs
  0x75, 0x03, 0x95, 0x01, 0x91, 0x01, // LED padding
  0x05, 0x07, 0x15, 0x00, 0x26, 0xff, 0x00, 0x19, 0x00, 0x2a, 0xff, 0x00, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00, // 6 keys
  0xc0,
]);
const ID = 1;
const NAME = 'TwinDesk keyboard';

// ctl: a scrcpy Session (uhidCreate, uhidInput, uhidDestroy).
class UhidKeyboard {
  constructor(ctl) {
    this.ctl = ctl;
    this.made = false;
    this.mods = 0;
    this.keys = []; // usages held, oldest first (six at most in a report)
  }

  static handles(code) {
    return !!(USAGE[code] || MOD[code]);
  }

  // A key: true when it went as HID (false: a key a HID keyboard doesn't have; send it as before).
  key(code, down) {
    const mod = MOD[code];
    const usage = USAGE[code];
    if (!mod && !usage) return false;
    if (!this.made) {
      this.ctl.uhidCreate(ID, 0, 0, NAME, DESCRIPTOR);
      this.made = true;
    }
    const before = this._report().toString('hex');
    if (mod) this.mods = down ? this.mods | mod : this.mods & ~mod;
    else if (down && !this.keys.includes(usage)) this.keys.push(usage);
    else if (!down) this.keys = this.keys.filter((u) => u !== usage);
    const r = this._report();
    if (r.toString('hex') !== before) this.ctl.uhidInput(ID, r); // a repeat of a held key: Android repeats it itself
    return true;
  }

  // Everything up (the pointer left the phone, the setting went off).
  release() {
    if (!this.made || (!this.mods && !this.keys.length)) return;
    this.mods = 0;
    this.keys = [];
    this.ctl.uhidInput(ID, this._report());
  }

  _report() {
    const r = Buffer.alloc(8);
    r[0] = this.mods;
    this.keys.slice(-6).forEach((u, i) => { r[2 + i] = u; });
    return r;
  }
}

// The bridge's or phone window's step: true when the key went as HID. on: settings.phone.uhid.
function uhidKey(ctl, on, code, down) {
  if (!ctl || typeof ctl.uhidCreate !== 'function') return false;
  if (!on) {
    if (ctl.uhidKbd) ctl.uhidKbd.release();
    return false;
  }
  if (!ctl.uhidKbd) ctl.uhidKbd = new UhidKeyboard(ctl);
  return ctl.uhidKbd.key(code, down);
}

module.exports = { UhidKeyboard, uhidKey, USAGE, MOD, DESCRIPTOR };
