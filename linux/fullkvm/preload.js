// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Full KVM build's session preload (manager.js registers it, next to each window's own): the
// Full KVM tab's two calls. The normal build never registers it, so its pages have no tdFullKvm.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdFullKvm', {
  state: () => ipcRenderer.invoke('fullkvm', 'state'),
  set: (mode) => ipcRenderer.invoke('fullkvm', 'set', String(mode)),
});
