// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A Wayland GPU crash loop leaves TwinDesk with no window: on some drivers (Mesa 26 on AMD,
// "Cannot create bo with format= RGBA_8888 and usage=SCANOUT") the GPU process dies as soon as
// it starts, the page never reaches 'ready-to-show', and a window made with show: false stays
// hidden while the app itself keeps running in the background. After a few GPU crashes in a row,
// start again through XWayland (--ozone-platform=x11), where the same driver draws it fine.
// Once only: if the fallback launch crashes too, the next start is the user's to make.
'use strict';

const WINDOW_MS = 15000; // crashes closer together than this are one loop
const LIMIT = 2; // GPU restarts a healthy start does not have
const BAD = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);

// start(app) as early as possible, before app.whenReady(). Leaves an explicit X11 choice,
// --disable-gpu and a machine without XWayland alone.
function start(app) {
  if (app.commandLine.getSwitchValue('ozone-platform') === 'x11') return;
  if (app.commandLine.hasSwitch('disable-gpu')) return;
  if (app.commandLine.hasSwitch('twindesk-gpu-fallback')) return; // fell back once already
  if (!process.env.DISPLAY) return; // Wayland only: no XWayland to fall back to

  let crashes = [];
  let stopping = false;
  app.on('before-quit', () => { stopping = true; });
  app.on('child-process-gone', (_event, details) => {
    if (stopping || !details || details.type !== 'GPU' || !BAD.has(details.reason)) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t <= WINDOW_MS).concat(now);
    if (crashes.length < LIMIT) return;
    console.warn(`[gpu] ${crashes.length} crashes in ${WINDOW_MS / 1000}s: starting again through XWayland`);
    // process.execPath is inside an AppImage's mount, which goes away with this process:
    // start the AppImage file again (APPIMAGE), else the Electron binary (dev, deb, rpm).
    app.relaunch({
      execPath: process.env.APPIMAGE || process.execPath,
      args: process.argv.slice(1).concat(['--ozone-platform=x11', '--twindesk-gpu-fallback']),
    });
    app.exit(0);
  });
}

module.exports = { start };
