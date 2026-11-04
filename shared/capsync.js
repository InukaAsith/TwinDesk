// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Caps Lock follows the pointer (#131): the computer handing its input over (taking the other one, or
// sending it home) says whether its Caps Lock is on (`kvm.caps`), and the one getting it turns its own
// that way, so the light and the letters match on both.
//   Windows, macOS  the helper's `caps` command: {set?} → {on} (Native.Caps, Injector.caps)
//   Linux           the keyboard's light (/sys/class/leds/*::capslock, which the desktop keeps), and a
//                   Caps Lock tap through the helper to change it
// An older helper (no `caps`) or a Linux with no such light: nothing changes.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./protocol.js');

const LEDS = '/sys/class/leds';

function linuxCaps(dir = LEDS) {
  try {
    const leds = fs.readdirSync(dir).filter((n) => /::capslock$/.test(n));
    if (!leds.length) return null;
    return leds.some((n) => { try { return Number(fs.readFileSync(path.join(dir, n, 'brightness'), 'utf8')) > 0; } catch (_) { return false; } });
  } catch (_) { return null; }
}

class CapsSync {
  // helper: request(cmd, args) → Promise, send(cmd, args); platform: 'mac'|'win'|'linux'
  constructor({ helper, platform, leds = LEDS }) {
    Object.assign(this, { helper, platform, leds });
    this.until = 0; // a kvm.caps counts only just after we took the input (a take accepted, or home)
  }

  // We were just taken (driven), or our input came home: the other side's kvm.caps follows.
  expect(ms = 3000) {
    this.until = Date.now() + ms;
  }

  async get() {
    if (this.platform === 'linux') return linuxCaps(this.leds);
    try {
      const r = await this.helper.request('caps', {});
      return r && r.ok !== false && typeof r.on === 'boolean' ? r.on : null;
    } catch (_) { return null; }
  }

  async set(on) {
    if (typeof on !== 'boolean') return;
    if (this.platform !== 'linux') {
      try { await this.helper.request('caps', { set: on }); } catch (_) { /* an older helper */ }
      return;
    }
    const now = linuxCaps(this.leds);
    if (now === null || now === on) return;
    this.helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code: 'CapsLock' } });
    this.helper.send('inject', { ev: { t: P.T.K_KEY_UP, code: 'CapsLock' } });
  }

  // Our input goes over (send: the message's way there): tell the other computer our Caps Lock.
  async handOver(send) {
    const on = await this.get();
    if (typeof on === 'boolean') send({ t: P.T.KVM_CAPS, on });
  }

  // kvm.caps from the other computer: used only right after expect() (a refused take, a stale one: no).
  onPeer(m) {
    if (Date.now() > this.until || !m || typeof m.on !== 'boolean') return;
    this.until = 0;
    this.set(m.on);
  }
}

module.exports = { CapsSync, linuxCaps };
