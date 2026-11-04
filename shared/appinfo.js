// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which TwinDesk the other device runs. Each side puts {v: its version, f: [feature ids]} in its
// dev.state (shared/devctl.js) as `app`; one that says nothing is older than this (2.5). Overview
// shows the other side's version (red when it's older), and the app tells once per session when the
// other side lacks something this one has.
'use strict';

// Features that need TwinDesk on both sides, by the id each side lists. Labels are shown as is
// (translated by the window or the notification).
const FEATURES = {
  lane: 'Faster mouse and keyboard',
  fastFiles: 'Faster file transfers',
  h265: 'H.265 screen sharing',
  chats: 'Chat apps in Messages',
};

// What this app has (the computers: all of them, H.265 unless switched off).
function mine() {
  return Object.keys(FEATURES).filter((k) => k !== 'h265' || !process.env.TWINDESK_NO_H265);
}

// 2.5.0-beta.1 < 2.5.0 < 2.5.1. Anything unparsable sorts first.
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || ''));
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre || !y.pre) return x.pre ? -1 : 1; // a pre-release is before its release
  const p = x.pre.split('.'), q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn && qn && Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

// The `app` field another side sent, kept to known sizes (null: it sent none).
function clean(a) {
  if (!a || typeof a !== 'object') return null;
  const v = typeof a.v === 'string' && parse(a.v) ? a.v.slice(0, 40) : '';
  const f = Array.isArray(a.f) ? a.f.filter((x) => typeof x === 'string').slice(0, 64).map((x) => x.slice(0, 40)) : null;
  return { v, f };
}

// The other side against this one. remote: clean()'s result or null. phone: a phone has its own
// features, so only the version counts.
//   version: theirs ('' unknown: an app from before this check), older/newer than ours,
//   missing: our feature ids they lack (none listed for an unknown one: we can't tell which).
function check(ours, remote, { phone = false, features = mine() } = {}) {
  const v = remote ? remote.v : '';
  const c = v ? compare(v, ours) : -1;
  const missing = phone || !remote || !remote.f ? [] : features.filter((k) => !remote.f.includes(k));
  return { version: v, older: c < 0, newer: c > 0, missing };
}

module.exports = { FEATURES, mine, parse, compare, clean, check };
