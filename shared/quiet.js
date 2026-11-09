// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Quiet links (docs/protocol.md "Quiet links", #143): a session that nothing uses stops pinging every
// second, so a phone's radio and CPU (and a laptop's) can sleep. Each end says `idle {on}` for its own
// side whenever that changes; a socket goes quiet only while BOTH ends say idle, so an older app (that
// never says it) keeps today's PING_MS / TIMEOUT_MS exactly.
//
// This end is idle when nothing here needs the second-by-second pings: no hold (input shared either way:
// the KVM silence watch lives on pings; file bytes moving, shared/awake.js), not the multi-device input
// partner's link, not within ACTIVE_MS of opening or of wake(), and Prioritize performance over battery
// life off. Messages don't make it busy: clipboard, notifications, a battery level or a volume going by
// cost one message each, not a burst of pings.
//
// Quiet: one ping every QUIET_PING_MS (a safety net: a computer that restarted can't leave a dead
// session up for good) and closed after QUIET_TIMEOUT_MS of silence. A message sent while quiet is
// followed by one ping (a probe): nothing back within PROBE_MS and the socket is closed, so a dead
// session is found when it's used (and reconnects) instead of minutes later. Leaving quiet, the silence
// limit counts from then (not from the last ping minutes ago). wake() (the computer woke, the screen
// unlocked) makes every socket active for ACTIVE_MS, so a dead one is found within TIMEOUT_MS.
//
// Sites (server.js, link.js, mesh) call:
//   seen(ws, msg)            on every message in; true: it was `idle` (consumed)
//   sent(ws, msg)            on every message out
//   tick(ws, now, rx, raw, busy)  in the liveness timer, per socket -> {quiet, ping, dead, rx}.
//                            raw(obj) sends on that socket; busy: this link is in use here (multi-device:
//                            the input partner's link, where the hold is per link, not 'kvm'). quiet: use
//                            ping/dead from here; else the site's own rule, with rx (its last-heard time,
//                            raised past a quiet spell).
'use strict';

const ACTIVE_MS = 15000;
const QUIET_PING_MS = 5 * 60 * 1000;
const QUIET_TIMEOUT_MS = 11 * 60 * 1000;
const PROBE_MS = 8000; // TIMEOUT_MS: a probe's answer
const T_IDLE = 'idle';

const holds = new Set();
const listeners = new Set();
let keep = false;
let keepFn = null; // use(): the app's settings, read live (settings.app.keepPinging)
let wokeAt = 0;

function changed() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error('[quiet]', e); }
  }
}

// General › Connections › Prioritize performance over battery life.
function setKeep(on) {
  on = !!on;
  if (on === keep) return;
  keep = on;
  console.log(`[quiet] keep pinging ${on ? 'on' : 'off'}`);
  changed();
}

// Something live here that needs the second-by-second pings: input shared, file bytes moving.
function hold(key, on) {
  const had = holds.has(key);
  if (on) holds.add(key); else holds.delete(key);
  if (had !== !!on) changed();
}

function wake() {
  wokeAt = Date.now();
  changed();
}

// The liveness timers run this on any change, so a hold reaches the other end within a tick.
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function keeping() {
  if (keep) return true;
  try { return !!(keepFn && keepFn()); } catch (_) { return true; }
}

function idleHere(ws, now) {
  if (keeping() || holds.size) return false;
  return now - Math.max(ws.quietOpened || 0, wokeAt) >= ACTIVE_MS;
}

function counts(msg) {
  const t = msg && msg.t;
  return t !== 'ping' && t !== 'pong' && t !== T_IDLE;
}

function seen(ws, msg) {
  if (!ws) return false;
  if (msg && msg.t === T_IDLE) {
    ws.quietPeer = msg.on === true;
    return true;
  }
  return false;
}

// Sent while quiet: a probe follows (tick), unless one is out already.
function sent(ws, msg) {
  if (ws && ws.quietSince && counts(msg) && !ws.quietProbe) ws.quietProbe = Date.now();
}

function tick(ws, now, rx, raw, busy = false) {
  if (!ws.quietOpened) ws.quietOpened = now;
  const mine = !busy && idleHere(ws, now);
  if ((ws.quietSaid || false) !== mine) { // nothing said yet = busy (what an older app assumes)
    // Only once the other end has shown it knows `idle` (it said it), or to say we're idle: an older
    // app ignores the type. Saying busy before it ever said idle is pointless but harmless.
    try { raw({ t: T_IDLE, on: mine }); ws.quietSaid = mine; } catch (_) { /* closed: the timer sees it */ }
  }
  const quiet = mine && ws.quietPeer === true;
  if (quiet) {
    if (!ws.quietSince) ws.quietSince = now;
    if (now - rx > QUIET_TIMEOUT_MS) return { quiet, dead: true, ping: false, rx };
    if (ws.quietProbe) {
      if (rx >= ws.quietProbe) { ws.quietProbe = 0; ws.quietProbed = false; } // answered: alive
      else if (!ws.quietProbed) { ws.quietProbed = true; ws.quietPing = now; return { quiet, dead: false, ping: true, rx }; }
      else if (now - ws.quietProbe > PROBE_MS) return { quiet, dead: true, ping: false, rx };
      else return { quiet, dead: false, ping: false, rx };
    }
    const ping = now - Math.max(ws.quietPing || 0, ws.quietSince) >= QUIET_PING_MS;
    if (ping) ws.quietPing = now;
    return { quiet, dead: false, ping, rx };
  }
  if (ws.quietSince) { // active again: the silence limit counts from now, not from the last quiet ping
    ws.quietSince = 0;
    ws.quietEnd = now;
    ws.quietProbe = 0; // the second pings find a dead one now
    ws.quietProbed = false;
  }
  return { quiet: false, dead: false, ping: false, rx: Math.max(rx, ws.quietEnd || 0) };
}

// main.js: Prioritize performance over battery life (settings.app.keepPinging) from the app's settings (read on every tick, so a change
// applies within a second), and the power events.
function use(fn) {
  keepFn = typeof fn === 'function' ? fn : null;
  watchPower();
}

// Electron's main process: the computer woke or the screen unlocked, so look at every link now.
let watching = false;
function watchPower() {
  if (watching) return;
  let pm;
  try { pm = require('electron').powerMonitor; } catch (_) { return; }
  if (!pm || typeof pm.on !== 'function') return;
  for (const ev of ['resume', 'unlock-screen', 'user-did-become-active']) {
    try { pm.on(ev, wake); } catch (_) { /* not on this OS */ }
  }
  watching = true;
}

module.exports = {
  ACTIVE_MS, QUIET_PING_MS, QUIET_TIMEOUT_MS, PROBE_MS, T_IDLE,
  setKeep, keep: keeping, use, hold, wake, onChange, seen, sent, tick, watchPower,
  _reset() { holds.clear(); listeners.clear(); keep = false; keepFn = null; wokeAt = 0; },
};
