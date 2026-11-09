// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone as this computer's remote (Windows, Mac and Linux): its Remote page (a touchpad, a
// keyboard, a gamepad whose buttons are keys) moves this computer's pointer, clicks, scrolls and
// types. Relative input (remote.*) goes straight to the helper as k.* events, while the Remote tab's
// switch is on (settings.remote.allow, on until turned off) and this computer's own mouse is at home
// (not driving the phone or another computer). When it isn't taken, the phone is told why
// (remote.state {allowed, why}), and the Remote tab says it too.
// Voice typing (the phone's Remote › Voice typing; its keys and text come with voice: true) goes by
// the Keyboard tab's switch instead (settings.kvm.keyboard): typing on this computer from the phone
// is the keyboard's (remote.state {voice, voiceWhy}). Loaded while Remote or Keyboard is on (main.js
// loadRemote); with both off nothing of it is loaded and the phone hears why from a stub.
// Real gamepad (settings.remote.pad, off until turned on): the gamepad page's sticks, triggers and
// buttons as a real controller here instead of keys (remote.pad; remote.state {pad: true} while it's
// taken). Its driver (windows/gamepad.js, linux/gamepad.js) is loaded only when it's turned on and
// installs what it needs the first time; its feed process runs only while the phone is connected.
//
// server: the phone's session (on('t:<type>'), on('closed'), current, sendToClient);
// helper: helper.js; getSettings(); atHome(): this computer's mouse is its own; onChange();
// loadPad() → the pad driver {check() → {supported, installed, message}, install(), feed(onExit) →
// ChildProcess}, or none where there's no way (padNote says why); save().
'use strict';

const P = require('./protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && P.isPhoneOs(ctx.os); // Android or iPhone
const num = (v, max) => Math.max(-max, Math.min(max, Number(v) || 0));
const BUTTONS = new Set(Object.values(P.BUTTON));
const CODE = /^[A-Za-z0-9]{1,32}$/; // KeyboardEvent.code names (KeyA, ArrowLeft, MediaPlayPause…)
const USING_MS = 3000; // input this recent: "in use now"

// remote.pad -> the feed's 12 bytes: u16 buttons, i16 lx ly rx ry (y down), u8 lt rt, little-endian.
function padBytes(m) {
  const b = Buffer.alloc(12);
  const axis = (v) => Math.round(Math.max(-1, Math.min(1, Number(v) || 0)) * 32767);
  const trigger = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  b.writeUInt16LE((Number(m.b) >>> 0) & 0x3fff, 0);
  b.writeInt16LE(axis(m.lx), 2);
  b.writeInt16LE(axis(m.ly), 4);
  b.writeInt16LE(axis(m.rx), 6);
  b.writeInt16LE(axis(m.ry), 8);
  b[10] = trigger(m.lt);
  b[11] = trigger(m.rt);
  return b;
}
const PAD_ZERO = padBytes({});

class PhoneRemote {
  constructor({ server, helper, getSettings, atHome, onChange = () => {}, loadPad = null, padNote = '', save = () => {} }) {
    Object.assign(this, { server, helper, getSettings, atHome, onChange, loadPad, padNote, save });
    this.pad = null; // the driver, once Real gamepad was turned on
    this.padProc = null; // its feed process
    this.padBusy = ''; // 'Checking…', 'Installing…'
    this.padMessage = ''; // why it isn't working
    this.padSupported = !!loadPad;
    this.held = false; // keys or buttons the phone may still hold down here
    this.refusedAt = 0;
    this.lastInput = 0;
    this.opened = false; // the phone's Remote page is open (it said hello)
    this.canType = false; // the helper types text as it is (its keyLayout says type: true): remote.text
    const on = (t, fn) => server.on(`t:${t}`, (m) => isPhone(server.current) && fn(m || {}));
    on(T.REMOTE_HELLO, () => {
      this.opened = true;
      if (this.padOn) this._padStart();
      this._state();
      this._askType();
      this.onChange();
    });
    // smooth: the helper eases the move out over about a frame instead of jumping (Smoother.cs).
    on(T.REMOTE_MOVE, (m) => this._ev({ t: T.K_MOVE, dx: num(m.dx, 4000), dy: num(m.dy, 4000), smooth: m.smooth === true }));
    on(T.REMOTE_DOWN, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_DOWN, b: m.b }));
    on(T.REMOTE_UP, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_UP, b: m.b }));
    on(T.REMOTE_WHEEL, (m) => this._ev({ t: T.K_WHEEL, dx: num(m.dx, 4000), dy: num(m.dy, 4000), mode: 'pixel' }));
    on(T.REMOTE_KEY_DOWN, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_DOWN, code: m.code }, m.voice === true));
    on(T.REMOTE_KEY_UP, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_UP, code: m.code }, m.voice === true));
    // Characters no key types here (Cyrillic, accents…): typed as they are. Control characters don't go.
    on(T.REMOTE_TEXT, (m) => {
      if (!this.canType || typeof m.text !== 'string') return;
      const text = [...m.text.replace(/\p{Cc}/gu, '')].slice(0, 64).join('');
      if (text && this._take(m.voice === true)) this.helper.send('type', { text });
    });
    on(T.REMOTE_PAD, (m) => this.padProc && this._take() && this.padProc.stdin.write(padBytes(m)));
    on(T.REMOTE_RELEASE, () => {
      this.release();
      this.opened = false; // the page closed
      this.onChange();
    });
    // The phone went away holding a key (Wi-Fi dropped mid-press): let it go here.
    server.on('closed', () => {
      this.release();
      this._padStop();
      this.opened = false;
      this.onChange();
    });
  }

  get allow() {
    const r = this.getSettings().remote;
    return !(r && r.allow === false);
  }

  // Why it isn't taken now, '' when it is.
  get why() {
    if (!this.allow) return 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there';
    if (!this.atHome()) return 'This computer’s mouse is on another device now (Cursor): bring it back first';
    return '';
  }

  // Voice typing: the Keyboard tab's switch, '' when it types here.
  get voiceWhy() {
    const k = this.getSettings().kvm;
    if (!(k && k.keyboard)) return P.KEYBOARD_OFF;
    if (!this.atHome()) return 'This computer’s mouse is on another device now (Cursor): bring it back first';
    return '';
  }

  // The Remote tab's switch (and its answer to the phone).
  setAllow(on) {
    const s = this.getSettings();
    s.remote = { ...(s.remote || {}), allow: !!on };
    if (!on) this.release();
    this._state();
    this.onChange();
  }

  get padOn() {
    const r = this.getSettings().remote;
    return !!(r && r.pad === true);
  }

  // The Remote tab's Real gamepad switch: on installs the driver the first time.
  setPad(on) {
    const s = this.getSettings();
    s.remote = { ...(s.remote || {}), pad: !!on };
    this.save();
    this.padMessage = '';
    if (on) this._padStart();
    else this._padStop();
    this._state();
    this.onChange();
  }

  async _padStart() {
    if (this.padProc || this.padBusy || !this.loadPad || !isPhone(this.server.current)) return;
    const say = (busy, message = this.padMessage) => {
      this.padBusy = busy;
      this.padMessage = message;
      this.onChange();
    };
    try {
      if (!this.pad) this.pad = this.loadPad();
      say('Checking…');
      const c = await this.pad.check();
      if (!c.supported) {
        this.padSupported = false;
        return say('', c.message || 'Not on this computer');
      }
      if (!c.installed) {
        say('Installing…');
        await this.pad.install();
      }
      say('');
    } catch (e) {
      // Not installed (the prompt declined, the download failed): off again, and why.
      const s = this.getSettings();
      s.remote = { ...(s.remote || {}), pad: false };
      this.save();
      say('', e.message || String(e));
      this._state();
      return;
    }
    if (!this.padOn || this.padProc || !isPhone(this.server.current)) return;
    const p = this.pad.feed((code) => {
      if (this.padProc !== p) return;
      this.padProc = null;
      if (this.padOn && code !== 0 && code !== null) this.padMessage = 'The controller stopped: turn Real gamepad off and on again';
      this._state();
      this.onChange();
    });
    this.padProc = p;
    this._state();
    this.onChange();
  }

  _padStop() {
    const p = this.padProc;
    if (!p) return;
    this.padProc = null; // unplugged when its stdin closes
    p.stdin.write(PAD_ZERO);
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch {} }, 2000);
  }

  // This computer's mouse went to another device or came back: the phone hears whether it's taken.
  refresh() {
    this._state();
    this.onChange();
  }

  _state() {
    if (!isPhone(this.server.current)) return;
    const why = this.why;
    this.server.sendToClient({ t: T.REMOTE_STATE, allowed: !why, off: !this.allow, why, pad: !why && !!this.padProc, text: this.canType, voice: !this.voiceWhy, voiceWhy: this.voiceWhy }); // off: the page offers Turn on (pair.sync)
  }

  // Whether the helper types text (an older one doesn't; nor does Linux on Wayland): the phone sends
  // remote.text only then.
  _askType() {
    Promise.resolve()
      .then(() => this.helper.request('keyLayout', {}))
      .then((r) => {
        const can = !!(r && r.type === true);
        if (can === this.canType) return;
        this.canType = can;
        this._state();
      })
      .catch(() => {});
  }

  // Input from the phone is taken now (or the phone hears why not); it's "in use".
  _take(voice = false) {
    if (voice ? this.voiceWhy : this.why) {
      this.refused = true;
      // Tell the phone (it says why on its Remote page), at most once a second.
      const now = Date.now();
      if (now - this.refusedAt > 1000) {
        this.refusedAt = now;
        this._state();
        this.onChange();
      }
      return false;
    }
    if (this.refused) { this.refused = false; this._state(); } // taken again: the phone hears it
    const was = this.lastInput;
    this.lastInput = Date.now();
    if (this.lastInput - was > USING_MS) this.onChange(); // "in use now"
    clearTimeout(this.usingTimer);
    this.usingTimer = setTimeout(() => this.onChange(), USING_MS + 100);
    return true;
  }

  _ev(ev, voice = false) {
    if (!this._take(voice)) return;
    if (ev.t === T.K_DOWN || ev.t === T.K_KEY_DOWN) this.held = true;
    this.helper.send('inject', { ev });
  }

  release() {
    if (this.padProc) this.padProc.stdin.write(PAD_ZERO);
    if (!this.held) return;
    this.held = false;
    if (this.atHome()) this.helper.send('releaseAll');
  }

  // For the Remote tab (state.remote).
  get view() {
    return {
      allow: this.allow,
      why: this.why,
      opened: this.opened && isPhone(this.server.current),
      using: Date.now() - this.lastInput < USING_MS,
      pad: {
        on: this.padOn,
        supported: this.padSupported,
        live: !!this.padProc,
        busy: this.padBusy,
        message: this.padSupported ? this.padMessage : (this.padMessage || this.padNote),
        name: this.pad ? this.pad.name : '',
      },
    };
  }
}

module.exports = { PhoneRemote, padBytes };
