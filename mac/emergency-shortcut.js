'use strict';

const DEFAULT = 'Control+Alt+Command+Escape';
const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Command']);
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Escape|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right)$/;

// Keep a recovery key even when stored settings are missing or invalid.
function valid(value) {
  if (typeof value !== 'string' || value.length > 60) return DEFAULT;
  const parts = value.split('+'), key = parts.pop();
  if (!KEY.test(key) || !parts.every((part) => MODIFIERS.has(part)) || new Set(parts).size !== parts.length) return DEFAULT;
  const bare = parts.length === 0 && /^F(?:1[3-9]|20)$/.test(key);
  if (!bare && !parts.some((part) => part !== 'Shift')) return DEFAULT;
  return value;
}

module.exports = { DEFAULT, valid };
