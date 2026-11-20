// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { powerMonitor } = require('electron');
const { countdownPrompt } = require('../shared/proximity-lock-prompt.js');
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
    prompt: countdownPrompt({ i18n, messageKey: 'Mac locks in {seconds} s', isUnlocked: consoleUnlocked }),
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
