// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// How a phone's notifications show here (Notifications › Showing here). Mac, Windows and Linux,
// settings.notifs:
//   style       'twindesk' | 'system' | 'none' (no pop-ups at all: Recent only, #266) | '' (unset: the system's)
//   otpCopy     a one-time code goes on the clipboard by itself (kept out of clipboard sync and history)
//   quiet       {on, from: 'HH:MM', to: 'HH:MM'} Pause pop-ups on a schedule: none in those hours
//               (across midnight too)
//   phoneApps   {app: {mode: 'quiet' | 'hide', name}} per phone app: no pop-ups (kept in the list), or
//               not at all; an app not in it is shown
//   takeAll     Multi-device: every device's notifications show here, every app (the grid is ignored)
//   fromApps    {senderId: {app: name}} Multi-device › Who shares what › Notifications: apps of one device
//               hidden here (the cell of that device's row in this computer's column); every other app
//               from it shows as above
// Quiet = still in Recent and Messages, only the pop-up is left out.
'use strict';

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_APPS = 300;

// A settings change from the page, checked; cur: settings.notifs now (phoneApp merges into it).
function clean(partial, cur) {
  const p = partial && typeof partial === 'object' ? partial : {};
  const out = {};
  if (p.style === 'twindesk' || p.style === 'system' || p.style === 'none' || p.style === '') out.style = p.style;
  if (typeof p.otpCopy === 'boolean') out.otpCopy = p.otpCopy;
  if (typeof p.takeAll === 'boolean') out.takeAll = p.takeAll;
  if (p.quiet && typeof p.quiet === 'object') {
    const q = { ...(cur && cur.quiet) || { on: false, from: '22:00', to: '07:00' } };
    if (typeof p.quiet.on === 'boolean') q.on = p.quiet.on;
    if (HHMM.test(p.quiet.from || '')) q.from = p.quiet.from;
    if (HHMM.test(p.quiet.to || '')) q.to = p.quiet.to;
    out.quiet = q;
  }
  const a = p.phoneApp;
  if (a && typeof a === 'object' && str(a.app, 200)) {
    const apps = { ...(cur && cur.phoneApps) || {} };
    const app = str(a.app, 200);
    if (a.mode === 'quiet' || a.mode === 'hide') apps[app] = { mode: a.mode, name: str(a.name, 100) || (apps[app] && apps[app].name) || app };
    else delete apps[app];
    const keys = Object.keys(apps);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_APPS))) delete apps[k];
    out.phoneApps = apps;
  }
  // One cell's app: {from, app, name, hide}.
  const f = p.fromApp;
  if (f && typeof f === 'object' && str(f.from, 64) && f.all === true) {
    const all = { ...(cur && cur.fromApps) || {} };
    delete all[str(f.from, 64)];
    out.fromApps = all;
  } else if (f && typeof f === 'object' && str(f.from, 64) && str(f.app, 200)) {
    const all = { ...(cur && cur.fromApps) || {} };
    const from = str(f.from, 64);
    const one = { ...(all[from] || {}) };
    if (f.hide === true) one[str(f.app, 200)] = str(f.name, 100) || str(f.app, 200);
    else delete one[str(f.app, 200)];
    if (Object.keys(one).length) all[from] = Object.fromEntries(Object.entries(one).slice(-MAX_APPS));
    else delete all[from];
    out.fromApps = Object.fromEntries(Object.entries(all).slice(-32));
  }
  return out;
}

const minutes = (hhmm) => { const m = HHMM.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };

// In the quiet hours now: from ≤ now < to, across midnight when from > to; never when they're equal.
function inQuiet(q, date = new Date()) {
  if (!q || !q.on) return false;
  const a = minutes(q.from), b = minutes(q.to);
  if (a < 0 || b < 0 || a === b) return false;
  const n = date.getHours() * 60 + date.getMinutes();
  return a < b ? n >= a && n < b : n >= a || n < b;
}

// What a phone's notification gets here: 'show' (a pop-up and the list), 'quiet' (the list only) or
// 'hide' (nothing). m: the notif as it came.
// origin: the device it started on (Multi-device), for fromApps.
function modeOf(cfg, m, date, origin) {
  const c = cfg || {};
  const app = str(m && m.app, 200);
  if (app && origin && !c.takeAll && c.fromApps && c.fromApps[origin] && c.fromApps[origin][app] !== undefined) return 'hide';
  const own = app && c.phoneApps && c.phoneApps[app];
  if (own && own.mode === 'hide') return 'hide';
  if (own && own.mode === 'quiet') return 'quiet';
  if (c.style === 'none') return 'quiet'; // Pop-ups › None: every app's go in Recent only
  if (inQuiet(c.quiet, date)) return 'quiet';
  return 'show';
}

// The saved ones, as read at start (settings.js on Windows and Linux rebuild settings.notifs).
function saved(nf) {
  const c = clean({ style: nf && nf.style, otpCopy: nf && nf.otpCopy, quiet: nf && nf.quiet }, {});
  const apps = {};
  const src = nf && nf.phoneApps && typeof nf.phoneApps === 'object' ? nf.phoneApps : {};
  for (const [app, v] of Object.entries(src).slice(-MAX_APPS)) {
    if (v && (v.mode === 'quiet' || v.mode === 'hide') && str(app, 200)) apps[str(app, 200)] = { mode: v.mode, name: str(v.name, 100) || app };
  }
  const fromApps = {};
  const fsrc = nf && nf.fromApps && typeof nf.fromApps === 'object' ? nf.fromApps : {};
  for (const [from, list] of Object.entries(fsrc).slice(-32)) {
    if (!str(from, 64) || !list || typeof list !== 'object') continue;
    const one = {};
    for (const [app, name] of Object.entries(list).slice(-MAX_APPS)) if (str(app, 200)) one[str(app, 200)] = str(name, 100) || app;
    if (Object.keys(one).length) fromApps[str(from, 64)] = one;
  }
  return { style: c.style || '', otpCopy: !!c.otpCopy, takeAll: !!(nf && nf.takeAll === true), quiet: c.quiet || { on: false, from: '22:00', to: '07:00' }, phoneApps: apps, fromApps };
}

module.exports = { clean, saved, inQuiet, modeOf, HHMM };
