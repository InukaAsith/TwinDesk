// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's end of the session, shaped as the Mac's phone code (mac/phone.js, phone-bridge.js,
// phoneview.js) uses it: 'client' / 'closed' (ctx) for Android clients, 't:<type>' (msg, ctx) for
// what a phone sends, sendToClient(), inject(), keySwap() and `current` (the phone's server ctx).
//
// A phone is one of many devices (docs/mesh.md), so none of this depends on which device is
// selected: `current` is the phone the user selected when it is a phone, else the most recently
// authenticated phone, else null. Messages go to that phone's own session. Only a phone's messages
// reach the 't:' listeners.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const isAndroid = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;

class PhoneLink extends EventEmitter {
  // hub: hub.js (the sessions and the pooled bus); server: server.js (our host role).
  constructor(hub, server) {
    super();
    this.hub = hub;
    this.raw = server;
    this.wired = new Set();
    server.on('client', (ctx) => isAndroid(ctx) && this.emit('client', ctx));
    server.on('closed', (ctx) => isAndroid(ctx) && this.emit('closed', ctx));
    // 't:<type>' listeners: the bus delivers the type from any device; only phones get through.
    this.on('newListener', (ev) => {
      if (typeof ev !== 'string' || !ev.startsWith('t:') || this.wired.has(ev)) return;
      this.wired.add(ev);
      hub.bus.on(ev.slice(2), (m, fromId) => {
        const ctx = this.raw.clients.get(fromId);
        if (isAndroid(ctx)) this.emit(ev, m, ctx);
      });
    });
  }

  // The phone's server ctx: the selected device when it is a phone, else the most recently
  // authenticated phone, else null.
  get current() {
    const sel = this.hub.selectedId ? this.raw.clients.get(this.hub.selectedId) : null;
    if (isAndroid(sel)) return sel;
    let best = null;
    for (const c of this.raw.clients.values()) {
      if (isAndroid(c) && (!best || c.authSeq > best.authSeq)) best = c;
    }
    return best;
  }

  // To that phone's session (its role swap and checks as for any device). Nothing without a phone.
  sendToClient(msg) {
    const c = this.current;
    const s = c && this.hub.sessions.get(c.deviceId);
    if (s) s.send(msg);
  }

  // A message as if that phone had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    const c = this.current;
    const s = c && this.hub.sessions.get(c.deviceId);
    if (s) s.inject(msg);
  }

  keySwap(settings) {
    const c = this.current;
    return settings.keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.WIN, c && c.os);
  }
}

module.exports = { PhoneLink };
