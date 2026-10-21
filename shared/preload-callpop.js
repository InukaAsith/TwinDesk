// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The call window's API (callwin.js): its state, and Answer / Decline / End / Mute / where the sound is.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callpop', {
  state: () => ipcRenderer.invoke('callpop:state'),
  onState: (fn) => ipcRenderer.on('callpop:state', (_e, s) => fn(s)),
  act: (r) => ipcRenderer.send('callpop:act', r),
  open: () => ipcRenderer.send('callpop:open'),
  close: () => ipcRenderer.send('callpop:close'),
});
