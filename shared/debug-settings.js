// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Debug's settings (docs/debug.md), in multi.json's mesh.debug, the same on every platform:
//   allow: the devices let debug this computer (ids); off for every device until one is let in
//   anyCommandUntil: Allow any command, on until then (ms; ANY_MAX at most from when it was set)
//   verbose: {tags, until}: the verbose log, so it outlives a restart until its time is up
'use strict';

const ANY_MAX = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9._:-]{1,80}$/;

function normalizeDebug(d) {
  d = d && typeof d === 'object' ? d : {};
  const allow = Array.isArray(d.allow) ? [...new Set(d.allow.filter((x) => typeof x === 'string' && ID.test(x)))].slice(0, 64) : [];
  const any = Number(d.anyCommandUntil);
  const v = d.verbose && typeof d.verbose === 'object' ? d.verbose : {};
  const tags = Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string' && /^[a-z]{1,16}$/.test(t)).slice(0, 10) : [];
  const until = Number(v.until);
  return {
    allow,
    anyCommandUntil: Number.isFinite(any) && any > 0 ? any : 0,
    verbose: { tags, until: Number.isFinite(until) && until > 0 && tags.length ? until : 0 },
  };
}

module.exports = { normalizeDebug, ANY_MAX };
