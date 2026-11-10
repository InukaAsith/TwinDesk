// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// One mesh feature’s route: a target device picked by hub, events like the one-to-one link API.
'use strict';

const { EventEmitter } = require('events');

// What a feature sees of its device: the one-to-one "client" object (role 'guest' = it connected to
// this computer, 'host' = this computer is its guest).
function viewOf(s) {
  if (!s) return null;
  const c = s.hostUp ? s.ctx : null;
  return {
    deviceId: s.id,
    name: s.displayName(),
    os: s.peerOs,
    role: s.role,
    transport: s.transport,
    address: c ? c.address : (s.link && s.link.pairing ? s.link.pairing.address : ''),
    rttMs: s.status.rtt != null ? s.status.rtt : (c ? c.rttMs : null),
    lastRx: s.lastRx,
    authed: true,
    ws: c ? c.ws : (s.link ? s.link.ws : null),
    ice: c ? c.ice : null,
  };
}

// Events: 'client' (view), 'closed' (view), 'rtt' (view), 't:<type>' (msg, view), 'message' (msg, view).
class Route extends EventEmitter {
  constructor(hub, pick) {
    super();
    this.hub = hub;
    this.pick = pick;
    this.targetId = null;
    this.lastView = null;
    this.stateFns = [];
  }

  get session() {
    return this.targetId ? this.hub.sessions.get(this.targetId) : null;
  }

  get current() {
    return viewOf(this.session);
  }

  refresh() {
    const want = this.pick(this.hub);
    const s = want ? this.hub.sessions.get(want) : null;
    const next = s && s.connected ? want : null;
    if (next === this.targetId) {
      this._stateChanged();
      return;
    }
    this.drop();
    if (next) {
      this.targetId = next;
      this.lastView = viewOf(this.hub.sessions.get(next));
      this.emit('client', this.lastView);
    }
    this._stateChanged();
  }

  drop(id) {
    if (!this.targetId || (id && id !== this.targetId)) return;
    const v = this.lastView || {};
    this.targetId = null;
    this.lastView = null;
    this.emit('closed', v);
  }

  deliver(msg) {
    const s = this.session;
    if (!s) return false;
    if (this.tap) this.tap(msg);
    const v = viewOf(s);
    this.emit(`t:${msg.t}`, msg, v);
    this.emit('message', msg, v);
    return true;
  }

  rtt(id) {
    if (id !== this.targetId) return;
    this.emit('rtt', viewOf(this.session));
  }

  send(obj) {
    if (this.hold && this.hold(obj)) return true;
    return this.sendNow(obj);
  }

  sendNow(obj) {
    const s = this.session;
    return !!s && s.send(obj) === true;
  }

  inject(msg) {
    const s = this.session;
    if (s && s.connected) this.deliver(msg);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  _stateChanged() {
    for (const fn of this.stateFns) fn();
  }
}

module.exports = { Route, viewOf };
