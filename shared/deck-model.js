// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's layout: pure data, the same on the computer (which keeps it, settings.deck), on its
// Deck page and in tests. Every layout from a file, the window or a device goes through
// normalize(), so nothing out of shape is kept or run.
//
//   layout  { v: 2, swipe: {pages, spaces}, orient, spaces: [space] }
//             orient: 'landscape' (the default, held sideways like the gamepad) or 'portrait': how
//             the phone holds its full-screen Deck.
//             swipe.pages: a swipe across the grid turns the page; swipe.spaces: a three-finger
//             swipe changes the space. Off, the device's own bar (and Navigate tiles) do it.
//   space   { id, name, kind: 'tiles', pages: [page] }
//           { id, name, kind: 'windows', layouts: [{id, name, zones: [rect]}],
//             sets: [{id, name, display, items: [{key, name, zone}]}] }: the window space; a set is
//             apps saved together with their places (key: the app as deck.wins groups it), arranged
//             in one go from the device's shelf, the ones not running opened first
//             (Mac and Windows): a running app's window into a zone of a display, or to another display.
//             rect: {x, y, w, h} on a 12 × 12 grid over the display's usable area.
//   page    { id, name, cols 2–8, rows 2–8, tiles: [tile] }
//   tile    { id, x, y, w 1–4, h 1–4, label, icon, color, action }: x, y its top-left cell; tiles
//             don't overlap (a later one that would is dropped) and stay on their page's grid.
//             icon: '' (the action's own symbol), a symbol name from SYMBOLS, or an emoji.
//   action  {k, …}, by kind (ACTIONS below has each one's wording and options):
//     keys   {combo: 'Meta+Shift+KeyS'}: KeyboardEvent.code names; 'Mod' is ⌘ on a Mac, Ctrl elsewhere
//     text   {text, enter}: typed as it is (a snippet), Return after it when enter
//     macro  {steps: [{action, wait}]}: one action after another, wait ms before each
//     media  {what: playpause|next|prev|stop}
//     volume {what: up|down|set|mute|unmute|toggle, level 0–100, step 1–25}
//     mic    {what: mute|unmute|toggle}: the default input
//     output {id, name}: this audio output becomes the default; id '' = the next one in turn
//     input  {id, name}: this microphone becomes the default
//     bt     {what: on|off|toggle|connect|disconnect|toggleconn, id, name}: the radio, or a paired device
//     bright {what: up|down|set, level 0–100, display: '' (all) or a display's id}
//     slider {what: volume|mic|bright, display}: a level to drag (the tile is the slider)
//     app    {id, name}: one of this computer's apps (DeckApps lists them)
//     url    {url}: http(s) opened in the default browser
//     open   {path}: a file or folder on this computer
//     script {path}: a script file saved on this computer, opened the way a double-click opens it
//            (TwinDesk never builds or runs a command line itself)
//     sys    {what: lock|sleep|screenoff|desktop|switcher|overview|screenshot|shotarea|darkmode|dnd}
//     win    {what: left|right|top|bottom|max|center|min|full|tl|tr|bl|br|third1|third2|third3|nextdisplay|close}:
//            the window in front
//     clip   {what: copy|cut|paste|send}: send = this computer's clipboard to the device's
//     nav    {what: page|space|next|prev|nextspace|prevspace, to}: on the device, not sent to the computer
//     widget {what: clock|media|cpu|ram|temp}: shows, isn't run. The clock is the device's; media is
//            what plays on this computer (its buttons play, pause and skip); cpu, ram and temp are
//            this computer's use and heat (deck.state perf), live while the Deck shows
//     none   {}: a label only
// Paths (files, folders, scripts) stay on this computer: forDevice() leaves them out of what a device gets, and
// fromDevice() keeps this computer's own (a device can't set or change them).
// CommonJS in main and tests, a plain <script> in renderers (window.DeckModel).
'use strict';

(function (root) {
  const KINDS = ['keys', 'text', 'macro', 'media', 'volume', 'mic', 'output', 'input', 'bt', 'bright', 'slider', 'app', 'url', 'open', 'script', 'sys', 'win', 'clip', 'nav', 'widget', 'none'];
  const LOCAL = ['open', 'script']; // only set on this computer, never sent to a device
  const DEVICE = ['nav', 'widget', 'none']; // the device does these itself
  const MEDIA = { playpause: 'MediaPlayPause', next: 'MediaTrackNext', prev: 'MediaTrackPrevious', stop: 'MediaStop' };
  const WHATS = {
    media: Object.keys(MEDIA),
    volume: ['up', 'down', 'set', 'mute', 'unmute', 'toggle'],
    mic: ['mute', 'unmute', 'toggle'],
    bt: ['on', 'off', 'toggle', 'connect', 'disconnect', 'toggleconn'],
    bright: ['up', 'down', 'set'],
    slider: ['volume', 'mic', 'bright'],
    sys: ['lock', 'sleep', 'screenoff', 'desktop', 'switcher', 'overview', 'screenshot', 'shotarea', 'darkmode', 'dnd'],
    win: ['left', 'right', 'top', 'bottom', 'max', 'center', 'min', 'full', 'tl', 'tr', 'bl', 'br', 'third1', 'third2', 'third3', 'nextdisplay', 'close'],
    clip: ['copy', 'cut', 'paste', 'send'],
    nav: ['page', 'space', 'next', 'prev', 'nextspace', 'prevspace'],
    widget: ['clock', 'media', 'cpu', 'ram', 'temp'],
  };
  const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  const MOD_CODE = { Ctrl: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft', Meta: 'MetaLeft' };
  const CODE = /^[A-Za-z0-9]{1,32}$/;
  const MAX_SPACES = 12, MAX_PAGES = 20, MAX_STEPS = 20, MAX_LAYOUTS = 16, MAX_ZONES = 12, MAX_SETS = 24, MAX_SET_APPS = 6;
  const GRID = [2, 8], SPAN = 4, ZONE_GRID = 12;
  const COLORS = ['#2c2c2e', '#0a84ff', '#30b94d', '#ff9f0a', '#ff3b30', '#bf5af2', '#5e5ce6', '#64d2ff', '#ff2d55', '#ffd60a', '#a2845e', '#8e8e93'];
  // The symbols every surface draws with its own icons; anything else in icon is shown as it is (an emoji).
  const SYMBOLS = [
    'play', 'pause', 'next', 'prev', 'stop', 'volume', 'volumeDown', 'mute', 'mic', 'micOff', 'speaker', 'headphones',
    'bluetooth', 'sun', 'sunDim', 'moon', 'clock', 'cpu', 'memory', 'thermo', 'lock', 'sleep', 'power', 'desktop', 'windows', 'switcher', 'camera', 'crop',
    'keyboard', 'command', 'text', 'macro', 'globe', 'app', 'folder', 'terminal', 'copy', 'cut', 'paste', 'send',
    'left', 'right', 'up', 'down', 'maximize', 'minimize', 'display', 'grid', 'star', 'bolt', 'bell', 'bellOff', 'none',
  ];

  const str = (v, max) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\t' ? c : '')).slice(0, max) : '');
  const line = (v, max) => str(v, max).replace(/[\n\t]/g, ' ');
  const int = (v, lo, hi, d) => (v !== null && v !== '' && v !== undefined && Number.isInteger(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const idOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : '');
  const pickOf = (k, v, d) => (WHATS[k].includes(v) ? v : d);
  let seq = 0;
  const newId = (p = 't') => `${p}${Date.now().toString(36)}${(seq++ % 1296).toString(36)}`;

  // A shortcut, as typed or recorded: modifiers first (in a fixed order), then one key.
  function combo(v) {
    const parts = String(v || '').split('+').map((x) => x.trim()).filter(Boolean);
    if (parts.some((p) => !MODS.includes(p) && !CODE.test(p))) return '';
    const mods = MODS.filter((m) => parts.includes(m));
    const keys = parts.filter((p) => !MODS.includes(p));
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

  // One action, in shape. Keys, text, a website, an app or a path may be empty while
  // being set up: they do nothing then (the computer says what's missing).
  function action(a, depth = 0) {
    const k = a && KINDS.includes(a.k) ? a.k : 'none';
    const what = (d) => pickOf(k, a.what, d);
    switch (k) {
      case 'keys': return { k, combo: combo(a.combo) };
      case 'text': return { k, text: str(a.text, 4000), enter: !!a.enter };
      case 'macro': {
        if (depth) return { k: 'none' }; // no macro inside a macro
        const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, MAX_STEPS)
          .map((s) => ({ action: action(s && s.action, 1), wait: int(s && s.wait, 0, 10000, 0) }))
          .filter((s) => !DEVICE.includes(s.action.k) && s.action.k !== 'slider');
        return { k, steps };
      }
      case 'media': return { k, what: what('playpause') };
      case 'volume': return { k, what: what('up'), level: int(a.level, 0, 100, 50), step: int(a.step, 1, 25, 6) };
      case 'mic': return { k, what: what('toggle') };
      case 'output': case 'input': return { k, id: str(a.id, 300), name: line(a.name, 80) };
      case 'bt': return { k, what: what('toggle'), id: str(a.id, 100), name: line(a.name, 80) };
      case 'bright': return { k, what: what('up'), level: int(a.level, 0, 100, 70), display: str(a.display, 100) };
      case 'slider': return { k, what: what('volume'), display: str(a.display, 100) };
      case 'app': return { k, id: str(a.id, 500), name: line(a.name, 80) };
      case 'url': return { k, url: url(a.url) };
      case 'open': return { k, path: str(a.path, 2000).trim() };
      case 'script': return { k, path: str(a.path, 2000).trim() };
      case 'sys': return { k, what: what('lock') };
      case 'win': return { k, what: what('max') };
      case 'clip': return { k, what: what('copy') };
      case 'nav': {
        const w = what('next');
        const to = idOf(a.to);
        if ((w === 'page' || w === 'space') && !to) return { k: 'none' };
        return w === 'page' || w === 'space' ? { k, what: w, to } : { k, what: w };
      }
      case 'widget': return { k, what: what('clock') };
      default: return { k: 'none' };
    }
  }

  // Tiles on a grid: each one inside it and on cells no earlier tile has.
  function tiles(list, cols, rows) {
    const taken = new Set();
    const out = [];
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || typeof t !== 'object') continue;
      const x = Number(t.x), y = Number(t.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= cols || y >= rows) continue; // off a smaller grid: gone
      const w = int(t.w, 1, Math.min(SPAN, cols - x), 1), h = int(t.h, 1, Math.min(SPAN, rows - y), 1); // past its edge: smaller
      const cells = [];
      for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) cells.push((y + dy) * cols + x + dx);
      if (cells.some((c) => taken.has(c))) continue;
      cells.forEach((c) => taken.add(c));
      out.push({
        id: idOf(t.id) || newId(), x, y, w, h,
        label: line(t.label, 40),
        icon: line(t.icon, 16).trim(),
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color.toLowerCase() : COLORS[0],
        action: action(t.action),
      });
    }
    return out;
  }

  function zone(z) {
    const x = int(z && z.x, 0, ZONE_GRID - 1, 0), y = int(z && z.y, 0, ZONE_GRID - 1, 0);
    return { x, y, w: int(z && z.w, 1, ZONE_GRID - x, ZONE_GRID - x), h: int(z && z.h, 1, ZONE_GRID - y, ZONE_GRID - y) };
  }

  const uniq = (ids, p, v) => { let id = idOf(v) || newId(p); while (ids.has(id)) id = newId(p); ids.add(id); return id; };

  // The phone's screen is about 16:9: a page's grid follows the way the Deck is held, so its tiles
  // are about square (held sideways, more columns than rows). fit(n, orient): the grid for n rows
  // (landscape) or n columns (portrait). A page made for the other way (its fit) is turned: columns
  // become rows and each tile goes with them. A grid narrower than the screen only grows, so no
  // tile is lost.
  const ASPECT = 16 / 9;
  function fit(n, orient) {
    const k = Math.min(GRID[1], Math.max(GRID[0], Math.round(n * ASPECT)));
    return orient === 'portrait' ? { cols: n, rows: k } : { cols: k, rows: n };
  }
  function shape(p, cols, rows, orient) {
    let list = Array.isArray(p.tiles) ? p.tiles : [];
    if ((p.fit === 'landscape' || p.fit === 'portrait') && p.fit !== orient) {
      [cols, rows] = [rows, cols];
      list = list.map((t) => (t && typeof t === 'object' ? { ...t, x: t.y, y: t.x, w: t.h, h: t.w } : t));
    }
    const [a, b] = orient === 'portrait' ? [rows, cols] : [cols, rows]; // the long side, the short one
    let long = a, short = b;
    if (long < Math.round(short * ASPECT)) long = Math.min(GRID[1], Math.round(short * ASPECT));
    if (long > short * ASPECT * 1.35) short = Math.min(GRID[1], Math.max(short, Math.round(long / ASPECT)));
    return orient === 'portrait' ? { cols: short, rows: long, list } : { cols: long, rows: short, list };
  }

  // v1 (one grid, buttons in slots) as one space of tiles.
  function fromV1(l) {
    const cols = int(l.cols, GRID[0], GRID[1], 4), rows = int(l.rows, GRID[0], GRID[1], 3);
    return {
      v: 2,
      spaces: [{ id: 'deck', name: 'Deck', kind: 'tiles', pages: (Array.isArray(l.pages) ? l.pages : []).map((p) => p && ({
        id: p.id, name: p.name, cols, rows,
        tiles: (Array.isArray(p.buttons) ? p.buttons : []).map((b) => b && ({
          ...b, x: Number(b.slot) % cols, y: Math.floor(Number(b.slot) / cols), w: 1, h: 1,
          action: b.action && b.action.k === 'page' ? { k: 'nav', what: 'page', to: b.action.to }
            : b.action && b.action.k === 'media' && /^vol|mute/.test(b.action.what) ? { k: 'volume', what: { volup: 'up', voldown: 'down', mute: 'toggle' }[b.action.what] }
              : b.action,
        })),
      })) }],
    };
  }

  function normalize(l) {
    let src = l && typeof l === 'object' ? l : {};
    if (!Array.isArray(src.spaces) && Array.isArray(src.pages)) src = fromV1(src);
    const sw = src.swipe && typeof src.swipe === 'object' ? src.swipe : {};
    const ids = new Set();
    const orient = src.orient === 'portrait' ? 'portrait' : 'landscape';
    const spaces = (Array.isArray(src.spaces) ? src.spaces : []).slice(0, MAX_SPACES).map((s, i) => {
      if (!s || typeof s !== 'object') return null;
      const id = uniq(ids, 's', s.id);
      const name = line(s.name, 30) || `Space ${i + 1}`;
      if (s.kind === 'windows') {
        const lids = new Set();
        const layouts = (Array.isArray(s.layouts) ? s.layouts : []).slice(0, MAX_LAYOUTS).map((x, j) => x && ({
          id: uniq(lids, 'l', x.id), name: line(x.name, 30) || `Layout ${j + 1}`,
          zones: (Array.isArray(x.zones) ? x.zones : []).slice(0, MAX_ZONES).map(zone),
        })).filter((x) => x && x.zones.length);
        const sids = new Set();
        const sets = (Array.isArray(s.sets) ? s.sets : []).slice(0, MAX_SETS).map((x) => {
          if (!x || typeof x !== 'object') return null;
          const items = (Array.isArray(x.items) ? x.items : []).slice(0, MAX_SET_APPS)
            .map((it) => it && line(it.key, 300) && { key: line(it.key, 300), name: line(it.name, 60), zone: zone(it.zone) }).filter(Boolean);
          if (!items.length) return null;
          return { id: uniq(sids, 'w', x.id), name: line(x.name, 60) || items.map((it) => it.name || '?').join(' + ').slice(0, 60), display: line(x.display, 80), items };
        }).filter(Boolean);
        return { id, name, kind: 'windows', layouts: layouts.length ? layouts : starterLayouts(), sets };
      }
      const pages = (Array.isArray(s.pages) ? s.pages : []).slice(0, MAX_PAGES).map((p, j) => {
        if (!p || typeof p !== 'object') return null;
        const g = shape(p, int(p.cols, GRID[0], GRID[1], 4), int(p.rows, GRID[0], GRID[1], 4), orient);
        return { id: uniq(ids, 'p', p.id), name: line(p.name, 30) || `Page ${j + 1}`, cols: g.cols, rows: g.rows, fit: orient, tiles: tiles(g.list, g.cols, g.rows) };
      }).filter(Boolean);
      return { id, name, kind: 'tiles', pages: pages.length ? pages : [{ id: uniq(ids, 'p'), name: 'Page 1', ...fit(4, orient), fit: orient, tiles: [] }] };
    }).filter(Boolean);
    const out = { v: 2, swipe: { pages: sw.pages !== false, spaces: sw.spaces !== false }, orient, spaces };
    if (!spaces.length) return normalize(starter());
    // Navigate to a page or space that's gone: nothing.
    const fix = (a) => {
      if (a.k === 'nav' && (a.what === 'page' || a.what === 'space') && !ids.has(a.to)) return { k: 'none' };
      return a;
    };
    for (const s of spaces) for (const p of s.pages || []) for (const t of p.tiles) t.action = fix(t.action);
    return out;
  }

  // The window space's first layouts (the person makes more on the computer's Deck page).
  function starterLayouts() {
    const z = (x, y, w, h) => ({ x, y, w, h });
    return [
      { id: 'full', name: 'Full', zones: [z(0, 0, 12, 12)] },
      { id: 'halves', name: 'Halves', zones: [z(0, 0, 6, 12), z(6, 0, 6, 12)] },
      { id: 'thirds', name: 'Thirds', zones: [z(0, 0, 4, 12), z(4, 0, 4, 12), z(8, 0, 4, 12)] },
      { id: 'focus', name: 'Main and side', zones: [z(0, 0, 8, 12), z(8, 0, 4, 12)] },
      { id: 'quarters', name: 'Quarters', zones: [z(0, 0, 6, 6), z(6, 0, 6, 6), z(0, 6, 6, 6), z(6, 6, 6, 6)] },
      { id: 'center', name: 'Centered', zones: [z(2, 1, 8, 10)] },
    ];
  }

  // The first layout: the media and sound everyone reaches for, the keyboard's everyday shortcuts,
  // and the window space.
  function starter() {
    const t = (id, x, y, w, h, label, icon, color, a) => ({ id, x, y, w, h, label, icon, color, action: a });
    return {
      v: 2,
      swipe: { pages: true, spaces: true },
      orient: 'landscape',
      spaces: [
        { id: 'deck', name: 'Deck', kind: 'tiles', pages: [
          { id: 'main', name: 'Main', cols: 4, rows: 4, tiles: [
            t('play', 0, 0, 2, 1, 'Play or pause', '', '#2c2c2e', { k: 'media', what: 'playpause' }),
            t('prev', 2, 0, 1, 1, 'Previous', '', '#2c2c2e', { k: 'media', what: 'prev' }),
            t('next', 3, 0, 1, 1, 'Next', '', '#2c2c2e', { k: 'media', what: 'next' }),
            t('vol', 0, 1, 2, 1, 'Volume', '', '#2c2c2e', { k: 'slider', what: 'volume' }),
            t('bright', 2, 1, 2, 1, 'Brightness', '', '#2c2c2e', { k: 'slider', what: 'bright' }),
            t('mute', 0, 2, 1, 1, 'Mute', '', '#ff3b30', { k: 'volume', what: 'toggle' }),
            t('mic', 1, 2, 1, 1, 'Microphone', '', '#ff9f0a', { k: 'mic', what: 'toggle' }),
            t('shot', 2, 2, 1, 1, 'Screenshot', '', '#5e5ce6', { k: 'sys', what: 'shotarea' }),
            t('lock', 3, 2, 1, 1, 'Lock', '', '#2c2c2e', { k: 'sys', what: 'lock' }),
            t('copy', 0, 3, 1, 1, 'Copy', '', '#30b94d', { k: 'clip', what: 'copy' }),
            t('paste', 1, 3, 1, 1, 'Paste', '', '#30b94d', { k: 'clip', what: 'paste' }),
            t('desk', 2, 3, 1, 1, 'Desktop', '', '#0a84ff', { k: 'sys', what: 'desktop' }),
            t('keys', 3, 3, 1, 1, 'Shortcuts', 'keyboard', '#bf5af2', { k: 'nav', what: 'page', to: 'keys' }),
          ] },
          { id: 'keys', name: 'Shortcuts', cols: 4, rows: 4, tiles: [
            t('esc', 0, 0, 1, 1, 'Esc', '', '#2c2c2e', { k: 'keys', combo: 'Escape' }),
            t('tab', 1, 0, 1, 1, 'Tab', '', '#2c2c2e', { k: 'keys', combo: 'Tab' }),
            t('undo', 2, 0, 1, 1, 'Undo', '', '#2c2c2e', { k: 'keys', combo: 'Mod+KeyZ' }),
            t('redo', 3, 0, 1, 1, 'Redo', '', '#2c2c2e', { k: 'keys', combo: 'Mod+Shift+KeyZ' }),
            t('up', 1, 1, 1, 1, 'Up', 'up', '#2c2c2e', { k: 'keys', combo: 'ArrowUp' }),
            t('left', 0, 2, 1, 1, 'Left', 'left', '#2c2c2e', { k: 'keys', combo: 'ArrowLeft' }),
            t('down', 1, 2, 1, 1, 'Down', 'down', '#2c2c2e', { k: 'keys', combo: 'ArrowDown' }),
            t('right', 2, 2, 1, 1, 'Right', 'right', '#2c2c2e', { k: 'keys', combo: 'ArrowRight' }),
            t('save', 3, 1, 1, 1, 'Save', '', '#0a84ff', { k: 'keys', combo: 'Mod+KeyS' }),
            t('find', 3, 2, 1, 1, 'Find', '', '#0a84ff', { k: 'keys', combo: 'Mod+KeyF' }),
            t('switch', 0, 3, 2, 1, 'Switch apps', '', '#5e5ce6', { k: 'sys', what: 'switcher' }),
            t('newtab', 2, 3, 1, 1, 'New tab', '', '#0a84ff', { k: 'keys', combo: 'Mod+KeyT' }),
            t('back', 3, 3, 1, 1, 'Main', 'left', '#bf5af2', { k: 'nav', what: 'page', to: 'main' }),
          ] },
        ] },
        { id: 'windows', name: 'Windows', kind: 'windows', layouts: starterLayouts(), sets: [] },
      ],
    };
  }

  // What a device gets: no paths (it shows their tile's label and icon only).
  function forDevice(l, opts = {}) {
    const out = JSON.parse(JSON.stringify(normalize(l)));
    const strip = (a) => (LOCAL.includes(a.k) ? { k: a.k, set: !!a.path } : a);
    for (const s of out.spaces) {
      for (const p of s.pages || []) for (const t of p.tiles) {
        t.action = strip(t.action);
        if (t.action.k === 'macro') t.action.steps = t.action.steps.map((x) => ({ ...x, action: strip(x.action) }));
      }
    }
    if (opts.windows === false) out.spaces = out.spaces.filter((s) => s.kind !== 'windows');
    if (!out.spaces.length) out.spaces = [{ id: 'deck', name: 'Deck', kind: 'tiles', pages: [{ id: 'main', name: 'Page 1', cols: 4, rows: 4, tiles: [] }] }];
    return out;
  }

  // A layout edited on a device, onto the one kept here: a tile that opens a path keeps
  // this computer's (the device can move, resize, relabel or delete it); a new one from the device
  // can't have one. A window space the device didn't get (windows: false) stays.
  function fromDevice(kept, incoming) {
    const old = normalize(kept);
    const mine = new Map();
    for (const s of old.spaces) for (const p of s.pages || []) for (const t of p.tiles) mine.set(t.id, t.action);
    const keep = (id, a) => {
      if (!a || !LOCAL.includes(a.k)) return a;
      const m = mine.get(id);
      return m && m.k === a.k ? m : { k: a.k };
    };
    const n = JSON.parse(JSON.stringify(incoming || {}));
    if (Array.isArray(n.spaces)) {
      for (const s of n.spaces) {
        for (const p of (s && Array.isArray(s.pages) ? s.pages : [])) for (const t of (Array.isArray(p && p.tiles) ? p.tiles : [])) {
          if (!t || !t.action) continue;
          if (t.action.k === 'macro') {
            const m = mine.get(t.id);
            if (m && m.k === 'macro') t.action = m; // a macro's steps may hold paths: only edited here
            else t.action = { k: 'macro', steps: (t.action.steps || []).filter((x) => x && x.action && !LOCAL.includes(x.action.k)) };
          } else t.action = keep(t.id, t.action);
        }
      }
      for (const s of old.spaces) if (s.kind === 'windows' && !n.spaces.some((x) => x && x.id === s.id)) n.spaces.push(s);
    }
    return normalize(n);
  }

  const space = (l, id) => (l.spaces || []).find((s) => s.id === id) || null;
  const pageOf = (l, spaceId, pageId) => { const s = space(l, spaceId); return (s && (s.pages || []).find((p) => p.id === pageId)) || null; };
  // A tile by its id, wherever it is (ids are unique in a layout).
  function find(l, id) {
    for (const s of l.spaces || []) for (const p of s.pages || []) { const t = p.tiles.find((x) => x.id === id); if (t) return t; }
    return null;
  }
  function where(l, id) {
    for (const s of l.spaces || []) for (const p of s.pages || []) if (p.tiles.some((x) => x.id === id)) return { space: s, page: p };
    return null;
  }

  const covers = (t, x, y) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Whether a w × h tile fits at x, y on a page (leaving out the tile `except`).
  function fits(p, x, y, w, h, except) {
    if (x < 0 || y < 0 || x + w > p.cols || y + h > p.rows) return false;
    return !p.tiles.some((t) => t.id !== except && overlaps(t, { x, y, w, h }));
  }
  // The first free place for a w × h tile, row by row; null when the page is full.
  function free(p, w = 1, h = 1) {
    for (let y = 0; y + h <= p.rows; y++) for (let x = 0; x + w <= p.cols; x++) if (fits(p, x, y, w, h)) return { x, y };
    return null;
  }
  // A tile to x, y (or onto another page): a tile of the same size that's there swaps places with
  // it; otherwise it moves only where it fits. Returns the new layout (unchanged when it can't).
  function move(l, id, toPage, x, y) {
    const out = normalize(l);
    const from = where(out, id);
    let to = null;
    for (const s of out.spaces) for (const p of s.pages || []) if (p.id === toPage) to = p;
    if (!from || !to) return out;
    const t = from.page.tiles.find((v) => v.id === id);
    if (x === undefined) { const f = free(to, Math.min(t.w, to.cols), Math.min(t.h, to.rows)); if (!f) return out; ({ x, y } = f); }
    const w = Math.min(t.w, to.cols), h = Math.min(t.h, to.rows);
    const other = to.tiles.find((v) => v.id !== id && covers(v, x, y));
    if (other && other.w === t.w && other.h === t.h && other.x === x && other.y === y && from.page === to) {
      other.x = t.x; other.y = t.y; t.x = x; t.y = y;
      return out;
    }
    if (!fits(to, x, y, w, h, id)) return out;
    if (from.page !== to) { from.page.tiles = from.page.tiles.filter((v) => v !== t); to.tiles.push(t); }
    Object.assign(t, { x, y, w, h });
    return out;
  }
  function resize(l, id, w, h) {
    const out = normalize(l);
    const at = where(out, id);
    if (!at) return out;
    const t = at.page.tiles.find((v) => v.id === id);
    w = Math.max(1, Math.min(SPAN, w)); h = Math.max(1, Math.min(SPAN, h));
    if (fits(at.page, t.x, t.y, w, h, id)) Object.assign(t, { w, h });
    return out;
  }

  // The symbol a tile shows when it has none of its own.
  function symbolOf(a) {
    const w = a && a.what;
    switch (a && a.k) {
      case 'keys': return 'command';
      case 'text': return 'text';
      case 'macro': return 'macro';
      case 'media': return { playpause: 'play', next: 'next', prev: 'prev', stop: 'stop' }[w];
      case 'volume': return { up: 'volume', down: 'volumeDown', set: 'volume', mute: 'mute', unmute: 'volume', toggle: 'mute' }[w];
      case 'mic': return w === 'unmute' ? 'mic' : 'micOff';
      case 'output': return 'speaker';
      case 'input': return 'mic';
      case 'bt': return 'bluetooth';
      case 'bright': return w === 'down' ? 'sunDim' : 'sun';
      case 'slider': return { volume: 'volume', mic: 'mic', bright: 'sun' }[w];
      case 'app': return 'app';
      case 'url': return 'globe';
      case 'open': return 'folder';
      case 'script': return 'terminal';
      case 'sys': return { lock: 'lock', sleep: 'sleep', screenoff: 'display', desktop: 'desktop', switcher: 'switcher', overview: 'windows', screenshot: 'camera', shotarea: 'crop', darkmode: 'moon', dnd: 'bellOff' }[w];
      case 'win': return { left: 'left', right: 'right', top: 'up', bottom: 'down', max: 'maximize', min: 'minimize', full: 'maximize', nextdisplay: 'display', close: 'none' }[w] || 'grid';
      case 'clip': return { copy: 'copy', cut: 'cut', paste: 'paste', send: 'send' }[w];
      case 'widget': return { clock: 'clock', media: 'play', cpu: 'cpu', ram: 'memory', temp: 'thermo' }[w];
      case 'nav': return { page: 'grid', space: 'windows', next: 'right', prev: 'left', nextspace: 'down', prevspace: 'up' }[w];
      default: return 'none';
    }
  }
  const iconOf = (t) => (t.icon || symbolOf(t.action) || 'none');

  const api = {
    KINDS, LOCAL, DEVICE, MEDIA, WHATS, MODS, COLORS, SYMBOLS, GRID, SPAN, ZONE_GRID,
    normalize, fit, starter, starterLayouts, action, combo, codesOf, url, forDevice, fromDevice,
    space, pageOf, find, where, fits, free, move, resize, symbolOf, iconOf, newId,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
