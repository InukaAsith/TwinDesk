// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The camera windows' bridge to main (camshare.js): messages in, messages out; and its picture onward.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cam', {
  on: (fn) => ipcRenderer.on('cam:in', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('cam:out', m),
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
