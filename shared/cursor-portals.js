// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Geometry and validation for explicit, directional cursor portals.
(function (root) {
'use strict';

const SIDES = new Set(['left', 'right', 'top', 'bottom']);
const MODIFIERS = new Set(['Command', 'Control', 'Alt', 'Shift']);
// DOM physical-key codes avoid tying a portal to one keyboard layout. Modifier-only chords use ''.
const KEY = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|20)|Space|Tab|Escape|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Arrow(?:Up|Down|Left|Right))$/;

function endpoint(value) {
  if (!value || typeof value !== 'object' || typeof value.display !== 'string' || !value.display || value.display.length > 200 ||
      !SIDES.has(value.side) || !Number.isFinite(value.from) || !Number.isFinite(value.to) ||
      value.from < 0 || value.to > 1 || value.from >= value.to) return null;
  return { display: value.display, side: value.side, from: value.from, to: value.to };
}

function normalize(value) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const seen = new Set();
  const rules = [];
  for (const rule of value) {
    if (!rule || typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rule.id) || seen.has(rule.id)) return null;
    const source = endpoint(rule.source), target = endpoint(rule.target);
    const key = rule.key === undefined ? '' : rule.key;
    if (!source || !target || typeof key !== 'string' || (key && !KEY.test(key)) ||
        !Array.isArray(rule.modifiers) || rule.modifiers.some((m) => !MODIFIERS.has(m)) ||
        new Set(rule.modifiers).size !== rule.modifiers.length) return null;
    seen.add(rule.id);
    rules.push({ id: rule.id, source, target, modifiers: [...rule.modifiers].sort(), key });
  }
  // Ambiguous rules are refused rather than silently changing where the cursor goes.
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (a.source.display === b.source.display && a.source.side === b.source.side &&
        Math.max(a.source.from, b.source.from) < Math.min(a.source.to, b.source.to)) return null;
  }
  return rules;
}

// Offset is relative to the source display, not the whole virtual desktop. Clamp rounding error.
function mapOffset(rule, offset) {
  if (!Number.isFinite(offset)) return null;
  const t = Math.max(0, Math.min(1, (offset - rule.source.from) / (rule.source.to - rule.source.from)));
  return rule.target.from + t * (rule.target.to - rule.target.from);
}

// Pure routing decision. The native input hook must supply a display-local position and the
// currently held physical keys; no match means the caller keeps its ordinary local behavior.
function route(rules, location, held) {
  if (!Array.isArray(rules) || !location || !held || typeof location.display !== 'string' ||
      !SIDES.has(location.side) || !Number.isFinite(location.offset) || !Array.isArray(held.modifiers) ||
      !Array.isArray(held.keys)) return null;
  const rule = rules.find((r) => r.source.display === location.display && r.source.side === location.side &&
    location.offset >= r.source.from && (location.offset < r.source.to || (r.source.to === 1 && location.offset === 1)) &&
    r.modifiers.every((m) => held.modifiers.includes(m)) && (!r.key || held.keys.includes(r.key)));
  if (!rule) return null;
  return { id: rule.id, display: rule.target.display, side: rule.target.side, offset: mapOffset(rule, location.offset) };
}

// Convert a display-local edge offset to the bounding-box offset used by existing helpers.
function desktopOffset(displays, endpointValue, offset) {
  if (!Array.isArray(displays) || !Number.isFinite(offset)) return null;
  const display = displays.find((d) => d.id === endpointValue.display);
  if (!display || !displays.length) return null;
  const vertical = endpointValue.side === 'left' || endpointValue.side === 'right';
  const start = vertical ? 'y' : 'x', length = vertical ? 'h' : 'w';
  if (displays.some((d) => !Number.isFinite(d[start]) || !Number.isFinite(d[length]) || d[length] <= 0)) return null;
  const lo = Math.min(...displays.map((d) => d[start]));
  const hi = Math.max(...displays.map((d) => d[start] + d[length]));
  return (display[start] + Math.max(0, Math.min(1, offset)) * display[length] - lo) / (hi - lo);
}

// Exact destination inside the selected display. Unlike a desktop-wide edge offset, this does not
// accidentally pick another monitor when their positions overlap along an axis.
function entryPoint(displays, target, offset) {
  if (!Array.isArray(displays) || !target || !SIDES.has(target.side) || !Number.isFinite(offset)) return null;
  const d = displays.find((item) => item.id === target.display);
  if (!d || ![d.x, d.y, d.w, d.h].every(Number.isFinite) || d.w < 4 || d.h < 4) return null;
  const t = Math.max(0, Math.min(1, offset));
  const x = Math.max(d.x + 2, Math.min(d.x + d.w - 2, d.x + t * d.w));
  const y = Math.max(d.y + 2, Math.min(d.y + d.h - 2, d.y + t * d.h));
  if (target.side === 'top') return { x, y: d.y + 2 };
  if (target.side === 'bottom') return { x, y: d.y + d.h - 2 };
  if (target.side === 'left') return { x: d.x + 2, y };
  return { x: d.x + d.w - 2, y };
}

// Whether an interval has no adjacent local display. Occupied source intervals require a held
// shortcut; destination intervals can also be occupied while their return route is armed.
function exposed(displays, e) {
  if (!Array.isArray(displays) || !endpoint(e)) return false;
  const d = displays.find((item) => item.id === e.display);
  if (!d || ![d.x, d.y, d.w, d.h].every(Number.isFinite) || d.w < 4 || d.h < 4) return false;
  const vertical = e.side === 'left' || e.side === 'right';
  const start = vertical ? d.y : d.x, len = vertical ? d.h : d.w;
  const lo = start + e.from * len, hi = start + e.to * len;
  return !displays.some((other) => {
    if (other === d || ![other.x, other.y, other.w, other.h].every(Number.isFinite)) return false;
    const sameEdge = e.side === 'left' ? Math.abs(other.x + other.w - d.x) < 1
      : e.side === 'right' ? Math.abs(other.x - (d.x + d.w)) < 1
        : e.side === 'top' ? Math.abs(other.y + other.h - d.y) < 1
          : Math.abs(other.y - (d.y + d.h)) < 1;
    const a = vertical ? other.y : other.x, b = a + (vertical ? other.h : other.w);
    return sameEdge && Math.max(lo, a) < Math.min(hi, b);
  });
}

// An occupied source edge is safe to intercept only with an explicit held shortcut; otherwise
// normal local movement between the two displays must remain possible.
function usableSource(displays, rule) {
  if (!rule || !endpoint(rule.source) || !entryPoint(displays, rule.source, rule.source.from)) return false;
  return exposed(displays, rule.source) || (Array.isArray(rule.modifiers) && rule.modifiers.length > 0) || !!rule.key;
}

function usableTarget(displays, target) {
  return !!endpoint(target) && !!entryPoint(displays, target, target.from);
}

const api = { normalize, endpoint, mapOffset, desktopOffset, route, entryPoint, exposed, usableSource, usableTarget };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CursorPortals = api;
})(typeof self !== 'undefined' ? self : this);
