// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A notification window's API (notifpop.js): what it shows, and its buttons, Reply and Copy.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notifpop', {
  get: () => ipcRenderer.invoke('notifpop:get'),
  onState: (fn) => ipcRenderer.on('notifpop:state', (_e, s) => fn(s)),
  size: (h) => ipcRenderer.send('notifpop:size', h),
  hover: (on) => ipcRenderer.send('notifpop:hover', !!on),
  typing: () => ipcRenderer.send('notifpop:typing'),
  act: (i) => ipcRenderer.send('notifpop:act', i),
  reply: (text) => ipcRenderer.send('notifpop:reply', text),
  copy: () => ipcRenderer.send('notifpop:copy'),
  open: () => ipcRenderer.send('notifpop:open'),
  close: () => ipcRenderer.send('notifpop:close'),
  dismiss: () => ipcRenderer.send('notifpop:dismiss'),
});

contextBridge.exposeInMainWorld('playerLanguage', {
  onChange: (fn) => ipcRenderer.on('ui-language', (_e, language) => fn(language)),
});
