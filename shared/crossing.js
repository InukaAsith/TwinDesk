'use strict';
// Hold a key to cross between computers (#230) and the emergency return shortcut (#178), for every
// platform. Crossing bits on the wire (k.mod flags, kvm.take crossingFlags): 1 Command (the Windows or
// Super key), 2 Control, 4 Alt (Option), 8 Shift.

const MODIFIERS = ['', 'Command', 'Control', 'Alt', 'Shift'];
const DEFAULT_EMERGENCY = 'Control+Alt+Command+Escape';
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Escape|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right)$/;
const NAMES = new Set(['Control', 'Alt', 'Shift', 'Command']);

// The key that must be held to leave at an edge ('' crosses as before).
function modifier(v) { return MODIFIERS.includes(v) ? v : ''; }

// The emergency shortcut, always a usable one: anything invalid is the default.
function emergency(value) {
  if (typeof value !== 'string' || value.length > 60) return DEFAULT_EMERGENCY;
  const parts = value.split('+'), key = parts.pop();
  if (!KEY.test(key) || !parts.every((p) => NAMES.has(p)) || new Set(parts).size !== parts.length) return DEFAULT_EMERGENCY;
  const bare = parts.length === 0 && /^F(?:1[3-9]|20)$/.test(key);
  if (!bare && !parts.some((p) => p !== 'Shift')) return DEFAULT_EMERGENCY;
  return value;
}

function validBits(v) { return Number.isInteger(v) && v >= 0 && v <= 15; }
function bits(v) { return validBits(v) ? v : 0; }

module.exports = { MODIFIERS, DEFAULT_EMERGENCY, modifier, emergency, valid: emergency, bits, validBits };
