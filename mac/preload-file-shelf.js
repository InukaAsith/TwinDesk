// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fileShelf', {
  read: () => ipcRenderer.invoke('file-shelf:read'),
  onState: callback => ipcRenderer.on('file-shelf:state', (_event, state) => callback(state)),
  reveal: id => ipcRenderer.send('file-shelf:reveal', id),
  drag: id => ipcRenderer.send('file-shelf:drag', id),
  close: () => ipcRenderer.send('file-shelf:close'),
});
