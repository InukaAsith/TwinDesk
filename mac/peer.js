// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The one-to-one API the features have always used, over a hub route (hub.js): `current`, send(ctx,
// msg), sendToClient(msg), inject(msg), keySwap(settings), and the events 'client', 'closed', 'rtt',
// 'message' and 't:<type>'. Role swapping (this Mac is the non-native role when it is a guest of the
// other computer) lives in session.js now, as it did here for the one peer.
//
// Two routes: hub.facade (the SELECTED device: files, screen, terminal, apps, ...) and the phone
// route (hub.phoneRoute(): the phone whichever computer is selected, see phone.js and friends).
'use strict';

const P = require('../shared/protocol.js');

class Peer {
  // route: a Route from hub.js; server: the Server (server.js), for what the phone code reads from it.
  constructor(route, server = null) {
    this.route = route;
    this.server = server;
  }

  // The device's client object ({deviceId, name, os, role, address, rttMs, lastRx, authed, ws}) or null.
  get current() {
    return this.route.current;
  }

  get sameOs() {
    const c = this.current;
    return !!c && c.os === P.OS.MAC;
  }

  // Ctrl/Cmd swap for keys from the peer (never between two Macs).
  keySwap(settings) {
    const c = this.current;
    return settings.keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.MAC, c && c.os);
  }

  // The ctx argument is kept for the callers; a route has exactly one device.
  // Through Bluetooth, files wait for Wi-Fi (netlink.js): `hold` takes them, sendNow sends them later.
  send(ctx, msg) {
    if (!ctx) return false;
    return this.route.send(msg);
  }

  sendNow(msg) {
    return this.route.sendNow(msg);
  }

  // Disconnect, whichever side opened the session: a device connected to us doesn't come back by
  // itself (released); as a guest we don't reconnect until Connect.
  disconnect() {
    const s = this.route.session;
    if (!s) return;
    if (s.hostUp && this.server) return this.server.release(s.ctx);
    if (s.link) s.link.disconnect();
  }

  get hold() {
    return this.route.hold || null;
  }

  set hold(fn) {
    this.route.hold = fn;
  }

  get tap() {
    return this.route.tap || null;
  }

  set tap(fn) {
    this.route.tap = fn;
  }

  sendToClient(msg) {
    return this.route.send(msg);
  }

  // A message as if the device had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    this.route.inject(msg);
  }

  on(event, fn) {
    this.route.on(event, fn);
    return this;
  }

  once(event, fn) {
    this.route.once(event, fn);
    return this;
  }

  off(event, fn) {
    this.route.off(event, fn);
    return this;
  }

  emit(event, ...args) {
    return this.route.emit(event, ...args);
  }

  listenerCount(event) {
    return this.route.listenerCount(event);
  }

  setMaxListeners(n) {
    this.route.setMaxListeners(n);
    return this;
  }
}

module.exports = { Peer };
