// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { BrowserWindow, nativeTheme, powerMonitor, screen } = require('electron');
const { DevLocal } = require('../shared/devlocal.js');
const { ProximityLock, isAuthenticatedPhone } = require('../shared/proximity-lock.js');

function consoleUnlocked() {
  // Electron's lock notifications don't describe a lock that predates app startup.
  try {
    if (fs.statSync('/dev/console').uid !== process.getuid()) return false;
    const info = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1'], { encoding: 'utf8', timeout: 300 });
    return /^\s*"IOConsoleLocked" = No\s*$/m.test(info) && !/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(info);
  } catch {
    return false;
  }
}

function countdownPrompt(i18n) {
  let win = null;
  const message = (seconds) => i18n.t('Mac locks in {seconds} s', { seconds });
  return {
    show({ seconds, cancel, ready }) {
      try {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const width = 360, height = 102, margin = 12;
        const title = i18n.t('Phone disconnected');
        const w = win = new BrowserWindow({
          x: area.x + area.width - width - margin, y: area.y + margin, width, height,
          show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
          fullscreenable: false, skipTaskbar: true, focusable: true, title,
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#252527' : '#ffffff',
          webPreferences: { preload: path.join(__dirname, 'preload-proximity-lock.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        w.setAlwaysOnTop(true, 'pop-up-menu');
        w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        w.setContentProtection(true);
        w.on('closed', cancel);
        w.on('hide', cancel);
        w.on('unresponsive', cancel);
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
          if (!consoleUnlocked()) return cancel();
          w.showInactive();
          if (w.isVisible()) ready();
          else cancel();
        });
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
      const w = win;
      win = null;
      if (w && !w.isDestroyed()) w.destroy();
    },
  };
}

function installProximityLock({ server, pairing, settings, i18n, getHelper, occupied }) {
  let awake = true, screenLocked = false, activeSession = true;
  const devLocal = new DevLocal({
    // Reuse the Deck's immediate native lock. pmset displaysleepnow can leave a password delay.
    macLock: () => getHelper().request('deckSys', { what: 'lock' }),
  });
  const paired = (ctx) => pairing.list().some((p) => p.id === ctx.deviceId && p.os === ctx.os);
  // Pairing has already checked the token before authenticate() sets pendingId. Welcome can still be deferred.
  const replacing = (ctx) => [...server.sockets].some((candidate) =>
    !candidate.authed && candidate.pendingId === ctx.deviceId && !candidate.released && !candidate.expectedClose &&
    candidate.ws.readyState === candidate.ws.OPEN);
  const controller = new ProximityLock({
    enabled: () => settings.app.proximityLock === true,
    canLock: (ctx) => {
      if (!awake || screenLocked || !activeSession || !getHelper()?.running || occupied(ctx) || replacing(ctx) || !paired(ctx)) return false;
      try {
        const state = powerMonitor.getSystemIdleState(1);
        return state === 'active' || state === 'idle';
      } catch {
        return false;
      }
    },
    prompt: countdownPrompt(i18n),
    lock: () => {
      if (consoleUnlocked()) devLocal.do({ do: 'lock' }).catch((err) => console.error(`[proximity lock] ${err.message}`));
    },
  });
  const sessionEvents = {
    client(ctx) {
      // The raw server owns authenticated sessions. Changing the selected device cannot arm the lock.
      if (isAuthenticatedPhone(ctx) && paired(ctx)) controller.connected(ctx);
      else controller.recheck();
    },
    closed: (ctx, unexpected) => controller.disconnected(ctx, unexpected),
    forget: (id) => controller.forget(id),
    noreclaim: (id) => controller.forget(id), // one-to-one: Disconnect while reconnecting
  };
  const powerEvents = {
    suspend: () => { awake = false; },
    resume: () => { awake = true; },
    shutdown: () => { awake = false; },
    'lock-screen': () => { screenLocked = true; },
    'unlock-screen': () => { screenLocked = false; },
    'user-did-resign-active': () => { activeSession = false; },
    'user-did-become-active': () => { activeSession = true; },
  };
  const powerListeners = Object.entries(powerEvents).map(([name, change]) => [name, () => { change(); controller.reset(); }]);
  for (const [name, listener] of Object.entries(sessionEvents)) server.on(name, listener);
  for (const [name, listener] of powerListeners) powerMonitor.on(name, listener);
  return {
    cancel: () => controller.cancel(),
    forget: (id) => controller.forget(id),
    reset: () => controller.reset(),
    shutdown() {
      controller.shutdown();
      for (const [name, listener] of Object.entries(sessionEvents)) server.removeListener(name, listener);
      for (const [name, listener] of powerListeners) powerMonitor.removeListener(name, listener);
    },
  };
}

module.exports = { installProximityLock };
