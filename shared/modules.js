// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Modules (Settings › General › Modules): every sidebar page but General, About, Connection and the
// Overview is a module that can be switched off. A module that's off isn't loaded at all: its page
// scripts aren't fetched (shared/modload.js), its pages aren't registered (UI.tab), its tray items
// are gone (shared/traymenu.js), and before it went off its page's own switch was turned off, so
// its main-process side (already loaded only while switched on) never starts. Off and on apply
// after a restart: the window's scripts are fixed at load.
//   settings.modules: { off: [ids], was: [ids that were switched on when they went off] }
//   The window gets the ids that are off at start in its URL: ?off=terminal,camera (offQuery).
// CommonJS in main and tests, a plain <script> in renderers (window.TdModules).
'use strict';

(function (root) {
  // id, the sidebar pages it holds (every app's ids: the Mac's share/receive are the PC's and
  // Linux's pc-mac/mac-pc), and the page scripts that only it needs (any of `of` on loads one).
  const LIST = [
    { id: 'share', label: 'Share screen', pages: ['share', 'pc-mac'] },
    { id: 'receive', label: 'Receive screen', pages: ['receive', 'mac-pc'] },
    { id: 'apps', label: 'Apps', pages: ['apps'] },
    { id: 'cursor', label: 'Cursor', pages: ['cursor'] },
    { id: 'keyboard', label: 'Keyboard', pages: ['keyboard'] },
    { id: 'remote', label: 'Remote', pages: ['remote'] },
    { id: 'clipboard', label: 'Clipboard', pages: ['clipboard'] },
    { id: 'notifications', label: 'Notifications', pages: ['notifications'] },
    { id: 'files', label: 'Files', pages: ['files'] },
    { id: 'mount', label: 'Mount', pages: ['mount'] },
    { id: 'audio', label: 'Audio', pages: ['audio'] },
    { id: 'camera', label: 'Camera', pages: ['camera'] },
    { id: 'rezume', label: 'ReZume', pages: ['rezume'] },
    { id: 'terminal', label: 'Terminal', pages: ['terminal'] },
    { id: 'calls', label: 'Calls', pages: ['calls'] },
    { id: 'messages', label: 'Messages', pages: ['messages'] },
    { id: 'media', label: 'Media', pages: ['media'] },
    { id: 'pfiles', label: 'Phone files', pages: ['pfiles'] },
    { id: 'papps', label: 'Phone apps', pages: ['papps'] },
    { id: 'mirror', label: 'Phone screen', pages: ['mirror', 'ios-mirror'] },
    { id: 'deck', label: 'Deck', pages: ['deck'] },
    { id: 'web', label: 'TwinDesk Web', pages: ['web', 'wd-overview', 'wd-drop'] },
    { id: 'airplay', label: 'AirPlay', pages: ['airplay'] },
    { id: 'iossign', label: 'TwinDesk iPhone', pages: ['iossign'] },
    { id: 'multi', label: 'Multi-device', pages: ['multi'] },
  ];
  // Always there: not modules.
  const FIXED = ['general', 'about', 'connection', 'overview', 'android-overview', 'ios-overview', 'phone', 'setup'];
  // Page scripts (basenames) that only modules use: loaded when any of the modules is on.
  const SCRIPTS = {
    'ui-display.js': ['share'], 'ui-share.js': ['share'],
    'ui-display-pc.js': ['receive'], 'ui-receive.js': ['receive'],
    'kvm-geom.js': ['cursor'], 'kvm-map-ui.js': ['cursor'], 'ui-cursor.js': ['cursor'], 'mesh-intro.js': ['cursor', 'multi'],
    'ui-keyboard.js': ['keyboard'], 'ui-clipboard.js': ['clipboard'], 'ui-notifs.js': ['notifications'],
    'ui-mic.js': ['audio'], 'ui-audio.js': ['audio'], 'ui-camera.js': ['camera'], 'ui-remote.js': ['remote'],
    'ui-terminal.js': ['terminal'], 'ui-files.js': ['files'], 'ui-mount.js': ['mount'], 'ui-apps.js': ['apps'],
    'ui-mirror.js': ['mirror', 'papps'], 'ui-ios-screen.js': ['mirror'], 'ui-multi.js': ['multi'],
    'ui-calls.js': ['calls'], 'ui-messages.js': ['messages'], 'ui-media.js': ['media'], 'ui-pfiles.js': ['pfiles'],
    'ui-deck.js': ['deck'], 'deck-model.js': ['deck'], 'deck-catalog.js': ['deck'], 'deck-icons.js': ['deck'],
    'ui-ios-sign.js': ['iossign'],
  };
  const IDS = LIST.map((m) => m.id);
  const byPage = {};
  for (const m of LIST) for (const p of m.pages) byPage[p] = m.id;

  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => IDS.includes(x)))];
  // settings.modules from a file or the UI, always well-formed.
  const normalize = (v) => ({ off: ids(v && v.off), was: ids(v && v.was) });
  const isOn = (cfg, id) => !normalize(cfg).off.includes(id);
  // The module a page belongs to, or null (fixed, or not a module page).
  const ofPage = (page) => byPage[page] || null;
  const pageOff = (off, page) => { const m = ofPage(page); return !!m && off.includes(m); };
  // Should a page script be loaded? Not one of the module scripts: always.
  const scriptOn = (off, src) => {
    const base = String(src).split('/').pop();
    const of = SCRIPTS[base];
    return !of || of.some((m) => !off.includes(m));
  };
  // The window's query: the modules off at start ('' when none).
  const offQuery = (cfg) => normalize(cfg).off.join(',');
  // A switch changed: on → leaves `off`; off → joins it, remembering whether its page was on (its
  // page switches it back on at the first start with the module on: restore, then restored).
  function set(cfg, id, on, wasOn) {
    const c = normalize(cfg);
    if (!IDS.includes(id)) return c;
    if (on) c.off = c.off.filter((x) => x !== id);
    else {
      c.off = [...new Set([...c.off, id])];
      c.was = wasOn ? [...new Set([...c.was, id])] : c.was.filter((x) => x !== id);
    }
    return c;
  }
  // Modules on at start whose page was switched on when they went off.
  const restore = (cfg, offAtStart) => { const c = normalize(cfg); return c.was.filter((id) => !c.off.includes(id) && !offAtStart.includes(id)); };
  const restored = (cfg, id) => { const c = normalize(cfg); c.was = c.was.filter((x) => x !== id); return c; };

  // state.modules for General › Modules: what's saved, what this run started with, and whether a
  // restart is needed to apply the switches.
  function view(cfg, atStart) {
    const c = normalize(cfg);
    const a = ids(atStart);
    return { off: c.off, atStart: a, restart: c.off.length !== a.length || c.off.some((x) => !a.includes(x)), restore: restore(c, a) };
  }

  const api = { view, LIST, FIXED, IDS, SCRIPTS, normalize, isOn, ofPage, pageOff, scriptOn, offQuery, set, restore, restored };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TdModules = api;
})(typeof window !== 'undefined' ? window : globalThis);

// In a window: the modules off at start (?off=…), and pages of those never registered.
if (typeof window !== 'undefined' && window.TdModules) {
  (function () {
    const q = new URLSearchParams(location.search).get('off') || '';
    // In Multi-device (a …/mesh/ window) its own page is always there: it's the way back out.
    TdModules.keep = /\/mesh\/[^/]+\.html$/.test(location.pathname) ? ['multi'] : [];
    TdModules.off = TdModules.normalize({ off: q.split(',') }).off.filter((id) => !TdModules.keep.includes(id));
    TdModules.skipped = []; // modules whose pages or scripts this window has but didn't load
    if (typeof UI === 'undefined' || !UI.tab) return;
    const register = UI.tab;
    UI.tab = function (def) {
      if (def && TdModules.pageOff(TdModules.off, def.id)) { TdModules.skipped.push(TdModules.ofPage(def.id)); return undefined; }
      return register.apply(UI, arguments);
    };
  })();
}
