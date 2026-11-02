// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone window's bridge to main: video, size, sound, status and the window's options in; input out.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('phoneview', {
  on: (ch, fn) => {
    if (['size', 'video', 'audio', 'netaudio', 'status', 'opts'].includes(ch)) ipcRenderer.on(`phoneview:${ch}`, (_e, m) => fn(m));
  },
  send: (m) => ipcRenderer.send('phoneview:in', m),
  // files: an array of File (a FileList reaches this side of the bridge as a plain object, which can't be iterated)
  drop: (files) => ipcRenderer.send('phoneview:drop', [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean)),
});

// A camera's picture to the Camera tab and the virtual camera (shared/vcam-feed.js, shared/vcam.js).
contextBridge.exposeInMainWorld('camout', {
  hello: () => ipcRenderer.send('vcam:hello'),
  frame: (buf) => ipcRenderer.send('vcam:frame', buf),
  preview: (buf) => ipcRenderer.send('vcam:preview', buf),
  on: (fn) => ipcRenderer.on('vcam:set', (_e, m) => fn(m)),
});

contextBridge.exposeInMainWorld('playerLanguage', {
  onChange: (fn) => ipcRenderer.on('ui-language', (_e, language) => fn(language)),
});
