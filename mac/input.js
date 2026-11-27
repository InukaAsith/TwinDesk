// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Input inside Monitor 2 (in.* -> mac-helper `input`, keys swapped Ctrl<->Cmd when
// `swapKeys()`; a phone's stylus with its `pen`). The clipboard lives in clipboard.js.
//
// Stream input is applied only while `enabled()` is true (KVM home; switch it off).
// Everything we hold is released when the PC goes away, when Monitor 2 loses focus (Windows
// sends `clip.request` then), and when the stream restarts.
// Multi-device (`bus`, `takes(id)`): input from every device watching this Mac's stream (StreamSet
// streams to all of them), not only the selected one, whose viewers saw the picture but couldn't
// control it (#313); what one device holds is let go when another's input comes, or when it goes.
'use strict';

const P = require('../shared/protocol.js');

const IN_TYPES = [P.T.IN_MOVE, P.T.IN_DOWN, P.T.IN_UP, P.T.IN_WHEEL, P.T.IN_KEY_DOWN, P.T.IN_KEY_UP];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

class Input {
  constructor(server, helper, displays, { enabled = () => true, swapKeys = () => true, bus = null, takes = () => true } = {}) {
    this.server = server;
    this.helper = helper;
    this.displays = displays;
    this.enabled = enabled;
    this.swapKeys = swapKeys; // (from): Ctrl and Cmd swapped for that device's keys
    this.dirty = false; // something may be held in the helper
    this.from = null; // the device whose input came last (Multi-device)

    if (bus) {
      for (const t of IN_TYPES) bus.on(t, (msg, from) => takes(from) && this._onInput(msg, from));
      bus.onPeer('closed', (id) => { if (id === this.from) this.releaseAll(); });
      bus.on(P.T.CLIP_REQUEST, (m, from) => { if (from === this.from) this.releaseAll(); }); // its Monitor 2 lost focus
      return;
    }
    for (const t of IN_TYPES) server.on(`t:${t}`, (msg) => this._onInput(msg));
    server.on('closed', () => {
      if (!server.current) this.releaseAll();
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.releaseAll()); // Monitor 2 lost focus
  }

  _onInput(msg, from = null) {
    if (msg.wid != null) return; // input for one app window: appsend.js
    if (!this.enabled()) return;
    if (from !== this.from) { // another device's input: what the last one held goes
      this.releaseAll();
      this.from = from;
    }
    const target = this.displays.target();
    if (!target) return;
    let ev;
    switch (msg.t) {
      case P.T.IN_MOVE:
        ev = { t: msg.t, x: num(msg.x), y: num(msg.y) };
        break;
      case P.T.IN_DOWN:
      case P.T.IN_UP:
        ev = { t: msg.t, x: num(msg.x), y: num(msg.y), b: Math.max(0, Math.min(4, num(msg.b) | 0)) };
        break;
      case P.T.IN_WHEEL:
        ev = { t: msg.t, dx: num(msg.dx), dy: num(msg.dy) };
        break;
      default: // in.kd / in.ku
        if (typeof msg.code !== 'string' || msg.code.length > 32) return;
        ev = { t: msg.t, code: this.swapKeys(from) ? P.mapKeyFromOtherPlatform(msg.code) : msg.code };
    }
    const pen = msg.t === P.T.IN_MOVE || msg.t === P.T.IN_DOWN || msg.t === P.T.IN_UP ? P.penOf(msg.pen) : null;
    if (pen) ev.pen = pen; // a phone's stylus: a tablet pen (Inject.swift)
    if (pen && msg.t === P.T.IN_MOVE) { // the stroke's samples before this one, in order
      for (const q of P.penPoints(msg.pts, pen)) this.helper.send('input', { ev: { t: msg.t, x: q.x, y: q.y, pen: q.pen }, bounds: target.bounds });
    }
    if (msg.t !== P.T.IN_MOVE && msg.t !== P.T.IN_WHEEL) this.dirty = true;
    this.helper.send('input', { ev, bounds: target.bounds });
  }

  releaseAll() {
    if (!this.dirty) return;
    this.dirty = false;
    this.helper.send('releaseAll');
  }
}

module.exports = { Input };
