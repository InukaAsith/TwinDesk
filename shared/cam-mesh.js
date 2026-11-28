// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device camera, step 3 of docs/mesh-graph.md (camera: one per provider, one per receiver; the
// device using it decides). The Camera tab ran on the facade, the selected device: a computer that wasn't
// selected couldn't open this one's camera (its cam.open was dropped), only the selected one heard whether
// it's shared, and a crossing that changed the selection mid-call ended the call. Here the camera's link
// stays with its device while the camera runs either way, goes to a computer that opens this one's camera
// while it's free, and otherwise follows the selection (the tab views the selected computer's camera).
// Whether this camera is shared is told to every connected computer.
//
// Windows and Linux: camLink(hub, cam) → a sticky link (hub.sticky) for CamShare's `link`.
// Mac: camRoute(hub, cam) → a route (hub.route) for a Peer.
// Both before the CamShare is made, so a cam.open is steered before CamShare hears it. cam(): the CamShare.
'use strict';

const P = require('./protocol.js');

const T = P.T;

function isComputer(hub, id) {
  const s = id ? hub.sessions.get(id) : null;
  return !!s && s.connected && !P.isPhoneOs(s.peerOs);
}

function nameOf(hub, id) {
  const s = id ? hub.sessions.get(id) : null;
  return s ? s.displayName() : String(id || '').slice(0, 8);
}

// The camera runs with its device: ours going there, or theirs in our window.
function busyOf(cam) {
  const c = cam();
  return !!c && (!!(c.sender && c.sender.status) || !!c.viewer);
}

// A cam.open from a computer the camera isn't with. True: take the camera there; else it's told why not.
function steer(hub, cam, at, from, log) {
  if (from === at || !isComputer(hub, from)) return false;
  if (busyOf(cam)) {
    hub.bus.send(from, { t: T.CAM_STATE, status: 'failed', error: `the camera is in use with ${nameOf(hub, at)}` });
    log(`[camera] ${nameOf(hub, from)} asked for this camera: in use with ${nameOf(hub, at)}`);
    return false;
  }
  log(`[camera] ${nameOf(hub, from)} opens this camera: the camera goes with it`);
  return true;
}

// Whether this camera is shared, to the connected computers the link isn't on (the link's own device hears
// it from CamShare). After CamShare's own sendPolicy.
function tellOthers(hub, cam, at, only = null) {
  const c = cam();
  if (!c) return;
  const msg = { t: T.CAM_POLICY, share: c.share };
  for (const id of only ? [only] : hub._connectedIds()) {
    if (id !== at && isComputer(hub, id)) hub.bus.send(id, msg);
  }
}

// Wraps the CamShare's sendPolicy so every computer hears it, and tells a computer that comes.
function shareWithAll(hub, cam, at) {
  const c = cam();
  const own = c.sendPolicy.bind(c);
  c.sendPolicy = () => {
    own();
    tellOthers(hub, cam, at());
  };
  hub.on('peerAdded', (id) => tellOthers(hub, cam, at(), id));
}

function camLink(hub, cam, log = (...a) => console.log(...a)) {
  const busy = () => busyOf(cam);
  const link = hub.sticky(busy, { remember: ['cam.policy'] }); // whether that computer shares its camera
  hub.bus.on(T.CAM_OPEN, (m, from) => {
    if (steer(hub, cam, link.id, from, log)) link.moveTo(from);
  });
  // After any change: free again, it goes back to the selection. Later, never inside a move (a move's
  // 'closed' changes the camera's state too).
  let queued = false;
  link.settle = () => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (!busy()) link.follow();
    });
  };
  link.shareWithAll = () => shareWithAll(hub, cam, () => link.id);
  return link;
}

function camRoute(hub, cam, log = (...a) => console.log(...a)) {
  const busy = () => busyOf(cam);
  let asked = null; // the computer that opened this camera, until the camera is free again
  let route = null; // hub.route() picks once before it returns
  route = hub.route((h) => {
    if (busy() && route && route.targetId && isComputer(h, route.targetId)) return route.targetId;
    if (asked && isComputer(h, asked)) return asked;
    return h.selectedId;
  }, { remember: ['cam.policy'] }); // whether that computer shares its camera
  hub.bus.on(T.CAM_OPEN, (m, from) => {
    if (!steer(hub, cam, route.targetId, from, log)) return;
    asked = from;
    route.refresh();
  });
  let queued = false;
  route.settle = () => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (busy()) return;
      asked = null;
      route.refresh();
    });
  };
  route.shareWithAll = () => shareWithAll(hub, cam, () => route.targetId);
  return route;
}

module.exports = { camLink, camRoute, busyOf };
