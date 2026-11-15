// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden sender window's API: commands and rtc2.* in, rtc2.*, state and stats out.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, session) => {
  const frame = importedSharedTexture.getVideoFrame();
  try { window.postMessage({ type: 'twindesk-native-frame', session, frame }, '*', [frame]); }
  catch (error) { frame.close(); throw error; }
  finally { importedSharedTexture.release(); }
});

contextBridge.exposeInMainWorld('sender', {
  on: (fn) => ipcRenderer.on('sender', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('sender-out', m),
  state: (s) => ipcRenderer.send('sender-state', s),
  stats: (s) => ipcRenderer.send('sender-stats', s),
  ready: () => ipcRenderer.send('sender-ready'),
  log: (text) => ipcRenderer.send('sender-log', String(text).slice(0, 300)), // into TwinDesk.log (main)
  nativeStart: (session) => new Promise((resolve) => {
    const ready = (_e, m) => {
      if (m.session !== session) return;
      ipcRenderer.removeListener('sender-native-ready', ready);
      resolve(m);
    };
    ipcRenderer.on('sender-native-ready', ready);
    ipcRenderer.send('sender-native-start', session);
  }),
});
