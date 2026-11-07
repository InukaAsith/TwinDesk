// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden window that takes a web device's camera and microphone (shared/web/webrecv.js).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webrecv', {
  on: (fn) => ipcRenderer.on('webrecv:in', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('webrecv:out', m),
});
// The picture onward, as every camera window sends it (shared/vcam-feed.js → shared/vcam.js).
contextBridge.exposeInMainWorld('camout', {
  hello: () => ipcRenderer.send('vcam:hello'),
  frame: (buf) => ipcRenderer.send('vcam:frame', buf),
  preview: (buf) => ipcRenderer.send('vcam:preview', buf),
  on: (fn) => ipcRenderer.on('vcam:set', (_e, m) => fn(m)),
});
