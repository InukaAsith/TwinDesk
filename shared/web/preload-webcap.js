// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden TwinDesk Web capture window's bridge (shared/web/webcap.js).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webcap', {
  onStart: (fn) => ipcRenderer.on('start', (_e, m) => fn(m)),
  onStop: (fn) => ipcRenderer.on('stop', () => fn()),
  onRemote: (fn) => ipcRenderer.on('remote', (_e, m) => fn(m)),
  onPcm: (fn) => ipcRenderer.on('pcm', (_e, buf) => fn(buf)),
  send: (m) => ipcRenderer.send('webcap:out', m),
  state: (s) => ipcRenderer.send('webcap:state', s),
});
