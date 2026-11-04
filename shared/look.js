// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The window's look (General › Appearance), in the main process of each app: the theme (System,
// Light, Dark) and the accent colour. settings.ui.theme and settings.ui.accent; an empty accent
// follows the system's accent colour (macOS and Windows; Linux has none to read: blue).
// A local preference, never synchronized to another device.
'use strict';

const THEMES = ['system', 'light', 'dark'];
// The swatches offered beside "System"; any #rrggbb is accepted.
const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#30d158', '#00c7be', '#8e8e93'];
const FALLBACK = '#0a84ff';
const HEX = /^#[0-9a-f]{6}$/;

const theme = (v) => (THEMES.includes(v) ? v : 'system');
const accent = (v) => (typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : '');

// systemPreferences.getAccentColor(): "rrggbbaa" on macOS and Windows; missing or throwing elsewhere.
function osAccent(systemPreferences) {
  try {
    const c = systemPreferences && typeof systemPreferences.getAccentColor === 'function' ? systemPreferences.getAccentColor() : '';
    if (typeof c === 'string' && /^[0-9a-f]{6}/i.test(c)) return '#' + c.slice(0, 6).toLowerCase();
  } catch {}
  return '';
}

// What the window gets in its state: the choice, and the colour to use now.
function view(ui, systemPreferences) {
  const os = osAccent(systemPreferences);
  const a = accent(ui && ui.accent);
  return { theme: theme(ui && ui.theme), accent: a, os: os || FALLBACK, color: a || os || FALLBACK, accents: ACCENTS };
}

// nativeTheme.themeSource for a theme choice. On Linux, "system" is left to linux/theme.js.
function applyTheme(nativeTheme, t) {
  const want = theme(t);
  if (nativeTheme && nativeTheme.themeSource !== want) nativeTheme.themeSource = want;
}

module.exports = { THEMES, ACCENTS, FALLBACK, theme, accent, osAccent, view, applyTheme };
