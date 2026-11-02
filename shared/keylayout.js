// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shortcuts and alphabets across keyboard layouts (one-to-one and Multi-device). Keys go as their
// physical place (`code`), which types what that place types on the other computer's layout: a German
// Mac's Cmd+Z is the key in the Y place, Ctrl+Y (redo) on an English PC. So each key also says the
// letter it types on our layout (`ch`, k.kd / k.ku: from the helper's keyLayout, what each key types
// alone), and while Ctrl or Cmd is held, the other side presses its own key for that letter instead
// (the Z place on the English PC: undo). Without Ctrl or Cmd keys stay where they are (typing follows
// the layout of the computer typed on), as do letters the other layout has no key for and keys from
// an older app (no `ch`).
// Other alphabets: a key that types a letter of another alphabet here (ж on a Russian PC, ක or the
// vowel sign ා on a Sinhala one) also says it (`tx`, k.kd; not Latin letters like ö or é), with Shift
// what it types with Shift (the helper's shift map: Sinhala's ඛ on the ක key has no case to guess it
// from), and where that key types something else on the other side (an English Mac's a or ;) it is
// typed as it is (the helper's type) instead of the key: a Russian PC types Russian on an English Mac.
// Where the other side's key types the same (Russian there too), the key goes as it is (its own layout
// types it). On such a layout its punctuation goes the same way (. in the ' place on Sinhala), digits
// too where the other side's differ. Not with Ctrl, Cmd or Alt held (shortcuts), and not where the helper can't type (an older
// one, Wayland).
// Input methods (Japanese, Pinyin, Korean…): their keys type a–z here and the input method composes
// them, which ours never sees while the keys go over. So each typing key also says its language (`im`,
// k.kd: ja, zh-Hans, ko… from the helper's keyLayout), and the other side switches to an input method of
// that language it has enabled (the helper's selectInput) while driven, back to its own when it isn't
// (or when keys come without one: we went back to a layout). None enabled there: keys as before.
'use strict';

const LETTER = /^[a-z]$/;
const LETTERS_OF = /^[\p{L}\p{M}\u200c\u200d]+$/u; // marks too: Sinhala's vowel signs and al-lakuna; ZWJ in its ligatures
const LATIN = /\p{Script=Latin}/u;
const IM_LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/; // ja, ko, zh-Hans…
const MAX_CHARS = 8; // a key typing a ligature (ක්‍ෂ on Sinhala Wij 9)
// Letters of another alphabet (Cyrillic, Greek, Arabic, Hebrew, Sinhala…): Latin ones (ö, é) aren't
// typed as they are, the other side's own layout types its keys as it does for the rest.
const ALPHA = { test: (c) => typeof c === 'string' && [...c].length <= MAX_CHARS && LETTERS_OF.test(c) && !LATIN.test(c) };
// What a key typed with Shift on the sender: any printable text (a Sinhala key's Shift may type ;).
const PRINTABLE = (c) => typeof c === 'string' && c.length > 0 && [...c].length <= MAX_CHARS && !/[\p{Cc}]/u.test(c);
const SHORTCUT = new Set(['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight']);
const SENDER_MODS = /^(Control|Meta|Alt)(Left|Right)$/; // held: no tx (a shortcut, or AltGr's own characters)
const SWITCH_KEY = /^(Shift|Control|Meta|Alt)(Left|Right)$|^(Fn|Space|CapsLock)$/; // up: the layout may have changed
const REFRESH_MS = 400;

// The helper's keyLayout reply → {code: text}, up to a ligature's few characters.
function clean(layout) {
  const out = {};
  if (!layout || typeof layout !== 'object') return out;
  for (const [code, ch] of Object.entries(layout)) {
    if (typeof code === 'string' && code.length <= 32 && PRINTABLE(ch)) out[code] = ch;
  }
  return out;
}

class KeyLayout {
  // request(cmd, args) -> Promise of the helper's reply; send(cmd, args): to the helper, no reply.
  constructor(request, send = () => {}) {
    this.request = request;
    this.send = send;
    this.map = {}; // code -> what it types alone
    this.shiftMap = {}; // code -> what it types with Shift (empty from an older helper)
    this.foreign = false; // our letter keys type another alphabet (Russian, Sinhala…)
    this.byChar = new Map(); // a–z -> our code for it
    this.canType = false; // the helper types text (its keyLayout says type: true)
    this.im = null; // the language of the input method typed with here (sending), or null
    this.canSelect = false; // the helper selects input methods (its keyLayout says selectInput: true)
    this.imHere = null; // the language we switched to for the other side's keys (receiving)
    this.mods = new Set(); // Ctrl / Cmd held (receiving)
    this.held = new Map(); // code pressed -> code injected for it (its key-up goes to the same one); null: typed
    this.shift = new Set(); // Shift held (sending)
    this.inShift = new Set(); // Shift held (receiving)
    this.outMods = new Set(); // Ctrl / Cmd / Alt held (sending)
    this.timer = null;
    this.generation = 0;
  }

  // Ask the helper again (the layout may have changed): on every crossing, either way.
  refresh() {
    const generation = ++this.generation;
    return Promise.resolve()
      .then(() => this.request('keyLayout', {}))
      .then((r) => {
        if (generation !== this.generation) return;
        this.set(r && r.layout, r && r.shift);
        this.canType = !!(r && r.type === true);
        this.canSelect = !!(r && r.selectInput === true);
        this.im = r && typeof r.im === 'string' && IM_LANG.test(r.im) ? r.im : null;
      })
      .catch(() => {}); // an older helper: no letters, keys as they are
  }

  set(layout, shift) {
    this.map = clean(layout);
    this.shiftMap = clean(shift);
    this.foreign = Object.keys(this.map).some((code) => code.startsWith('Key') && ALPHA.test(this.map[code]));
    this.byChar = new Map();
    for (const [code, ch] of Object.entries(this.map)) {
      if (!LETTER.test(ch)) continue;
      // Two keys for one letter (rare): the one in that letter's own place.
      if (!this.byChar.has(ch) || code === `Key${ch.toUpperCase()}`) this.byChar.set(ch, code);
    }
  }

  // Sending: the key event with the letter it types here, if it types one.
  tag(ev) {
    if (!ev || typeof ev.code !== 'string' || (ev.t !== 'k.kd' && ev.t !== 'k.ku')) return ev;
    const down = ev.t === 'k.kd';
    if (/^Shift/.test(ev.code)) down ? this.shift.add(ev.code) : this.shift.delete(ev.code);
    if (SENDER_MODS.test(ev.code)) down ? this.outMods.add(ev.code) : this.outMods.delete(ev.code);
    const ch = this.map[ev.code];
    if (!ch) return ev;
    if (this.im && down) ev = { ...ev, im: this.im };
    if (LETTER.test(ch)) return { ...ev, ch };
    if (down && (ALPHA.test(ch) || this.foreign) && !this.outMods.size) {
      const tx = this.shift.size ? this._shifted(ev.code) : ch;
      if (PRINTABLE(tx)) return { ...ev, tx };
    }
    return ev;
  }

  // What a key types here with Shift: the helper's shift map, else its capital (an older helper).
  _shifted(code) {
    const ch = this.map[code];
    return this.shiftMap[code] || (ch && ch.toUpperCase());
  }

  // Receiving (after the Ctrl/Cmd swap): the code to press here for this key event, or null when
  // there's nothing to press (its letter was typed as it is).
  code(down, code, ch, tx, im) {
    if (SHORTCUT.has(code)) {
      if (down) this.mods.add(code);
      else this.mods.delete(code);
    }
    if (/^Shift/.test(code)) down ? this.inShift.add(code) : this.inShift.delete(code);
    if (!down && SWITCH_KEY.test(code)) this._refreshSoon(); // Alt+Shift, 🌐, Win+Space… switch it here
    if (SHORTCUT.has(code)) return code;
    if (!down) {
      if (!this.held.has(code)) return code;
      const was = this.held.get(code);
      this.held.delete(code);
      return was;
    }
    if (!this.mods.size && this.map[code]) this._input(im); // a typing key: its input method here
    if (this.held.has(code)) { // held down: the repeats go to the same key (or are typed again)
      const was = this.held.get(code);
      if (was === null) this._type(tx);
      return was;
    }
    if (!this.mods.size && this._typeable(tx) && this._here(code) !== tx) { // our key types something else there
      this.held.set(code, null);
      this._type(tx);
      return null;
    }
    let to = code;
    if (this.mods.size && typeof ch === 'string' && LETTER.test(ch)) {
      const here = this.byChar.get(ch);
      if (here) to = here;
    }
    if (to !== code) this.held.set(code, to);
    return to;
  }

  // The other side types with an input method of language `im` (or none): ours of it, or back.
  _input(im) {
    if (!this.canSelect) return;
    const lang = typeof im === 'string' && IM_LANG.test(im) ? im : null;
    if (lang === this.imHere) return;
    if (lang) this.send('selectInput', { lang });
    else this.send('selectInput', { restore: true });
    this.imHere = lang;
  }

  // What this key types here, with the Shift held here.
  _here(code) {
    return this.inShift.size ? this._shifted(code) : this.map[code];
  }

  _typeable(tx) {
    return this.canType && PRINTABLE(tx); // only keys of another alphabet carry it (tag)
  }

  _type(tx) {
    if (this._typeable(tx)) this.send('type', { text: tx });
  }

  _refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), REFRESH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // Driven no more (or the helper released everything): nothing held.
  reset() {
    ++this.generation;
    if (this.imHere) this.send('selectInput', { restore: true });
    this.imHere = null;
    this.mods.clear();
    this.held.clear();
    this.shift.clear();
    this.inShift.clear();
    this.outMods.clear();
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { KeyLayout, clean };
