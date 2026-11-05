// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Awake while file bytes move (#143): Electron's powerSaveBlocker 'prevent-app-suspension' (the
// computer doesn't go to sleep on its own; the screen can still turn off). touch() as bytes go;
// it's let go HOLD_MS after the last of them, so a transfer that ends any way at all never keeps
// it. Outside Electron's main process (tests, the files engine's process) it does nothing.
'use strict';

const HOLD_MS = 60000;

let psb; // undefined: not looked up yet; null: none here
let blocker = null;
let timer = null;
let last = 0;

function blockerApi() {
  if (psb === undefined) {
    try {
      const e = require('electron');
      psb = (e && typeof e === 'object' && e.powerSaveBlocker) || null;
    } catch (_) {
      psb = null;
    }
  }
  return psb;
}

function release() {
  clearTimeout(timer);
  timer = null;
  if (blocker === null) return;
  try { psb.stop(blocker); } catch (_) { /* gone */ }
  blocker = null;
  console.log('[awake] file transfers done: may sleep');
}

function touch() {
  const now = Date.now();
  if (blocker !== null && now - last < 1000) return;
  last = now;
  const api = blockerApi();
  if (!api) return;
  if (blocker === null) {
    try {
      blocker = api.start('prevent-app-suspension');
      console.log('[awake] awake for file transfers');
    } catch (_) {
      return;
    }
  }
  clearTimeout(timer);
  timer = setTimeout(release, HOLD_MS);
  if (timer.unref) timer.unref();
}

module.exports = { touch, release, HOLD_MS };
