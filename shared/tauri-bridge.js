// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 Polyfill Bridge:
// When running inside Tauri v2, maps the Electron preload window.macshare IPC interface
// 1:1 to Tauri's native core.invoke() and event.listen() systems.
// When running in standard Electron, does nothing and leaves window.macshare intact.
(function () {
  'use strict';

  const isTauri = typeof window !== 'undefined' && (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);
  if (!isTauri) return;

  const tauri = window.__TAURI__ || {};
  const core = tauri.core || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke ? window.__TAURI_INTERNALS__ : null);
  const event = tauri.event || null;

  if (!core || typeof core.invoke !== 'function') return;

  const invoke = (cmd, args = {}) => core.invoke(cmd, args);

  const api = {
    getState: () => invoke('get_state'),
    onState: (fn) => {
      if (event && event.listen) {
        event.listen('state-change', (e) => fn(e.payload));
      }
    },
    onShowUpdate: (fn) => {
      if (event && event.listen) {
        event.listen('show-update', () => fn());
      }
    },
    onGo: (fn) => {
      if (event && event.listen) {
        event.listen('go', (e) => fn(e.payload));
      }
    },
    onHub: () => {},
    onCamPreview: () => {},

    setKvm: (partial) => invoke('set_kvm', { partial }),
    setLayout: (side) => invoke('set_layout', { side }),
    setKeys: (partial) => invoke('set_keys', { partial }),
    setApp: (partial) => invoke('set_app', { partial }),
    setUpdates: (partial) => invoke('set_updates', { partial }),
    skipUpdate: (version) => invoke('skip_update', { version }),
    unskipUpdate: () => invoke('unskip_update'),
    checkUpdates: () => invoke('check_updates'),
    openUpdate: () => invoke('open_update'),
    openLink: (key) => invoke('open_link', { key }),
    setMonitor: (partial) => invoke('set_monitor', { partial }),
    setClipboard: (partial) => invoke('set_clipboard', { partial }),
    copyHistory: (index) => invoke('copy_history', { index }),
    clearHistory: () => invoke('clear_history'),
    setTab: (tab) => invoke('set_tab', { tab }),
    setMulti: (on) => invoke('set_multi', { on }),

    pair: (host) => invoke('pair', { host }),
    pairRespond: (allowed) => invoke('pair_respond', { allowed }),
    disconnect: () => invoke('disconnect'),
    connectAgain: () => invoke('connect_again'),
    connectAddress: (addr) => invoke('connect_address', { addr }),
    refreshFound: () => invoke('refresh_found'),
    copyText: (text) => invoke('copy_text', { text }),
    skipSetup: () => invoke('skip_setup'),
    confirmCode: () => invoke('confirm_code'),
    cancelPair: () => invoke('cancel_pair'),
    forget: (id) => invoke('forget', { id }),
    wakePeer: (id) => invoke('wake_peer', { id }),

    pathsOf: (files) => [...files].map((f) => f.path || f.name).filter(Boolean),
  };

  window.macshare = api;
  console.log('[TwinDesk] Running on Tauri v2 native bridge (low-memory runtime)');
})();
