// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which desktop preview a Mac may take, keep, or throw away.
//
// The desktop catalog is the authorization list. A shot is taken only for a display
// that catalog names, and only for the space that catalog says is current on it.
// Nothing here switches a desktop to photograph it, and nothing draws a stand-in image.
// Mesh catalogs name the viewer's display only, so another viewer's display is not a target.
//
// macOS 14 ScreenCaptureKit is the only capture. This module does not call Electron's
// desktopCapturer. A nonzero thumbnail from getSources captures every display.
'use strict';

const MAX_EDGE = 480;
const MAX_BYTES = 24 * 1024;
const MAX_SHOTS = 12;
const MAX_BAGS = 3;
const MAX_STORE_BYTES = MAX_SHOTS * MAX_BYTES;
const MIN_GAP_MS = 2000;
const REFRESH_MS = 8000;
const TIMEOUT_MS = 2000;
// The sheet-open named by screen.preview.want and echoed on every screen.preview.
// 2^48-1 is an integer in both JS and the phone's JSON numbers.
const ASK_MAX = 0xffffffffffff;

function key(displayId, spaceId) {
  return String(displayId) + '\n' + String(spaceId);
}

function liveConn(conn) {
  return !!(conn && conn.authed === true && conn.released !== true && conn.ws && conn.ws.readyState === 1);
}

// The socket session.send actually writes. The guest link wins while it is up, including
// when a host socket is also still stored. A released host is not this object.
function outbound(session) {
  if (!session || session.connected !== true) return null;
  if (session.linkUp === true) return session.link || null;
  if (session.hostUp === true && session.linkUp !== true) return session.ctx || null;
  return null;
}

function screenUnlocked(locked) {
  return locked === false;
}

// True only for a fresh accessibility read that says Mission Control is hidden.
// TwinDesk's own inputHeld flag is not that read: a Mission Control the person opened
// leaves input running. "visible" and "unknown", and a missing or any other value, fail closed.
function missionHidden(look) {
  return !!(look && typeof look === 'object' && look.overview === 'hidden');
}

// The want message has to be the outbound socket itself, and that socket has to be the
// authenticated one session.send writes. A host socket that is still up while the guest
// link is the outbound path is not this viewer. A replaced ws fails later, against the
// ws captured here.
function askEpoch(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ASK_MAX) return null;
  return value;
}

function authorizeWant(bound, inbound) {
  if (!liveConn(bound) || !inbound || inbound !== bound || bound.ws == null) return null;
  return { conn: bound, ws: bound.ws };
}

function catalogPermits(catalog, displayId) {
  const id = String(displayId);
  const displays = catalog && Array.isArray(catalog.displays) ? catalog.displays : [];
  return displays.some((d) => d && String(d.id) === id);
}

// Current space of each permitted display, in catalog order. Other spaces are not targets.
function currentTargets(catalog) {
  const out = [];
  const displays = catalog && Array.isArray(catalog.displays) ? catalog.displays : [];
  for (const d of displays) {
    if (!d || typeof d.id !== 'string' || !/^\d{1,10}$/.test(d.id) || d.id === '0') continue;
    if (!Number.isInteger(d.current) || d.current < 0) continue;
    const spaces = Array.isArray(d.spaces) ? d.spaces : [];
    const spaceId = spaces[d.current];
    if (typeof spaceId !== 'string' || !/^\d{1,20}$/.test(spaceId) || spaceId === '0') continue;
    if (out.some((t) => t.displayId === d.id)) continue;
    out.push({ displayId: d.id, spaceId });
    if (out.length >= 8) break;
  }
  return out;
}

// The space a fresh helper read says is current on that display. '' if it is missing,
// duplicated, or not in that display's own list. This does not look at other displays.
function currentSpaceId(look, displayId) {
  const want = String(displayId);
  let found = '';
  let seen = false;
  const rows = look && Array.isArray(look.displays) ? look.displays : [];
  for (const d of rows) {
    if (!d || d.cgId == null || String(d.cgId) !== want) continue;
    if (seen) return '';
    seen = true;
    const spaces = Array.isArray(d.spaces) ? d.spaces.map((id) => String(id)) : [];
    const current = d.current == null ? '' : String(d.current);
    if (!/^\d{1,20}$/.test(current) || current === '0' || !spaces.includes(current)) return '';
    found = current;
  }
  return found;
}

function displayNumber(id) {
  if (typeof id !== 'string' || !/^\d{1,10}$/.test(id) || id === '0') return null;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffffffff) return null;
  return n;
}

function fenceReady(fence) {
  if (!fence || !liveConn(fence.conn) || fence.conn.ws == null) return false;
  if (!Number.isSafeInteger(fence.capture) || fence.capture <= 0 || fence.capture > 0xffffffff) return false;
  if (!Number.isSafeInteger(fence.viewGen) || fence.viewGen < 0 || fence.viewGen > 0xffffffff) return false;
  if (displayNumber(fence.displayId) == null) return false;
  if (typeof fence.spaceId !== 'string' || !/^\d{1,20}$/.test(fence.spaceId) || fence.spaceId === '0') return false;
  return true;
}

// One display that needs a picture, or null. gapOk false never chooses, so captures stay
// at least MIN_GAP_MS apart. A space that is not current is not in `targets`.
function choose(targets, shots, now, gapOk) {
  if (!gapOk || !Array.isArray(targets) || !targets.length) return null;
  const missing = targets.find((t) => t && !shots.has(key(t.displayId, t.spaceId)));
  if (missing) return { displayId: missing.displayId, spaceId: missing.spaceId };
  let best = null;
  for (const t of targets) {
    const shot = shots.get(key(t.displayId, t.spaceId));
    if (!shot || now - shot.at < REFRESH_MS) continue;
    if (!best || shot.at < best.at) best = { displayId: t.displayId, spaceId: t.spaceId, at: shot.at };
  }
  return best ? { displayId: best.displayId, spaceId: best.spaceId } : null;
}

// Milliseconds until the next current desktop needs a new picture. null when there is
// nothing permitted to photograph. 0 means one is already due.
function dueIn(targets, shots, now) {
  if (!Array.isArray(targets) || !targets.length) return null;
  let wait = Infinity;
  for (const t of targets) {
    const shot = shots.get(key(t.displayId, t.spaceId));
    const remain = shot ? Math.max(0, REFRESH_MS - (now - shot.at)) : 0;
    if (remain < wait) wait = remain;
  }
  return wait === Infinity ? null : wait;
}

function decodeJpeg(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_BYTES * 2) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let buf;
  try { buf = Buffer.from(value, 'base64'); } catch (_) { return null; }
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > MAX_BYTES) return null;
  return buf;
}

function acceptJpeg(buf, width, height) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > MAX_BYTES) return false;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) return false;
  return true;
}

module.exports = {
  MAX_EDGE, MAX_BYTES, MAX_SHOTS, MAX_BAGS, MAX_STORE_BYTES, MIN_GAP_MS, REFRESH_MS, TIMEOUT_MS, ASK_MAX,
  key, liveConn, outbound, askEpoch, authorizeWant, screenUnlocked, missionHidden, catalogPermits, currentTargets,
  currentSpaceId, displayNumber, fenceReady, choose, dueIn, decodeJpeg, acceptJpeg,
};
