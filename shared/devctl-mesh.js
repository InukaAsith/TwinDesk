// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview's controls in Multi-device (step 5 of docs/mesh-graph.md): a DevCtl (devctl.js) per device, each
// on that device's own link. On the facade one DevCtl followed the selected device: another device's
// Overview couldn't ring, lock or read this computer unless this computer had it selected (its dev.do and
// dev.state were dropped), and a crossing ended a ring it had started (the facade's 'closed').
//
// Each device's DevCtl answers its dev.do and keeps it told of this computer's state; the Overview (view,
// do, look) is the selected device's. One DevLocal is shared: a ring stops when the device that rang goes.
//
//   devCtlSet({ selectedId(), make(id) → DevCtl, local })
//     ensure(id)   a device that connected (or is known): its DevCtl, made once and kept
//     view / app / do(cmd) / look() / local: the single DevCtl API, for the selected device
//   onHub(hub, { make(link, id) → DevCtl, local }): Windows and Linux; a DevCtl per device on
//     hub.scoped(id) (with current, and its 'welcome' again: the hub's went before the DevCtl listened)
//   Events: 'change', 'outdated' (as DevCtl's).
'use strict';

const { EventEmitter } = require('events');

class DevCtlSet extends EventEmitter {
  constructor({ selectedId, make, local = null }) {
    super();
    Object.assign(this, { selectedId, make, local });
    this.byId = new Map(); // device id -> DevCtl
    this._onStop = () => { for (const d of this.byId.values()) d._sendState(true); }; // ringing stopped by itself: everyone hears it
    if (local) local.onStop = this._onStop;
  }

  ensure(id) {
    if (!id || this.byId.has(id)) return this.byId.get(id) || null;
    const d = this.make(id);
    if (this.local) this.local.onStop = this._onStop; // a DevCtl made without sharedLocal takes it for itself
    d.on('change', () => this.emit('change'));
    d.on('outdated', (o) => this.emit('outdated', o));
    this.byId.set(id, d);
    return d;
  }

  get selected() {
    return this.byId.get(this.selectedId()) || null;
  }

  get view() {
    const d = this.selected;
    return d ? d.view : null;
  }

  get app() {
    const d = this.selected;
    return d ? d.app : null;
  }

  do(cmd) {
    const d = this.selected;
    return d ? d.do(cmd) : undefined;
  }

  look() {
    const d = this.selected;
    if (d) d.look();
  }

  stop() {
    for (const d of this.byId.values()) d.stop();
  }
}

// hub.scoped(id) with what DevCtl reads besides: current ({deviceId, name, os}), and welcome() to give
// a DevCtl made after its device's 'welcome' that welcome.
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
    get: () => { const x = hub.sessions.get(id); return x && x.connected ? { deviceId: id, name: x.displayName(), os: x.peerOs } : null; },
  });
  return link;
}

function onHub(hub, { make, local = null }) {
  const links = new Map();
  const set = new DevCtlSet({
    selectedId: () => hub.selectedId, local,
    make: (id) => { const l = scopedLink(hub, id); links.set(id, l); return make(l, id); },
  });
  const up = (id) => {
    const had = set.byId.has(id);
    set.ensure(id);
    if (!had) links.get(id).welcome();
  };
  hub.on('peerAdded', up);
  for (const id of hub._connectedIds()) up(id);
  return set;
}

module.exports = { DevCtlSet, devCtlSet: (opts) => new DevCtlSet(opts), onHub, scopedLink };
