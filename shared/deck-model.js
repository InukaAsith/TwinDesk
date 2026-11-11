// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's layout (a Stream Deck on the phone, the computer runs the buttons): pure data, the same
// on the computer (which keeps it, settings.deck) and in tests. Every layout from a file, the
// window or a phone goes through normalize(), so nothing out of shape is kept or run.
//   layout: { v: 1, cols, rows, pages: [{ id, name, buttons: [{ id, slot, label, icon, color, action }] }] }
//   slot: the button's place on its page, row by row (0 … cols*rows-1); one button per slot.
//   action, by kind:
//     keys   {combo: 'Meta+Shift+KeyS'}: KeyboardEvent.code names; 'Mod' is ⌘ on a Mac, Ctrl elsewhere
//     text   {text}: typed as it is (a snippet)
//     media  {what: playpause|next|prev|volup|voldown|mute}
//     bright {what: up|down}: the display's brightness
//     url    {url}: http(s) opened in the default browser
//     app    {id, name}: one of this computer's apps (DeckApps lists them)
//     sys    {what: lock|sleep}: shared/devlocal.js
//     clip   {what: copy|cut|paste|send}: send = this computer's clipboard to the phone's
//     page   {to: page id}: the phone goes to another page (not sent to the computer)
//     none   {}: an empty button (a label only)
// CommonJS in main and tests, a plain <script> in renderers (window.DeckModel).
'use strict';

(function (root) {
  const KINDS = ['keys', 'text', 'media', 'bright', 'url', 'app', 'sys', 'clip', 'page', 'none'];
  const MEDIA = { playpause: 'MediaPlayPause', next: 'MediaTrackNext', prev: 'MediaTrackPrevious', volup: 'AudioVolumeUp', voldown: 'AudioVolumeDown', mute: 'AudioVolumeMute' };
  const SYS = ['lock', 'sleep'];
  const CLIP = ['copy', 'cut', 'paste', 'send'];
  const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  const MOD_CODE = { Ctrl: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft', Meta: 'MetaLeft' };
  const CODE = /^[A-Za-z0-9]{1,32}$/;
  const MAX_PAGES = 20;
  const COLS = [2, 8], ROWS = [2, 8];
  const COLORS = ['#3a3a3c', '#0a84ff', '#30b94d', '#ff9f0a', '#ff3b30', '#bf5af2', '#64d2ff', '#ff2d55', '#ffd60a', '#8e8e93'];

  const str = (v, max) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\t' ? c : '')).slice(0, max) : '');
  const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const idOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : '');
  let seq = 0;
  const newId = (p = 'b') => `${p}${Date.now().toString(36)}${(seq++ % 1296).toString(36)}`;

  // A shortcut, as typed or recorded: modifiers first (in a fixed order), then one key.
  function combo(v) {
    const parts = String(v || '').split('+').map((x) => x.trim()).filter(Boolean);
    if (parts.some((p) => !MODS.includes(p) && !CODE.test(p))) return '';
    const mods = MODS.filter((m) => parts.includes(m));
    const keys = parts.filter((p) => !MODS.includes(p) && CODE.test(p));
    if (keys.length !== 1 && !(keys.length === 0 && mods.length)) return '';
    return [...mods, ...keys].join('+');
  }
  // The key codes to press, in order (released in reverse). mac: 'Mod' is ⌘.
  function codesOf(c, mac) {
    return combo(c).split('+').filter(Boolean).map((p) => (p === 'Mod' ? (mac ? 'MetaLeft' : 'ControlLeft') : MOD_CODE[p] || p));
  }

  function url(v) {
    const s = str(v, 2000).trim();
    if (!s) return '';
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch (_) { return ''; }
  }

  function action(a) {
    const k = a && KINDS.includes(a.k) ? a.k : 'none';
    switch (k) {
      // Keys, text, a website and an app may be empty while being set up: they do nothing then.
      case 'keys': return { k, combo: combo(a.combo) };
      case 'text': return { k, text: str(a.text, 4000) };
      case 'media': return a.what in MEDIA ? { k, what: a.what } : { k: 'none' };
      case 'bright': return a.what === 'up' || a.what === 'down' ? { k, what: a.what } : { k: 'none' };
      case 'url': return { k, url: url(a.url) };
      case 'app': return { k, id: str(a.id, 500), name: str(a.name, 80) };
      case 'sys': return SYS.includes(a.what) ? { k, what: a.what } : { k: 'none' };
      case 'clip': return CLIP.includes(a.what) ? { k, what: a.what } : { k: 'none' };
      case 'page': { const to = idOf(a.to); return to ? { k, to } : { k: 'none' }; }
      default: return { k: 'none' };
    }
  }

  function button(b, slots, taken) {
    if (!b || typeof b !== 'object') return null;
    const slot = Number(b.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots || taken.has(slot)) return null; // off the grid (a smaller one): gone
    taken.add(slot);
    return {
      id: idOf(b.id) || newId(),
      slot,
      label: str(b.label, 40).replace(/[\n\t]/g, ' '),
      icon: str(b.icon, 16).replace(/[\n\t]/g, ''), // an emoji or a short glyph
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color.toLowerCase() : COLORS[0],
      action: action(b.action),
    };
  }

  function normalize(l) {
    const src = l && typeof l === 'object' ? l : {};
    const cols = int(src.cols, COLS[0], COLS[1], 4);
    const rows = int(src.rows, ROWS[0], ROWS[1], 3);
    const ids = new Set();
    const pages = (Array.isArray(src.pages) ? src.pages : []).slice(0, MAX_PAGES).map((p, i) => {
      if (!p || typeof p !== 'object') return null;
      let id = idOf(p.id) || newId('p');
      while (ids.has(id)) id = newId('p');
      ids.add(id);
      const taken = new Set();
      const buttons = (Array.isArray(p.buttons) ? p.buttons : []).map((b) => button(b, cols * rows, taken)).filter(Boolean);
      return { id, name: str(p.name, 30).replace(/[\n\t]/g, ' ') || `Page ${i + 1}`, buttons };
    }).filter(Boolean);
    // A page action to a page that's gone does nothing.
    for (const p of pages) for (const b of p.buttons) if (b.action.k === 'page' && !ids.has(b.action.to)) b.action = { k: 'none' };
    return { v: 1, cols, rows, pages: pages.length ? pages : starter().pages };
  }

  // The first layout: media, the keyboard's top row and a few everyday shortcuts.
  function starter() {
    const b = (slot, label, icon, color, a) => ({ id: `s${slot}`, slot, label, icon, color, action: a });
    return {
      v: 1, cols: 4, rows: 3,
      pages: [
        { id: 'main', name: 'Main', buttons: [
          b(0, 'Previous', '⏮', '#3a3a3c', { k: 'media', what: 'prev' }),
          b(1, 'Play/Pause', '⏯', '#0a84ff', { k: 'media', what: 'playpause' }),
          b(2, 'Next', '⏭', '#3a3a3c', { k: 'media', what: 'next' }),
          b(3, 'Mute', '🔇', '#3a3a3c', { k: 'media', what: 'mute' }),
          b(4, 'Volume down', '🔉', '#3a3a3c', { k: 'media', what: 'voldown' }),
          b(5, 'Volume up', '🔊', '#3a3a3c', { k: 'media', what: 'volup' }),
          b(6, 'Dimmer', '🔅', '#ff9f0a', { k: 'bright', what: 'down' }),
          b(7, 'Brighter', '🔆', '#ff9f0a', { k: 'bright', what: 'up' }),
          b(8, 'Copy', '📋', '#30b94d', { k: 'clip', what: 'copy' }),
          b(9, 'Paste', '📥', '#30b94d', { k: 'clip', what: 'paste' }),
          b(10, 'Lock', '🔒', '#ff3b30', { k: 'sys', what: 'lock' }),
          b(11, 'Keys', '⌨', '#bf5af2', { k: 'page', to: 'keys' }),
        ] },
        { id: 'keys', name: 'Keys', buttons: [
          b(0, 'Esc', '⎋', '#3a3a3c', { k: 'keys', combo: 'Escape' }),
          b(1, 'Tab', '⇥', '#3a3a3c', { k: 'keys', combo: 'Tab' }),
          b(2, 'Undo', '↶', '#3a3a3c', { k: 'keys', combo: 'Mod+KeyZ' }),
          b(3, 'Redo', '↷', '#3a3a3c', { k: 'keys', combo: 'Mod+Shift+KeyZ' }),
          b(4, 'Left', '←', '#3a3a3c', { k: 'keys', combo: 'ArrowLeft' }),
          b(5, 'Up', '↑', '#3a3a3c', { k: 'keys', combo: 'ArrowUp' }),
          b(6, 'Down', '↓', '#3a3a3c', { k: 'keys', combo: 'ArrowDown' }),
          b(7, 'Right', '→', '#3a3a3c', { k: 'keys', combo: 'ArrowRight' }),
          b(8, 'Save', '💾', '#0a84ff', { k: 'keys', combo: 'Mod+KeyS' }),
          b(9, 'Find', '🔍', '#0a84ff', { k: 'keys', combo: 'Mod+KeyF' }),
          b(10, 'New tab', '➕', '#0a84ff', { k: 'keys', combo: 'Mod+KeyT' }),
          b(11, 'Main', '◀', '#bf5af2', { k: 'page', to: 'main' }),
        ] },
      ],
    };
  }

  const find = (l, pageId, id) => {
    const p = (l.pages || []).find((x) => x.id === pageId);
    return (p && p.buttons.find((b) => b.id === id)) || null;
  };

  // Move a button to another slot (or page): one already there swaps places with it.
  function move(l, fromPage, id, toPage, slot) {
    const out = normalize(l);
    const a = out.pages.find((p) => p.id === fromPage);
    const b = out.pages.find((p) => p.id === toPage);
    if (!a || !b || slot < 0 || slot >= out.cols * out.rows) return out;
    const btn = a.buttons.find((x) => x.id === id);
    if (!btn) return out;
    const there = b.buttons.find((x) => x.slot === slot && x !== btn);
    if (there) {
      if (a === b) there.slot = btn.slot;
      else { b.buttons = b.buttons.filter((x) => x !== there); there.slot = btn.slot; a.buttons.push(there); }
    }
    if (a !== b) { a.buttons = a.buttons.filter((x) => x !== btn); b.buttons.push(btn); }
    btn.slot = slot;
    return out;
  }

  const api = { KINDS, MEDIA, SYS, CLIP, MODS, COLORS, normalize, starter, action, combo, codesOf, url, find, move, newId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
