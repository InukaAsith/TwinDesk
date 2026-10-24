// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone window's bridge to main: video, size, sound, status and the window's options in; input out.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('phoneview', {
  on: (ch, fn) => {
    if (['size', 'video', 'audio', 'netaudio', 'status', 'opts'].includes(ch)) ipcRenderer.on(`phoneview:${ch}`, (_e, m) => fn(m));
  },
  send: (m) => ipcRenderer.send('phoneview:in', m),
  drop: (files) => ipcRenderer.send('phoneview:drop', [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean)),
});
