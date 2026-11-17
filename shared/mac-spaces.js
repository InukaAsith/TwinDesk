// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which macOS desktop (Space) a phone may move, on the display it is being shown.
//
// macOS has no public per-display desktop switch. Control-Left and Control-Right follow keyboard
// focus, and with "Displays have separate Spaces" turned off they move every display. This module
// never asks for those keys. A switch is allowed only when the helper's snapshot shows the
// destination desktop on the viewed display and on no other display. The index is that desktop's
// place in the list the helper reads. Anything short of one owned destination is a refusal:
// the helper must not be told to open Mission Control. `composed` must be true as well:
// a read of the on-screen windows says each one belongs to a desktop that is current.
// Anything short of that is a refusal, including a missing flag. `ax` must be true:
// a missing or false accessibility read hides the buttons, because every press would fail.
// `inputHeld` hides them too. Remote input stays paused until a fresh read says Mission
// Control is hidden; an unknown read does not resume it and does not send a touch.
//
// A switch records the viewed display when the message arrives, not when the queued
// action runs. `generation`, when the target has one, changes on every selection change,
// so a return to the same display id (A→B→A) is still a different selection. Without a
// generation, only the id can be compared.
'use strict';

const SPACE_ID = /^\d{1,20}$/;
const MAX_DISPLAYS = 8;
const MAX_LISTED = 64;
const MAX_COUNT = 256;

function cleanLabel(s) {
  const name = String(s || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return name;
}

function namedRows(list) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'number' ? String(d.id) : typeof d.id === 'string' ? d.id : '';
    if (!/^\d+$/.test(id) || id === '0' || id.length > 16 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanLabel(d.name || d.label), primary: d.primary === true });
    if (out.length >= MAX_DISPLAYS) break;
  }
  return out;
}

// Which displays a screen.state catalog may name. mesh never offers a switch to another
// display: one viewer's choice must not move another viewer's picture. Names are still
// returned so the viewed display can be labeled. They are not part of the revision.
function catalogOffer(list, opts) {
  const c = opts || {};
  let named = [];
  try { named = require('./screen-pick.js').shareable(list); } catch (_) { named = []; }
  const offerDisplays = c.mesh !== true && c.remote !== false && c.held !== true && named.length > 0;
  return { named, offerDisplays };
}

function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dirOf(msg) {
  if (!msg || typeof msg !== 'object') return 0;
  if (msg.dir === 'prev' || msg.dir === -1) return -1;
  if (msg.dir === 'next' || msg.dir === 1) return 1;
  return 0;
}

// Null when this is previous/next (or neither). An object when any absolute field is
// present. error is set when those fields are not a single desktop choice. A dir together
// with an absolute choice is refused: the Mac must not guess which one was meant.
function absoluteRequest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const keys = ['spaceId', 'index', 'count', 'rev'];
  if (!keys.some((k) => Object.prototype.hasOwnProperty.call(msg, k))) return null;
  if (msg.dir != null && msg.dir !== '') return { error: 'space' };
  const spaceId = typeof msg.spaceId === 'string' ? msg.spaceId : '';
  if (!SPACE_ID.test(spaceId) || spaceId === '0' || !Number.isSafeInteger(msg.index) || !Number.isSafeInteger(msg.count) || !Number.isSafeInteger(msg.rev)) {
    return { error: 'space' };
  }
  if (!Object.prototype.hasOwnProperty.call(msg, 'displayId') || !askedDisplay(msg)) return { error: 'display' };
  return { spaceId, index: msg.index, count: msg.count, rev: msg.rev, displayId: askedDisplay(msg) };
}

function askedDisplay(msg) {
  if (!msg || typeof msg !== 'object' || !Object.prototype.hasOwnProperty.call(msg, 'displayId')) return '';
  if (msg.displayId == null || msg.displayId === '') return '';
  const id = typeof msg.displayId === 'number' ? String(msg.displayId) : String(msg.displayId);
  return /^-?\d+$/.test(id) ? id : '';
}

// The display the open viewer is actually being shown. Null when the picture is off, still
// settling, or the capture has not caught up with a new choice: a desktop move must not land
// on the display that was on screen a moment ago.
function viewedDisplay(state) {
  if (!state || state.viewer === false || state.waitingPolicy === true || state.sharing !== true) return null;
  if (state.choiceMode === 'none') return null;
  const want = state.want;
  if (!want || want.id == null) return null;
  // No picture yet, or the capture is still the previous display: do not move a desktop.
  if (state.activeId == null || state.activeId !== want.id) return null;
  return want;
}

// target is that viewed display. A displayId on the message must name it; a different id is refused.
function resolveTarget(target, msg) {
  if (!target || target.id == null) return { ok: false, why: 'target' };
  const id = String(target.id);
  if (!/^\d+$/.test(id) || id === '0') return { ok: false, why: 'target' };
  const asked = askedDisplay(msg);
  if (Object.prototype.hasOwnProperty.call(msg || {}, 'displayId') && msg.displayId != null && msg.displayId !== '' && !asked) {
    return { ok: false, why: 'display' };
  }
  if (asked && asked !== id) return { ok: false, why: 'display' };
  return { ok: true, displayId: id };
}

// The display a screen.space message was aimed at. generation is kept only when the
// target object has one. An unusable generation fails closed later.
function viewToken(target) {
  const resolved = resolveTarget(target, {});
  if (!resolved.ok) return null;
  const token = { displayId: resolved.displayId };
  if (target && Object.prototype.hasOwnProperty.call(target, 'generation')) {
    const g = target.generation;
    token.generation = (typeof g === 'number' && Number.isSafeInteger(g) && g >= 0) ? g : null;
  }
  if (target && Object.prototype.hasOwnProperty.call(target, 'session')) {
    const s = target.session;
    token.session = (typeof s === 'number' && Number.isSafeInteger(s) && s > 0) ? s : null;
  }
  return token;
}

// True only when the live view is still the one recorded at receipt. A different id
// refuses. When either side has a generation, both must be the same number, so
// A→B→A refuses. Two tokens with no generation compare ids only.
function sameView(captured, live) {
  if (!captured || !live || captured.displayId !== live.displayId) return false;
  const hasSession = Object.prototype.hasOwnProperty.call(captured, 'session');
  const liveSession = Object.prototype.hasOwnProperty.call(live, 'session');
  if (hasSession !== liveSession || (hasSession && (captured.session == null || captured.session !== live.session))) return false;
  const cap = Object.prototype.hasOwnProperty.call(captured, 'generation');
  const now = Object.prototype.hasOwnProperty.call(live, 'generation');
  if (!cap && !now) return true;
  if (!cap || !now) return false;
  if (captured.generation == null || live.generation == null) return false;
  return captured.generation === live.generation;
}

// A catalog read may be published only for the view it started on. No view on both
// sides holds. A view appearing, disappearing, or changing generation does not.
// undefined means the view could not be read, which does not hold.
function fenceView(started, now) {
  if (started === undefined || now === undefined) return false;
  if (started == null && now == null) return true;
  if (started == null || now == null) return false;
  return sameView(started, now);
}

// Bump when the selected display or per-device choice key changes. The same key
// keeps the number, so a later read of an unchanged selection still matches.
function noteGeneration(slot, key) {
  const next = key == null ? '' : String(key);
  if (!slot) return 0;
  if (slot.key === next) return slot.generation || 0;
  slot.key = next;
  slot.generation = (slot.generation || 0) + 1;
  return slot.generation;
}

function cleanLook(look) {
  const displays = [];
  for (const d of look && Array.isArray(look.displays) ? look.displays : []) {
    if (!d || typeof d.uuid !== 'string' || !d.uuid) continue;
    const spaces = [];
    for (const id of Array.isArray(d.spaces) ? d.spaces : []) {
      if (typeof id === 'string' && SPACE_ID.test(id) && id !== '0' && !spaces.includes(id)) spaces.push(id);
    }
    if (!spaces.length) continue;
    const current = typeof d.current === 'string' && spaces.includes(d.current) ? d.current : '';
    let cgId = '';
    if (typeof d.cgId === 'number' && Number.isSafeInteger(d.cgId) && d.cgId > 0) cgId = String(d.cgId);
    else if (typeof d.cgId === 'string' && /^\d+$/.test(d.cgId) && d.cgId !== '0') cgId = d.cgId;
    displays.push({ uuid: d.uuid, cgId, current, spaces });
  }
  return displays;
}

function viewedId(viewed) {
  if (!viewed || viewed.id == null) return '';
  const id = String(viewed.id);
  return /^\d+$/.test(id) && id !== '0' && id.length <= 16 ? id : '';
}

// Bounded desktop list for screen.state. Space ids are the helper's numeric ids, so a later
// choice can be checked against a fresh read. Names are display labels only. Nothing here is
// a thumbnail or a window title. Null when there is no display this viewer may see.
function desktopCatalog(look, viewed, namedDisplays, opts) {
  const offerDisplays = !!(opts && opts.offerDisplays);
  const rows = cleanLook(look);
  const named = namedRows(namedDisplays);
  const byId = new Map(rows.map((r) => [r.cgId, r]));
  const picked = [];
  const seen = new Set();
  const add = (row, name, primary) => {
    if (!row || seen.has(row.cgId) || picked.length >= MAX_DISPLAYS) return;
    seen.add(row.cgId);
    picked.push({ row, name: cleanLabel(name), primary: primary === true });
  };
  const vid = viewedId(viewed);
  const labelOf = (id) => named.find((n) => n.id === id) || {};
  if (offerDisplays) {
    for (const n of named) add(byId.get(n.id), n.name, n.primary);
    // Extend's virtual display is not a mirror choice, but it is the picture on screen.
    // Keep it, dropping the last mirror choice if the list is already full.
    if (vid && !seen.has(vid) && byId.get(vid)) {
      if (picked.length >= MAX_DISPLAYS) {
        const dropped = picked.pop();
        if (dropped) seen.delete(dropped.row.cgId);
      }
      const n = labelOf(vid);
      add(byId.get(vid), n.name, n.primary);
    }
  } else if (vid) {
    const n = labelOf(vid);
    add(byId.get(vid), n.name, n.primary);
  }
  if (!picked.length) return null;
  const displays = picked.map((item) => {
    const spaces = item.row.spaces;
    const listed = spaces.slice(0, MAX_LISTED);
    const current = item.row.current ? spaces.indexOf(item.row.current) : -1;
    return {
      id: item.row.cgId,
      name: item.name,
      primary: item.primary === true,
      current,
      count: spaces.length,
      truncated: spaces.length > listed.length,
      spaces: listed,
    };
  });
  let viewing = '';
  let viewGen = null;
  if (vid && displays.some((d) => d.id === vid)) {
    viewing = vid;
    if (viewed && Object.prototype.hasOwnProperty.call(viewed, 'generation')) {
      const g = viewed.generation;
      if (typeof g === 'number' && Number.isSafeInteger(g) && g >= 0 && g <= 0xffffffff) viewGen = g;
    }
  }
  // The capture session is part of the revision, so a new picture cannot reuse an old catalog.
  // It is not a decoded frame. The phone sends a desktop change only after one of this session.
  let capture = null;
  if (viewed && Number.isSafeInteger(viewed.session) && viewed.session > 0 && viewed.session <= 0xffffffff) capture = viewed.session;
  const rev = fnv(JSON.stringify({
    viewing,
    viewGen,
    capture: capture == null ? 0 : capture,
    displays: displays.map((d) => ({ id: d.id, current: d.current, count: d.count, truncated: d.truncated, spaces: d.spaces })),
  }));
  const out = { rev, viewing, displays };
  if (viewGen != null) out.viewGen = viewGen;
  if (capture != null) out.capture = capture;
  return out;
}

// { ok: true, spaceId, displayId, index, count } or { ok: false, why, edge? }.
// More than one display, a shared desktop id, or spans-displays: refuse. One display can move,
// because there is no other display to take with it.
function planSwitch(look, request) {
  const dir = request && request.dir;
  if (dir !== -1 && dir !== 1) return { ok: false, why: 'dir' };
  const displayId = request && request.displayId != null ? String(request.displayId) : '';
  if (!/^\d+$/.test(displayId) || displayId === '0') return { ok: false, why: 'display' };
  const displays = cleanLook(look);
  if (!displays.length) return { ok: false, why: 'unavailable' };
  const owner = new Map();
  let shared = false;
  for (const d of displays) {
    for (const id of d.spaces) {
      const prev = owner.get(id);
      if (prev && prev !== d.uuid) shared = true;
      else owner.set(id, d.uuid);
    }
  }
  const mine = displays.find((d) => d.cgId === displayId);
  if (!mine || !mine.current) return { ok: false, why: mine ? 'unavailable' : 'display' };
  if (!look || look.composed !== true) return { ok: false, why: 'composed' };
  const others = displays.some((d) => d.uuid !== mine.uuid);
  if (others && (look.spans === true || shared)) return { ok: false, why: 'spans' };
  if (others && displays.some((d) => !d.cgId)) return { ok: false, why: 'unavailable' };
  const index = mine.spaces.indexOf(mine.current);
  const next = index + dir;
  if (next < 0 || next >= mine.spaces.length) return { ok: false, why: 'edge', edge: dir < 0 ? 'first' : 'last' };
  const spaceId = mine.spaces[next];
  if (owner.get(spaceId) !== mine.uuid) return { ok: false, why: 'spans' };
  return { ok: true, spaceId, displayId, index: next, count: mine.spaces.length };
}

// Absolute choice. The desktop must still be at that index in a fresh read, and the catalog
// revision must be the one just built for this view. Already current does not open Mission Control.
function planSelect(look, request) {
  const displayId = request && request.displayId != null ? String(request.displayId) : '';
  if (!/^\d+$/.test(displayId) || displayId === '0') return { ok: false, why: 'display' };
  const spaceId = request && typeof request.spaceId === 'string' ? request.spaceId : '';
  if (!SPACE_ID.test(spaceId) || spaceId === '0') return { ok: false, why: 'space' };
  const index = request && request.index;
  const count = request && request.count;
  const rev = request && request.rev;
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_LISTED) return { ok: false, why: 'space' };
  if (!Number.isSafeInteger(count) || count <= index || count > MAX_COUNT) return { ok: false, why: 'space' };
  if (!Number.isSafeInteger(rev) || rev < 0 || rev > 0xffffffff) return { ok: false, why: 'stale' };
  const displays = cleanLook(look);
  if (!displays.length) return { ok: false, why: 'unavailable' };
  const owner = new Map();
  let shared = false;
  for (const d of displays) {
    for (const id of d.spaces) {
      const prev = owner.get(id);
      if (prev && prev !== d.uuid) shared = true;
      else owner.set(id, d.uuid);
    }
  }
  const mine = displays.find((d) => d.cgId === displayId);
  if (!mine || !mine.current) return { ok: false, why: mine ? 'unavailable' : 'display' };
  if (mine.spaces.length !== count || mine.spaces[index] !== spaceId) return { ok: false, why: 'stale' };
  const cat = desktopCatalog(look, request && request.viewed, request && request.named, { offerDisplays: !!(request && request.offerDisplays) });
  if (!cat || cat.rev !== rev) return { ok: false, why: 'stale' };
  if (!cat.displays.some((d) => d.id === displayId)) return { ok: false, why: 'display' };
  const already = mine.current === spaceId;
  if (!look || look.composed !== true) return already ? { ok: true, already: true, spaceId, displayId, index, count } : { ok: false, why: 'composed' };
  const others = displays.some((d) => d.uuid !== mine.uuid);
  if (others && (look.spans === true || shared || owner.get(spaceId) !== mine.uuid)) {
    return already ? { ok: true, already: true, spaceId, displayId, index, count } : { ok: false, why: 'spans' };
  }
  if (others && displays.some((d) => !d.cgId)) return { ok: false, why: 'unavailable' };
  if (already) return { ok: true, already: true, spaceId, displayId, index, count };
  return { ok: true, spaceId, displayId, index, count };
}

// The phone may show Previous and Next only when this viewed display has its own other
// desktop and the composition read is clean. An edge still shows both: the Mac answers
// which end it is. A missing picture, a shared desktop, or windows from another desktop
// show nothing.
function offerSpaces(look, viewed) {
  // Missing ax is not trust. Held input means a press would be refused and touches
  // are already paused, so the buttons stay off.
  if (!look || look.ax !== true || look.inputHeld === true) return false;
  if (!viewed || viewed.id == null) return false;
  const id = String(viewed.id);
  if (!/^\d+$/.test(id) || id === '0') return false;
  const next = planSwitch(look, { displayId: id, dir: 1 });
  const prev = planSwitch(look, { displayId: id, dir: -1 });
  return next.ok === true || prev.ok === true;
}

// One-to-one stream input. Null: this message is not the authenticated current session.
// The returned function is false once that session is gone or replaced (a stale socket).
function streamInputGate(ctx, readCurrent) {
  const live = (c) => !!(c && c.authed === true && !c.released && c.ws && c.ws.readyState === 1);
  if (!live(ctx) || ctx.deviceId == null) return null;
  const current = readCurrent();
  if (!live(current) || current.ws !== ctx.ws || current.deviceId !== ctx.deviceId) return null;
  const ws = ctx.ws;
  const deviceId = ctx.deviceId;
  return () => {
    const now = readCurrent();
    return !!(live(ctx) && live(now) && now.ws === ws && now.deviceId === deviceId);
  };
}

// Mesh session. The live connection is the guest link when that is up, otherwise the host
// socket. A replacement socket or a link that is no longer authenticated fails the later check.
function meshGate(readSession) {
  const live = (ctx) => !!(ctx && ctx.authed === true && !ctx.released && ctx.ws && ctx.ws.readyState === 1);
  const session = readSession();
  if (!session || session.connected !== true) return null;
  let token = null;
  if (session.linkUp === true) {
    if (!live(session.link)) return null;
    token = { kind: 'link', link: session.link, ws: session.link.ws };
  } else if (session.hostUp === true) {
    if (!live(session.ctx)) return null;
    token = { kind: 'ctx', ctx: session.ctx, ws: session.ctx.ws };
  }
  if (!token) return null;
  return () => {
    const now = readSession();
    if (!now || now.connected !== true) return false;
    if (token.kind === 'link') return now.link === token.link && now.linkUp === true && live(now.link) && now.link.ws === token.ws;
    return now.hostUp === true && now.linkUp !== true && now.ctx === token.ctx && live(now.ctx) && now.ctx.ws === token.ws;
  };
}

// '' when remote input is not paused. Otherwise the reason a touch must not be sent.
function spaceHold(look) {
  if (!look || look.inputHeld !== true) return '';
  return look.holdWhy === 'overview' ? 'overview' : 'accessibility';
}

module.exports = {
  dirOf, absoluteRequest, viewedDisplay, resolveTarget, viewToken, sameView, fenceView, noteGeneration,
  planSwitch, planSelect, desktopCatalog, catalogOffer, offerSpaces, spaceHold, streamInputGate, meshGate,
  MAX_DISPLAYS, MAX_LISTED, MAX_COUNT,
};
