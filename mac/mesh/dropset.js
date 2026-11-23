// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files received in the Mac's Multi-device: one Drop (../drop.js, its DragIn with it) per connected
// device, on a peer bound to that device (ScopedPeer, as streams.js and audioset.js), the Mac's side
// of shared/files-mesh.js.
//
// On the facade peer Drop heard only the selected device: a drag, a Send files batch or a paste from the
// computer driving this Mac was dropped unless it was the selected one too, and its answers went to the
// selected device. Here each device's offers, pieces and cancels reach its own Drop, which answers it.
//
// The set is also the single `drop` the rest of the app grew up with: what the pointer does (armDrag,
// release, dragIn.onDriven) goes to the device driving us, else to all; cancelDrag and dragIn.cancel to
// all; a paste we asked for (expectBatch) to the selected device; Recent is one list for every device;
// view merges them. Events: 'change', 'batch' (with `from`: the device it came from).
'use strict';

const { EventEmitter } = require('events');
const { ScopedPhonePeer: ScopedPeer } = require('./phones.js');

class DropSet extends EventEmitter {
  // hub: hub.js; server: the Server; make(peer) -> Drop; partner() -> the device driving this Mac, or null.
  constructor({ hub, server, make, partner = () => null }) {
    super();
    Object.assign(this, { hub, server, make, partner });
    this.byId = new Map(); // device id -> Drop
    this.recent = []; // Recent: every device's, newest first (each Drop adds to this one list)
    this.isDriven = () => false;
    this.dragIn = this._dragFacade();
    hub.bus.onPeer('welcome', (id) => this._ensure(id));
    for (const s of hub.sessions.list()) if (s.connected) this._ensure(s.id);
  }

  // Kept when the device goes: its peer is bound to its id and hears it again when it's back.
  _ensure(id) {
    if (!id || this.byId.has(id)) return;
    const peer = new ScopedPeer(this.hub, this.server, null);
    const d = this.make(peer);
    d.recent = this.recent;
    d.dragIn.isDriven = () => this.isDriven();
    d.on('change', () => this.emit('change'));
    d.on('batch', (b) => this.emit('batch', { ...b, from: id }));
    this.byId.set(id, d);
    peer.bind(id);
  }

  get units() {
    return [...this.byId.values()];
  }

  // The device driving us when it has a Drop, else every one (each does nothing without its own drag).
  _pointer() {
    const d = this.byId.get(this.partner());
    return d ? [d] : this.units;
  }

  armDrag() { for (const d of this._pointer()) d.armDrag(); }
  release() { return Promise.all(this._pointer().map((d) => d.release())); }
  cancelDrag() { for (const d of this.units) d.cancelDrag(); }
  // A paste or a file we asked the selected device for (the phone's Save as a document).
  expectBatch(...args) { const d = this.byId.get(this.hub.selectedId); if (d) d.expectBatch(...args); }
  // Photos › Save / Files › Save (#239): each Drop takes it only from that phone's session.
  allowAsked(...args) { for (const d of this.units) d.allowAsked(...args); }
  clearAsked() { for (const d of this.units) d.clearAsked(); }

  clearRecent() {
    this.recent.length = 0;
    this.emit('change');
  }

  reveal(index) {
    const d = this.units[0];
    if (d) d.reveal(index); // the one Recent list: any Drop finds the item
  }

  _dragFacade() {
    const set = this;
    return {
      onDriven: () => { for (const d of set._pointer()) d.dragIn.onDriven(); },
      cancel: () => { for (const d of set.units) d.dragIn.cancel(); },
      get dragging() { return set.units.some((d) => d.dragIn.dragging); },
      set isDriven(fn) { set.isDriven = fn; },
      get isDriven() { return set.isDriven; },
    };
  }

  get view() {
    const views = this.units.map((d) => d.view);
    const receiving = views.flatMap((v) => v.receiving).slice(0, 5);
    return {
      receiving,
      receivingMore: views.reduce((n, v) => n + v.receivingMore, 0) + Math.max(0, views.reduce((n, v) => n + v.receiving.length, 0) - receiving.length),
      inBatches: views.flatMap((v) => v.inBatches),
      recent: this.recent,
      defaultFolder: views.length ? views[0].defaultFolder : require('path').join(require('os').homedir(), 'Downloads'),
    };
  }
}

module.exports = { DropSet };
