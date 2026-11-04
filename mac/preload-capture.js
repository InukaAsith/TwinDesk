// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for the hidden capture window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  onStart: (fn) => ipcRenderer.on('start', (_e, m) => fn(m)),
  onStop: (fn) => ipcRenderer.on('stop', () => fn()),
  onRemote: (fn) => ipcRenderer.on('remote', (_e, m) => fn(m)),
  onPcm: (fn) => ipcRenderer.on('pcm', (_e, buf) => fn(buf)),
  send: (msg) => ipcRenderer.send('capture:out', msg),
  stats: (s) => ipcRenderer.send('capture:stats', s),
  state: (s) => ipcRenderer.send('capture:state', s),
  helperAudio: () => ipcRenderer.invoke('capture:helperAudio'), // Chromium gave no sound: the helper's

});
