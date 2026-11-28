// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden sound window's API: audio.* messages in and out, state back to main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sound', {
  on: (fn) => ipcRenderer.on('sound', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('sound-out', m),
  state: (s) => ipcRenderer.send('sound-state', s),
  ready: () => ipcRenderer.send('sound-ready'),
  pcm: (fn) => ipcRenderer.on('pcm', (_e, buf) => fn(buf)), // this PC's sound from the helper (syscapture.js)
});
