// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's end of the session, shaped like the Mac's peer.js as mac/phone.js, phone-bridge.js
// and phoneview.js use it, so their ports here stay the same line for line: 'client' / 'closed'
// (ctx) from our server, 't:<type>' (msg, ctx) for what the peer sends, sendToClient(), inject()
// and keySwap(). Multi-device coexistence: phone can be connected while PC is also a guest/host.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

class PhoneLink extends EventEmitter {
  // link: peer.js; server: server.js (our host role)
  constructor(link, server) {
    super();
    this.link = link;
    this.raw = server;

    server.on('client', (ctx) => {
      if (ctx.os === P.OS.ANDROID) this.emit('client', ctx);
    });
    server.on('closed', (ctx) => {
      if (ctx.os === P.OS.ANDROID) this.emit('closed', ctx);
    });

    // Handle messages coming directly from the phone on our server
    server.on('message', (msg, ctx) => {
      if (ctx && ctx.os === P.OS.ANDROID) {
        this.emit(`t:${msg.t}`, msg, ctx);
      }
    });

    // Also listen on peer link for any phone messages routed through a hosting peer
    link.onAny = link.onAny || (() => {});
  }

  get current() {
    return this.raw.phone || (this.raw.current && this.raw.current.os === P.OS.ANDROID ? this.raw.current : null);
  }

  sendToClient(msg) {
    const phone = this.current;
    if (phone) {
      this.raw.send(phone, msg);
    } else if (this.link && this.link.hosting) {
      this.link.send(msg);
    }
  }

  // A message as if the peer had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    const phone = this.current;
    if (phone) {
      this.emit(`t:${msg.t}`, msg, phone);
    } else {
      this.link.inject(msg);
    }
  }

  keySwap(settings) {
    const c = this.current;
    return settings && settings.keys && settings.keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.LINUX, c && c.os);
  }
}

module.exports = { PhoneLink };
