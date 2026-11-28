// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for the hidden audio window (standalone sound, both directions).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioApi', {
  on: (channel, fn) => ipcRenderer.on(channel, (_e, m) => fn(m)), // 'send-start' | 'send-stop' | 'recv' | 'remote' | 'volume' | 'route' | 'pcm'
  send: (msg) => ipcRenderer.send('audio:out', msg),
  state: (s) => ipcRenderer.send('audio:state', s),
});
