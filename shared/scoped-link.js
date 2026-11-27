// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A feature per device in Multi-device (step 5 of docs/mesh-graph.md), Windows and Linux: hub.scoped(id)
// with what the one-to-one features read besides, and the hub's devices as they come.
//
//   scopedLink(hub, id)  hub.scoped(id) plus current ({deviceId, name, os, transport, address}) and welcome(): a feature made
//                        after its device's 'welcome' (the hub's 'peerAdded' comes after it) gets that one
//   eachDevice(hub, up(id, link))  up for every connected device and each one that connects, once a
//                        device: up makes the feature on link, then link.welcome() runs
'use strict';

// Where ssh and the like reach the device, as the hub's snapshot() says it for the selected one: the host
// session's address, else its guest link's.
function addressOf(x) {
  if (x.hosting && x.ctx) return x.ctx.address || '';
  const g = x.link && typeof x.link.snapshot === 'function' ? x.link.snapshot() : null;
  return (g && g.link && g.link.address) || '';
}

function scopedLink(hub, id) {
  const link = hub.scoped(id);
  const welcomes = [];
  const on = link.on.bind(link);
  link.on = (type, fn) => {
    if (type === 'welcome') welcomes.push(fn);
    on(type, fn);
  };
  link.welcome = () => { for (const fn of welcomes) fn({}); };
  Object.defineProperty(link, 'current', {
    get: () => { const x = hub.sessions.get(id); return x && x.connected ? { deviceId: id, name: x.displayName(), os: x.peerOs, transport: x.transport, address: addressOf(x) } : null; },
  });
  return link;
}

function eachDevice(hub, up) {
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const link = scopedLink(hub, id);
    up(id, link);
    link.welcome();
  };
  hub.on('peerAdded', add);
  for (const id of hub._connectedIds()) add(id);
}

module.exports = { scopedLink, eachDevice, addressOf };
