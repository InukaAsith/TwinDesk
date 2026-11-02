// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for an app window of the other PC (peerapps.js).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appview', {
  on: (fn) => ipcRenderer.on('appview', (_e, m) => fn(m)), // offer | rtc2.ice | blur | stop
  send: (msg) => ipcRenderer.send('appview:out', msg),
  ready: () => ipcRenderer.send('appview:ready'),
});

contextBridge.exposeInMainWorld('playerLanguage', {
  onChange: (fn) => ipcRenderer.on('ui-language', (_e, language) => fn(language)),
});
