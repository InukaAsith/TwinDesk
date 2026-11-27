// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device phone services, step 4 of docs/mesh-graph.md (phone: one per provider, one per receiver; the
// phone decides which computer, as it keeps one link). This computer takes one phone's Calls, Messages,
// Photos and Files at a time: the phone the Phone pages show (the selected device when it's a phone, else
// the active one), and the one with a call on keeps it until the call ends.
//
// PhoneHub (shared/phonehub.js) ran on a link that heard every phone and sent to the current one: a second
// phone leaving stopped the hub (its state and a call on the other phone gone), a newer phone connecting
// mid-call took the call's buttons, and the phone it left was never told, so it kept sending its calls
// and texts. Here PhoneHub hears only its phone; moving to another is 'closed' for the one it leaves,
// which is told the hub is off (hub.policy, everything false), and 'client' for the next.
//
//   hubLink({ phones, ctxOf(id), sendTo(id, msg), held() }) → the link for PhoneHub's `server`
//     phones: the link of every phone (Windows/Linux phone-link.js, the Mac's phonesLink): on('client' |
//             'closed' | 't:<type>'), current (the active phone's ctx);
//     held(): true while the hub is busy with its phone (a call). refresh() after anything that may move it.
'use strict';

const { EventEmitter } = require('events');
const P = require('./protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && P.isPhoneOs(ctx.os);

class HubLink extends EventEmitter {
  constructor({ phones, ctxOf, sendTo, held = () => false, log = (...a) => console.log(...a) }) {
    super();
    Object.assign(this, { phones, ctxOf, sendTo, held, log });
    this.id = null; // the phone it serves
    this.last = null; // its ctx when it was picked
    this.wired = new Set();
    phones.on('client', (ctx) => {
      if (isPhone(ctx) && ctx.deviceId === this.id) { this.last = ctx; this.emit('client', ctx); } // its phone again (a new session)
      else this.refresh();
    });
    phones.on('closed', (ctx) => {
      if (!ctx || ctx.deviceId !== this.id) return this.refresh(); // another phone: nothing here changes
      this.id = null;
      this.last = null;
      this.emit('closed', ctx);
      this.refresh(ctx.deviceId);
      setImmediate(() => this.refresh(ctx.deviceId)); // once the phones' link has moved on from it too
    });
    this.on('newListener', (ev) => {
      if (typeof ev !== 'string' || !ev.startsWith('t:') || this.wired.has(ev)) return;
      this.wired.add(ev);
      phones.on(ev, (m, ctx) => ctx && ctx.deviceId === this.id && this.emit(ev, m, ctx));
    });
    this.refresh();
  }

  get current() {
    return this.id ? this.ctxOf(this.id) : null;
  }

  sendToClient(msg) {
    return !!this.current && this.sendTo(this.id, msg) !== false;
  }

  // The active phone, unless its own phone is busy (and still there). gone: a phone that just left (the
  // phones' link may still list it while its 'closed' goes round).
  refresh(gone = null) {
    if (this.id && this.current && this.held()) return;
    const c = this.phones.current;
    const next = isPhone(c) && c.deviceId !== gone && this.ctxOf(c.deviceId) ? c.deviceId : null;
    if (next === this.id) return;
    const was = this.id ? this.ctxOf(this.id) || this.last : null; // gone already: as it was last seen
    this.id = next;
    this.last = next ? this.current : null;
    if (was) {
      this.log(`[phone] Calls, Messages and Photos leave ${was.name || was.deviceId} for ${next ? this.last.name || next : 'no phone'}`);
      this.sendTo(was.deviceId, { t: T.HUB_POLICY, calls: false, messages: false, media: false, files: false, bt: false }); // it stops sending them here
      this.emit('closed', was);
    }
    if (next) this.emit('client', this.last);
  }
}

module.exports = { HubLink, hubLink: (opts) => new HubLink(opts) };
