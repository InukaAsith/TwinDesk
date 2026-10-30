// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What "Connect by address" does with one discovered device (or a bare address).
// Pure: ipc.js applies the result (invite, dial, pair). A computer that dials us is in
// `pairedIds`. A computer this Mac dials is in `hosts`, whatever its OS.
'use strict';

const P = require('../shared/protocol.js');

function pendingOf(id, name, address) {
  return id ? { id, name: name || '', address: address || '' } : null;
}

// dev: discovery device or null (the address did not answer). hosts: [{id, name, address, port}].
// pairedIds: device ids that pair with this Mac and dial it.
function planConnect({ dev = null, address = '', pairedIds = [], hosts = [] } = {}) {
  const paired = new Set(pairedIds);
  const host = (dev && dev.id && hosts.find((h) => h.id === dev.id))
    || (!dev && address && hosts.find((h) => h.address === address))
    || null;

  // Already paired with us: a phone is opened, any other computer is invited and dials us.
  if (dev && paired.has(dev.id)) {
    if (dev.os === P.OS.ANDROID) return { action: 'phone', id: dev.id };
    return {
      action: 'invite',
      expect: true,
      id: dev.id,
      address: dev.address,
      name: dev.name,
      inviting: false,
      pending: pendingOf(dev.id, dev.name, dev.address),
      message: `Connecting to ${dev.name}…`,
    };
  }

  // We are its guest (a Mac, Windows or Linux host). Dial it. Checked before the
  // "ask a PC to connect" path, which is only for a computer we have not paired with.
  if (host && (!dev || dev.os !== P.OS.ANDROID)) {
    const name = (dev && dev.name) || host.name || address;
    const addr = (dev && dev.address) || host.address || address;
    return {
      action: 'dial',
      id: host.id,
      address: addr,
      port: (dev && dev.port) || host.port,
      name,
      pending: pendingOf(host.id, name, addr),
      message: `Connecting to ${name}…`,
    };
  }

  if (dev && dev.os !== P.OS.MAC) {
    return {
      action: 'invite',
      expect: false,
      id: dev.id,
      address: dev.address,
      name: dev.name,
      inviting: dev.os === P.OS.ANDROID,
      pending: pendingOf(dev.id, dev.name, dev.address),
      message: `Asked ${dev.name} to connect. Confirm on ${dev.name}.`,
    };
  }

  return {
    action: 'pair',
    address: dev ? dev.address : address,
    port: dev ? dev.port : undefined,
    name: dev ? dev.name : address,
  };
}

// The session of the device we just asked for is up: the Overview hint can go.
// Returns the next connect state, or null when this client is not the one we asked.
function settleConnect(connect, client) {
  const id = client && (client.deviceId || client.id);
  if (!connect || !id) return null;
  const pendingHit = !!(connect.pending && connect.pending.id === id);
  const inviteHit = !!(connect.inviting && connect.inviting.id === id);
  if (!pendingHit && !inviteHit) return null;
  return { busy: false, message: '', error: false, pending: null, inviting: null };
}

// True when `id` already has a live session, so Connect by address must not cover it with a pending hint.
function sessionIsUp(id, { current = null, clients = [], guest = null, authedHostIds = [] } = {}) {
  if (!id) return false;
  const same = (x) => !!(x && (x.deviceId === id || x.id === id));
  if (same(current) || same(guest)) return true;
  for (const c of clients) if (same(c)) return true;
  return authedHostIds.includes(id);
}

module.exports = { planConnect, settleConnect, sessionIsUp };
