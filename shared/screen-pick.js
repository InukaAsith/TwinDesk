// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Which real Mac display a viewer may mirror (screen.state / screen.ctl).
// Extend stays the virtual display. A message with no displayId keeps today's Mirror/Extend path.
// An id this computer is not offering is refused and must change nothing.
'use strict';

const MAX = 8;

function cleanName(s) {
  const name = String(s || 'Display').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || 'Display';
}

function dim(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n <= 16384 ? n : 0;
}

function idOf(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return String(n);
  }
  return '';
}

// Real displays only, in the order the computer listed them. The virtual display is Extend, not a choice here.
function shareable(list) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || d.virtual) continue;
    const id = idOf(d.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanName(d.label || d.name), primary: !!d.primary, w: dim(d.pixelWidth != null ? d.pixelWidth : d.w), h: dim(d.pixelHeight != null ? d.pixelHeight : d.h) });
    if (out.length >= MAX) break;
  }
  return out;
}

// Fields added to screen.state. displayId is omitted while the virtual display is what is shared.
// offer false: say nothing about screens (Multi-device, or apps are holding the virtual display).
function stateFields(list, target, offer) {
  if (offer === false) return {};
  const displays = shareable(list);
  const fields = {};
  if (displays.length) fields.displays = displays;
  const id = target && !target.virtual ? idOf(target.id) : '';
  if (id && displays.some((d) => d.id === id)) fields.displayId = id;
  return fields;
}

// { ok, skip } — the caller keeps Mirror/Extend. { ok, displayId } — mirror that display.
// { ok: false, error: 'display' } — refuse the message.
function pickDisplay(msg, list) {
  if (!msg || typeof msg !== 'object' || msg.mode === 'extend') return { ok: true, skip: true };
  if (!Object.prototype.hasOwnProperty.call(msg, 'displayId') || msg.displayId == null || msg.displayId === '') return { ok: true, skip: true };
  const id = idOf(msg.displayId);
  if (!id || !shareable(list).some((d) => d.id === id)) return { ok: false, error: 'display' };
  return { ok: true, displayId: Number(id) };
}

// What a viewer may change. The result never names a per-device choice: the owner’s off or
// display selection stays. mesh: one capture and one input target, so a pick cannot be kept
// to one recipient. held: this Mac’s apps are on the virtual display, so a pick must not be
// stored and applied when they close. share false is Stop or Close, not a new screen.
function viewerPick(msg, list, ctx) {
  if (msg && msg.share === false) return { ok: true, skip: true };
  const pick = pickDisplay(msg, list);
  if (pick.skip || !pick.ok) return pick;
  const c = ctx || {};
  if (c.mesh) return { ok: false, error: 'mesh' };
  if (c.held) return { ok: false, error: 'held' };
  return { ok: true, displayId: pick.displayId };
}

module.exports = { shareable, stateFields, pickDisplay, viewerPick };
