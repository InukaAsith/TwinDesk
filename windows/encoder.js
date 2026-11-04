// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Advanced › Hardware encoder (#133): the screen and app windows are encoded on the GPU
// (Media Foundation) or, off, in software (OpenH264): Chromium's disable-webrtc-hw-encoding switch,
// set at startup (so a change shows Restart). Kept in encoder.json, read before the app is ready by
// main.js, both one-to-one and multi-device.
// Some GPUs' encoder stalls: frames go on being captured but nothing is sent (#133). The watch
// below sees it in the sender's stats; it turns the hardware encoder off, and the next start (Restart)
// uses the software one.
'use strict';

const store = require('./store');

const FILE = 'encoder.json';
const STALL_S = 4; // seconds with frames captured and nothing sent
const STALL_FRAMES = 10; // ... at least this many frames captured and never encoded in them

let atStart = null; // {hw} as this run started

function read() {
  const e = store.read(FILE, {}) || {};
  return { hw: e.hw !== false, auto: e.auto === true && e.hw === false, reason: typeof e.reason === 'string' ? e.reason.slice(0, 200) : '' };
}

function write(hw, auto = false, reason = '') {
  store.write(FILE, { hw: !!hw, auto: !hw && !!auto, reason: !hw && auto ? String(reason).slice(0, 200) : '' });
}

// main.js, before app ready (after userData is set).
function start(app) {
  atStart = read();
  if (!atStart.hw) app.commandLine.appendSwitch('disable-webrtc-hw-encoding');
  return atStart;
}

function view() {
  const now = read();
  return { ...now, atStart: atStart ? atStart.hw : now.hw, restart: !!atStart && atStart.hw !== now.hw };
}

// One session's sender stats, once a second: true once the hardware encoder stalled.
class StallWatch {
  constructor() { this.reset(); }
  reset() { this.bad = 0; this.dropped = null; this.sent = false; this.fired = false; }
  feed(st) {
    if (this.fired || !st || (atStart && !atStart.hw)) return false;
    const hw = st.hw === true || /MediaFoundation|Accelerat|NVENC|AMF|QuickSync|Intel/i.test(String(st.encoder || ''));
    if (!hw) { this.bad = 0; return false; }
    if (st.mbps > 0.3) this.sent = true;
    const dropped = Number(st.dropped) || 0;
    if (this.bad === 0) this.dropped = dropped;
    if (this.sent && st.mbps < 0.02) this.bad++;
    else { this.bad = 0; return false; }
    if (this.bad >= STALL_S && dropped - this.dropped >= STALL_FRAMES) {
      this.fired = true;
      return true;
    }
    return false;
  }
}

// The watch fired: off from the next start.
function fallBack(reason) {
  const now = read();
  if (!now.hw) return false;
  write(false, true, reason);
  return true;
}

module.exports = { start, read, write, view, fallBack, StallWatch, FILE };
