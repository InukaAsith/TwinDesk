// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's chooser window (rzpick.js): what is asked, and the answer.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rzpick', {
  ask: () => ipcRenderer.invoke('rzpick:ask'),
  answer: (how) => ipcRenderer.send('rzpick:answer', how),
});
