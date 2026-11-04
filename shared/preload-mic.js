// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden microphone window's API (shared/mic.js): mic.* messages in and out, state back to main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mic', {
  on: (fn) => ipcRenderer.on('mic', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('mic-out', m),
  state: (s) => ipcRenderer.send('mic-state', s),
  ready: () => ipcRenderer.send('mic-ready'),
});
