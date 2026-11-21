// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const path = require('path');
const { BrowserWindow, nativeTheme, screen } = require('electron');

function countdownPrompt({ i18n, messageKey, isUnlocked, wayland = false }) {
  let win = null;
  let loading = null;
  const message = (seconds) => i18n.t(messageKey, { seconds }).replace(/(\d) (?=\S)/g, '$1\u00a0');
  return {
    show({ seconds, cancel, ready }) {
      try {
        const width = 360, height = 102, margin = 12;
        const area = !wayland && screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const title = i18n.t('Phone disconnected');
        const w = win = new BrowserWindow({
          ...(area ? { x: area.x + area.width - width - margin, y: area.y + margin } : {}), width, height,
          show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
          fullscreenable: false, skipTaskbar: true, focusable: true, title,
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#252527' : '#ffffff',
          webPreferences: { preload: path.join(__dirname, 'preload-proximity-lock.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        if (!wayland) {
          w.setAlwaysOnTop(true, 'pop-up-menu');
          w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        w.setContentProtection(true);
        for (const event of ['closed', 'hide', 'minimize', 'unresponsive']) w.on(event, cancel);
        const wc = w.webContents;
        wc.on('render-process-gone', cancel);
        wc.on('preload-error', cancel);
        wc.on('before-input-event', (e, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        });
        wc.ipc.on('proximity-lock:cancel', cancel);
        wc.ipc.once('proximity-lock:ready', () => {
          if (win !== w || w.isDestroyed()) return;
          if (!isUnlocked()) return cancel();
          const shown = () => {
            if (win !== w || w.isDestroyed() || !w.isVisible() || (wayland && !isUnlocked())) return cancel();
            clearTimeout(loading);
            if (wayland) w.once('blur', cancel);
            ready();
          };
          try {
            if (wayland) {
              // The Wayland compositor controls placement and activation. Start only when it gives us focus.
              w.once('focus', shown);
              w.show();
            } else {
              w.showInactive();
              shown();
            }
          } catch {
            cancel();
          }
        });
        loading = setTimeout(cancel, 5000);
        w.loadFile(path.join(__dirname, 'proximity-lock.html'), {
          query: { lang: i18n.locale, title, remaining: message(seconds), cancel: i18n.t('Cancel') },
        }).catch(cancel);
      } catch {
        cancel();
      }
    },
    update(seconds) {
      if (win && !win.isDestroyed()) win.webContents.send('proximity-lock:tick', message(seconds));
    },
    hide() {
      clearTimeout(loading);
      const w = win;
      win = null;
      if (w && !w.isDestroyed()) w.destroy();
    },
  };
}

module.exports = { countdownPrompt };
