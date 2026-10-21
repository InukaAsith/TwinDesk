// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The small API the Monitor 2 window gets: stream/rtc messages in, rtc answers/candidates out.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onRtc: (fn) => ipcRenderer.on('rtc', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('rtc', m),
  ready: () => ipcRenderer.send('monitor-ready'),
  stats: (st) => ipcRenderer.send('monitor-stats', st),
  onInputEnabled: (fn) => ipcRenderer.on('input-enabled', (_e, on) => fn(!!on)),
  onAudio: (fn) => ipcRenderer.on('audio', (_e, a) => fn(a)),
  onPacing: (fn) => ipcRenderer.on('pacing', (_e, p) => fn(p)),
  onRemote: (fn) => ipcRenderer.on('remote', (_e, r) => fn(r)), // the peer's screen.state
  ctl: (m) => ipcRenderer.send('monitor-ctl', m), // toolbar: {share?, mode?, framegen?, fullScreen?}
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  drop: (paths, x, y) => ipcRenderer.send('drop', { paths, x, y }),
  onDropProgress: (fn) => ipcRenderer.on('drop-progress', (_e, v) => fn(v)),
  onAppWindows: (fn) => ipcRenderer.on('app-windows', (_e, list) => fn(list)),
  onToggleStats: (fn) => ipcRenderer.on('toggle-stats', () => fn()),
});
