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
//   onHub(hub, { make(link, id) → DevCtl, local }): Windows and Linux; a DevCtl per device on its own
//     link (shared/scoped-link.js)
//   Events: 'change', 'outdated' (as DevCtl's).
'use strict';

const { EventEmitter } = require('events');
const { eachDevice } = require('./scoped-link.js');

class DevCtlSet extends EventEmitter {
  constructor({ selectedId, make, local = null }) {
    super();
    Object.assign(this, { selectedId, make, local });
    this.byId = new Map(); // device id -> DevCtl
    this._onStop = () => { for (const d of this.byId.values()) d._sendState(true); }; // ringing stopped by itself: everyone hears it
    if (local) local.onStop = this._onStop;
  }

  ensure(id, make = this.make) {
    if (!id || this.byId.has(id)) return this.byId.get(id) || null;
    const d = make(id);
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

function onHub(hub, { make, local = null }) {
  const set = new DevCtlSet({ selectedId: () => hub.selectedId, local, make: () => null });
  eachDevice(hub, (id, link) => set.ensure(id, () => make(link, id)));
  return set;
}

module.exports = { DevCtlSet, devCtlSet: (opts) => new DevCtlSet(opts), onHub };
