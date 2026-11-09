// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Awake while file bytes move (#143): Electron's powerSaveBlocker 'prevent-app-suspension' (the
// computer doesn't go to sleep on its own; the screen can still turn off). touch() as bytes go;
// it's let go HOLD_MS after the last of them, so a transfer that ends any way at all never keeps
// it. Outside Electron's main process (tests, the files engine's process) it does nothing.
'use strict';

const HOLD_MS = 60000;
const quiet = () => require('./quiet.js');

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
  quiet().hold('files', false);
  if (blocker === null) return;
  try { psb.stop(blocker); } catch (_) { /* gone */ }
  blocker = null;
  console.log('[awake] file transfers done: may sleep');
}

function touch() {
  const now = Date.now();
  if (timer !== null && now - last < 1000) return; // touched this second: held already
  last = now;
  quiet().hold('files', true); // the session pings every second while files move (shared/quiet.js)
  const api = blockerApi();
  if (api && blocker === null) {
    try {
      blocker = api.start('prevent-app-suspension');
      console.log('[awake] awake for file transfers');
    } catch (_) { /* the quiet hold below still goes */ }
  }
  clearTimeout(timer);
  timer = setTimeout(release, HOLD_MS);
  if (timer.unref) timer.unref();
}

module.exports = { touch, release, HOLD_MS };
