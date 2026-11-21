// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { powerMonitor } = require('electron');
const { DevLocal } = require('./devlocal.js');
const { GROUP_NETS } = require('./netlink.js');
const { ProximityLock, isAuthenticatedPhone } = require('./proximity-lock.js');
const { countdownPrompt } = require('./proximity-lock-prompt.js');
const { watchLinuxSession } = require('./proximity-lock-linux.js');

function installProximityLock({ server, pairing, settings, i18n, occupied, onChange, local = new DevLocal() }) {
  const linux = local.os === 'linux';
  const nativeLock = local.can().lock === true;
  let awake = true, screenLocked = false, linuxSession = null;
  const supported = () => nativeLock && (!linux || linuxSession?.supported === true);
  const isUnlocked = () => {
    if (!supported() || !awake || screenLocked) return false;
    try {
      const idle = powerMonitor.getSystemIdleState(1);
      return (idle === 'active' || idle === 'idle') && (!linux || linuxSession.unlocked());
    } catch {
      return false;
    }
  };
  const paired = (ctx) => pairing.list().some((peer) => peer.id === ctx.deviceId && peer.os === ctx.os);
  const present = (ctx) => server.clients
    ? server.clients.has(ctx.deviceId) || [...server.clients.values()].some(isAuthenticatedPhone)
    : !!server.current;
  // The token has been checked, but the welcome can still be waiting for the files port.
  const replacing = (ctx) => [...server.sockets].some((candidate) =>
    !candidate.authed && candidate.pendingId === ctx.deviceId && !candidate.expectedClose && !candidate.released &&
    candidate.ws.readyState === candidate.ws.OPEN);
  const controller = new ProximityLock({
    enabled: () => settings.app.proximityLock === true,
    canLock: (ctx) => !present(ctx) && !occupied(ctx) && !replacing(ctx) && paired(ctx) && isUnlocked(),
    prompt: countdownPrompt({ i18n, messageKey: 'Computer locks in {seconds} s', isUnlocked,
      wayland: linux && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY) }),
    lock() {
      if (!isUnlocked()) return;
      local.do({ do: 'lock' }).then((result) => {
        if (result?.ok === false) console.error(`[proximity lock] ${result.err.message}`);
      }).catch((err) => console.error(`[proximity lock] ${err.message}`));
    },
  });
  const reset = () => controller.reset();
  const disarmPhones = (affected) => {
    const clients = server.clients ? server.clients.values() : [server.current];
    for (const ctx of clients) if (isAuthenticatedPhone(ctx) && affected(ctx)) controller.forget(ctx.deviceId);
  };
  if (linux && nativeLock) linuxSession = watchLinuxSession(reset, onChange);

  const sessionEvents = {
    client(ctx) {
      // Selection and transport changes never arm the lock. Only the raw authenticated session can.
      if (isAuthenticatedPhone(ctx) && paired(ctx) && isUnlocked()) controller.connected(ctx);
      else controller.recheck();
    },
    closed: (ctx, unexpected) => controller.disconnected(ctx, unexpected),
    forget: (id) => controller.forget(id),
    noreclaim: (id) => controller.forget(id),
  };
  const powerEvents = {
    suspend: () => { awake = false; reset(); },
    resume: () => { awake = true; reset(); },
    shutdown: () => { awake = false; reset(); },
    'lock-screen': () => { screenLocked = true; reset(); },
    'unlock-screen': () => { screenLocked = false; reset(); },
  };
  for (const [name, listener] of Object.entries(sessionEvents)) server.on(name, listener);
  for (const [name, listener] of Object.entries(powerEvents)) powerMonitor.on(name, listener);
  return {
    get supported() { return supported(); },
    cancel: () => controller.cancel(),
    forget: (id) => controller.forget(id),
    reset,
    bluetoothOff: () => disarmPhones((ctx) => ctx.transport === 'ble'),
    wifiDown: () => disarmPhones((ctx) => ctx.transport !== 'ble' && GROUP_NETS.some((prefix) => ctx.address?.startsWith(prefix))),
    shutdown() {
      controller.shutdown();
      linuxSession?.stop();
      for (const [name, listener] of Object.entries(sessionEvents)) server.removeListener(name, listener);
      for (const [name, listener] of Object.entries(powerEvents)) powerMonitor.removeListener(name, listener);
    },
  };
}

module.exports = { installProximityLock };
