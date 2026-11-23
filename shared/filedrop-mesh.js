// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files sent in Multi-device (Windows and Linux): one FileDrop (windows|linux/filedrop.js) per connected
// device, on a link scoped to it, the sending side of shared/files-mesh.js.
//
// On the facade one FileDrop followed the selected device: crossing to another device selects it, and
// the facade's 'closed' aborted every file on its way ("{Name} disconnected", the rest kept as cut off)
// although nothing disconnected; and what was still queued would have gone on to the device selected
// next. Here each device's sends stay with it: a pointer crossing mid-send changes nothing.
//
// Files › Send files waiting (shared/outbox.js) stays one list, kept in one file: each entry names its
// device, and each FileDrop's outbox is a view of it bound to its own device (_outboxOf).
//
// The set is also the single fileDrop the rest of the app grew up with: Send files, a batch (Send to,
// ReZume, a phone) and the Monitor 2 drop go to the selected device; a drag to the device it crosses to
// (selected by kvm.js before prepareDrag); pause and cancel to the device sending; view() merges them.
// onBatchProgress gets the batch with `to`: the device it goes to.
'use strict';

const crypto = require('crypto');
const { Outbox } = require('./outbox.js');

class FileDropSet {
  // hub: hub.js (scoped, on 'peerAdded', sessions, _connectedIds, selectedId); FileDrop: the platform's
  // class; make(link, id, outbox) -> a FileDrop on that link with that outbox; outboxFile; settings.
  constructor({ hub, FileDrop, make, outboxFile = null, settings }) {
    Object.assign(this, { hub, FileDrop, make, settings });
    this.byId = new Map(); // device id -> FileDrop
    this.cb = { onBatchProgress: null };
    this.dragUnit = null; // the FileDrop of the drag going on
    this.for = null; // the device the outbox acts for right now (_with), else the selected one
    this.outbox = new Outbox({
      file: outboxFile,
      hours: () => ((settings && settings.files) || {}).outboxHours,
      peer: () => this._peer(this.for || hub.selectedId),
      send: (e) => this._sendEntry(e),
    });
    hub.on('peerAdded', (id) => this._ensure(id));
    for (const id of hub._connectedIds()) this._ensure(id);
  }

  _peer(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return s && s.connected ? { id, name: s.displayName() } : null;
  }

  // A device, connected or not (what a cut-off batch is kept for).
  _named(id) {
    const s = this.hub.sessions.get(id);
    return { id, name: s ? s.displayName() : '' };
  }

  _with(id, fn) {
    const was = this.for;
    this.for = id;
    try { return fn(); } finally { this.for = was; }
  }

  // An outbox entry, for the device it's for now (connected(), add(), resume()).
  _sendEntry(e) {
    const u = this.byId.get(this.for || this.hub.selectedId);
    if (!u) return false;
    return !!(e.list ? u.sendList(e.list, 'send', crypto.randomUUID(), { cont: e.cont, name: e.name }) : u.sendBatch(e.paths, 'send'));
  }

  // The outbox as one FileDrop sees it: everything it adds or keeps is for its device.
  _outboxOf(id) {
    const set = this;
    return {
      add: (paths) => set._with(id, () => set.outbox.add(paths)),
      keep: (list, o) => set.outbox.keep(list, { ...o, peer: (o && o.peer) || set._named(id) }),
      connected: () => set._with(id, () => set.outbox.connected()),
      resume: (x) => set.resume(x),
      remove: (x) => set.outbox.remove(x),
      on: (event, fn) => set.outbox.on(event, fn),
      get view() { return set.outbox.view; },
      get last() { return set.outbox.last; },
    };
  }

  // Kept when the device goes: the scoped link is bound to its id and hears it again when it's back.
  _ensure(id) {
    if (!id) return;
    let u = this.byId.get(id);
    if (!u) {
      u = this.make(this.hub.scoped(id), id, this._outboxOf(id));
      u.peer = () => this._named(id); // whom its batches are for (pause, cut off)
      u.onBatchProgress = (b) => this.cb.onBatchProgress && this.cb.onBatchProgress({ ...b, to: id });
      this.byId.set(id, u);
    }
    // Its link's own 'welcome' went before it was made: what waits for it goes now.
    setImmediate(() => this._with(id, () => this.outbox.connected()));
  }

  get units() {
    return [...this.byId.values()];
  }

  get selected() {
    return this.byId.get(this.hub.selectedId) || null;
  }

  // The FileDrop that sends to a device (fclip-mesh.js: a paste it asked for).
  unit(id) {
    if (!this.byId.has(id) && this._peer(id)) this._ensure(id);
    return this.byId.get(id) || null;
  }

  // ---- the single fileDrop API ----

  send(paths) {
    const u = this.selected;
    return u ? u.send(paths) : this.outbox.add(paths); // nothing selected: kept for the device last connected
  }

  sendBatch(...args) { const u = this.selected; return u ? u.sendBatch(...args) : null; }
  drop(...args) { const u = this.selected; if (u) u.drop(...args); }
  plan(paths) { return this.FileDrop.prototype.plan(paths); }

  prepareDrag(paths) {
    this.dragUnit = this.selected; // kvm.js selected the device it crosses to
    return this.dragUnit ? this.dragUnit.prepareDrag(paths) : null;
  }

  beginDrag(d) { if (this.dragUnit) this.dragUnit.beginDrag(d); }
  cancelRelease() { if (this.dragUnit) this.dragUnit.cancelRelease(); }

  pause(batch) { return this.units.some((u) => u.batches.has(batch) && u.pause(batch)); }
  cancel() { for (const u of this.units) u.cancel(); }
  forget(id) { this.outbox.remove(id); }

  // Paused files go on: to their device, if it's connected.
  resume(id) {
    if (!this.outbox.resume(id)) return false;
    for (const x of this.hub._connectedIds()) this._with(x, () => this.outbox.flush());
    return true;
  }

  get last() {
    let best = null;
    for (const u of this.units) if (u.last && (!best || (u.last.at || 0) > (best.at || 0))) best = u.last;
    return best;
  }

  set last(v) { for (const u of this.units) u.last = v; }
  set onBatchProgress(fn) { this.cb.onBatchProgress = fn; }

  // The Files page: what the selected device's FileDrop sends, else any that sends; the outbox; the newest result.
  view() {
    const views = this.units.map((u) => [u, u.view()]);
    const busy = views.find(([u, v]) => u === this.selected && (v.current || v.batch)) || views.find(([, v]) => v.current || v.batch);
    const v = busy ? busy[1] : { current: null, batch: null };
    return {
      current: v.current,
      batch: v.batch,
      queued: views.reduce((n, [, x]) => n + x.queued, 0),
      outbox: this.outbox.view,
      outboxPeer: this.outbox.last ? this.outbox.last.name : '',
      last: this.last,
    };
  }
}

module.exports = { FileDropSet };
