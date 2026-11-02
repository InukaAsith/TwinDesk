// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for the PC-screen viewer window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcview', {
  on: (fn) => ipcRenderer.on('pcview', (_e, m) => fn(m)), // offer | rtc2.ice | blur | input | volume
  send: (msg) => ipcRenderer.send('pcview:out', msg),
  state: (s) => ipcRenderer.send('pcview:state', s),
  ready: () => ipcRenderer.send('pcview:ready'),
  ctl: (m) => ipcRenderer.send('pcview:ctl', m), // Toolbar: {share?, mode?, framegen?, fullScreen?}
});

contextBridge.exposeInMainWorld('playerLanguage', {
  onChange: (fn) => ipcRenderer.on('ui-language', (_e, language) => fn(language)),
});
