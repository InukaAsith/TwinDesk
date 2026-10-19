// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The cursor edges of this PC (settings.kvm.edges): each side of the screen leads to one paired
// device, or to none. Pure functions, used by windows/kvm.js and windows/settings.js.
// docs/mesh.md, "Cursor and keyboard".
'use strict';

const P = require('./protocol.js');

const SIDES = P.SIDES; // left, right, top, bottom
const MAX_ID = 64;

function emptyEdges() {
  return { left: null, right: null, top: null, bottom: null };
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID ? id : null;
}

// Any value -> {left, right, top, bottom}, each a device id or null. Bad ids and unknown keys are
// dropped; a device on two sides keeps only its first side (in SIDES order).
function normalizeEdges(value) {
  const out = emptyEdges();
  const seen = new Set();
  for (const side of SIDES) {
    const id = value && typeof value === 'object' ? validId(value[side]) : null;
    if (id && !seen.has(id)) {
      out[side] = id;
      seen.add(id);
    }
  }
  return out;
}

function isEmpty(edges) {
  return SIDES.every((side) => !edges[side]);
}

// The side that leads to this device, or null.
function edgeForPeer(edges, id) {
  if (!id || !edges) return null;
  for (const side of SIDES) if (edges[side] === id) return side;
  return null;
}

// The user's choice: put `id` on `side` (id null: clear that side). A device on another side moves
// here. Returns a new object, or null when the side already leads to another device (refused).
function assignEdge(edges, side, id) {
  if (!SIDES.includes(side)) return null;
  const clearing = id === null || id === undefined;
  const device = clearing ? null : validId(id);
  if (!clearing && !device) return null;
  const next = normalizeEdges(edges);
  if (clearing) {
    next[side] = null;
    return next;
  }
  if (next[side] && next[side] !== device) return null;
  for (const s of SIDES) if (next[s] === device) next[s] = null;
  next[side] = device;
  return next;
}

// kvm.layout {pcSide} from a device: pcSide is the SENDER's crossing side (where it faces us), so our
// edge for it is the opposite side. Refuses (null) when another device already holds that edge.
function setRemoteEdge(edges, pcSide, id) {
  if (!SIDES.includes(pcSide)) return null;
  return assignEdge(edges, P.opposite(pcSide), id);
}

// The device is gone from every side (Forget).
function clearPeer(edges, id) {
  const next = normalizeEdges(edges);
  for (const side of SIDES) if (next[side] === id) next[side] = null;
  return next;
}

// Settings from before the edges: one paired device and a legacy kvm.pcSide. pcSide is where this PC
// is seen from the other computer, so the device is on the opposite side of this screen. Anything
// else (edges already set, another number of devices, no pcSide) stays as it is.
function migrateEdges(kvm, deviceIds) {
  const current = normalizeEdges(kvm && kvm.edges);
  if (!isEmpty(current)) return current;
  const ids = Array.isArray(deviceIds) ? [...new Set(deviceIds.map(validId).filter(Boolean))] : [];
  const legacy = kvm ? kvm.pcSide : null;
  if (ids.length !== 1 || !SIDES.includes(legacy)) return current;
  return assignEdge(current, P.opposite(legacy), ids[0]) || current;
}

module.exports = { SIDES, normalizeEdges, assignEdge, edgeForPeer, setRemoteEdge, clearPeer, migrateEdges };
