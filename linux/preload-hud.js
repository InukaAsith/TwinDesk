// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', { on: (fn) => ipcRenderer.on('hud', (_e, m) => fn(m)) });

contextBridge.exposeInMainWorld('playerLanguage', { onChange: (fn) => ipcRenderer.on('ui-language', (_event, language) => fn(language)) });
