// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files received in Multi-device (Windows and Linux): one FileRecv and one DragRecv (windows|linux/
// filerecv.js, dragrecv.js) per connected device, on a link scoped to it (hub.scoped(id)), as the
// screen and sound sets have (windows/mesh/pcscreenset.js, shared/sound-mesh.js).
//
// On the facade they heard only the selected device: a drag, a Send files batch or a paste from the
// computer driving this one was dropped unless it was the selected one too, which on the driven side
// it isn't (crossing selects on the driver only), and every answer went to the selected device. Here
// each device's offers, pieces and cancels reach its own receivers and their answers go back to it.
//
// The set is also the single receiver the rest of the app grew up with (fileRecv, dragRecv): what
// the pointer does (onRelease, onHome, dragging, cancel) goes to the device driving us, else to all;
// a paste we asked for (expectBatch, startPaste) to the selected device, whom fileclip.js asked; askedSends and
// clearing `last` to all; view() and `last` are the newest. The callbacks (onBatch, onBatchProgress,
// onPasted) get the batch with `from`: the device it came from.
'use strict';

class FilesSet {
  // hub: hub.js (scoped, on 'peerAdded', _connectedIds, selectedId); make(link, id) -> {fileRecv, dragRecv}
  // partner() -> the device driving this computer, or null.
  constructor({ hub, make, partner = () => null }) {
    Object.assign(this, { hub, make, partner });
    this.byId = new Map(); // device id -> {fileRecv, dragRecv}
    this.cb = { onBatch: null, onBatchProgress: null, onPasted: null };
    hub.on('peerAdded', (id) => this._ensure(id));
    for (const id of hub._connectedIds()) this._ensure(id);
    this.fileRecv = this._fileFacade();
    this.dragRecv = this._dragFacade();
  }

  // Kept when the device goes: the scoped link is bound to its id and hears it again when it's back.
  _ensure(id) {
    if (!id || this.byId.has(id)) return;
    const u = this.make(this.hub.scoped(id), id);
    // A paste Windows copies itself (dragrecv.js) skips filerecv.js: the same device's.
    if (u.dragRecv._pasteOf) u.fileRecv.claims = (m) => u.dragRecv._pasteOf(m);
    const tag = (fn) => (b) => this.cb[fn] && this.cb[fn](b && typeof b === 'object' ? Object.assign(b, { from: id }) : b);
    u.fileRecv.onBatch = tag('onBatch');
    u.fileRecv.onBatchProgress = tag('onBatchProgress');
    u.dragRecv.onPasted = tag('onPasted');
    this.byId.set(id, u);
  }

  get units() {
    return [...this.byId.values()];
  }

  // The device driving us when it has receivers, else every one (each does nothing without a drag or
  // a release of its own).
  _pointer() {
    const u = this.byId.get(this.partner());
    return u ? [u] : this.units;
  }

  _newest(pick) {
    let best = null;
    for (const u of this.units) {
      const l = pick(u).last;
      if (l && (!best || (l.at || 0) > (best.at || 0))) best = l;
    }
    return best;
  }

  _fileFacade() {
    const set = this;
    return {
      onRelease: () => Promise.all(set._pointer().map((u) => u.fileRecv.onRelease())),
      askedSends: (ms) => { for (const u of set.units) u.fileRecv.askedSends(ms); },
      // A paste or a file we asked the selected device for (fileclip.js, the phone's Save): its batch.
      expectBatch: (...args) => { const u = set.byId.get(set.hub.selectedId); if (u) u.fileRecv.expectBatch(...args); },
      get last() { return set._newest((u) => u.fileRecv); },
      set last(v) { for (const u of set.units) u.fileRecv.last = v; },
      set onBatch(fn) { set.cb.onBatch = fn; },
      set onBatchProgress(fn) { set.cb.onBatchProgress = fn; },
      view: () => ({ receiving: set.units.reduce((n, u) => n + u.fileRecv.view().receiving, 0), last: set._newest((u) => u.fileRecv) }),
    };
  }

  _dragFacade() {
    const set = this;
    return {
      onRelease: () => { for (const u of set._pointer()) u.dragRecv.onRelease(); },
      onHome: () => { for (const u of set.units) u.dragRecv.onHome(); },
      get dragging() { return set.units.some((u) => u.dragRecv.dragging); },
      cancel: (...args) => { for (const u of set.units) if (u.dragRecv.dragging) u.dragRecv.cancel(...args); },
      get last() { return set._newest((u) => u.dragRecv); },
      set last(v) { for (const u of set.units) u.dragRecv.last = v; },
      set onPasted(fn) { set.cb.onPasted = fn; },
      // A paste Windows copies itself (fileclip.js asked the selected device for it): that device's.
      startPaste: (...args) => { const u = set.byId.get(set.hub.selectedId); return !!u && !!u.dragRecv.startPaste && u.dragRecv.startPaste(...args); },
      _pasteOf: (m) => set.units.some((u) => u.dragRecv._pasteOf && u.dragRecv._pasteOf(m)),
      // The drag going on (any device's), else the newest result.
      view: () => {
        const busy = set.units.map((u) => u.dragRecv.view()).find((v) => v.state);
        return busy || { state: '', last: set._newest((u) => u.dragRecv) };
      },
    };
  }
}

module.exports = { FilesSet };
