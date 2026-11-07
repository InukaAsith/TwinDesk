// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The AirPlay window (shared/airplay/viewer.js): the sender's codec record and frames in.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airplay', {
  on: (fn) => ipcRenderer.on('airplay:in', (_e, m) => fn(m)),
  ready: () => ipcRenderer.send('airplay:ready'),
  size: (w, h) => ipcRenderer.send('airplay:size', { w, h }),
});
