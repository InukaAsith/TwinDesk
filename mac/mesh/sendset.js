// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files sent from the Mac's Multi-device: one FileSend (../filesend.js) per connected device, on a peer
// bound to that device (ScopedPeer), the Mac's side of shared/filedrop-mesh.js.
//
// On the facade peer one FileSend followed the selected device: crossing to another device selects it,
// and the facade's 'closed' (no device for a moment) aborted every file on its way ('the other computer
// disconnected', the rest kept as cut off) although nothing disconnected. Here each device's sends stay
// with it. Send files waiting stays one list (shared/filedrop-mesh.js MeshOutbox), each entry for its
// device; Recent (sent) is one list for every device.
//
// The set is also the single fileSend the rest of the app grew up with: Send files and a batch go to the
// selected device; a drag to the device the pointer crosses to (kvm.js partner, set before startDrag);
// pause, cancelDrag and cancelSending to the device sending; sendPolicy (our drag switch) to all; view
// merges them, peerDrag is the selected device's. Events: 'change', 'policy', 'dragEnd', 'batchDone'
// (with `to`: the device it went to).
'use strict';

const { EventEmitter } = require('events');
const { MeshOutbox } = require('../../shared/filedrop-mesh.js');
const { ScopedPhonePeer: ScopedPeer } = require('./phones.js');

class SendSet extends EventEmitter {
  // hub: hub.js; server: the Server; FileSend: ../filesend.js's; getSettings; outboxFile; partner() → the
  // device the pointer is with while driving, or null.
  constructor({ hub, server, FileSend, getSettings, outboxFile = null, partner = () => null }) {
    super();
    Object.assign(this, { hub, server, FileSend, getSettings, partner });
    this.byId = new Map(); // device id -> FileSend
    this.recent = []; // Recent (sent): every device's, newest first (each FileSend adds to this one list)
    this.box = new MeshOutbox({ hub, file: outboxFile, hours: () => (getSettings().files || {}).outboxHours, senderOf: (id) => this.byId.get(id) || null });
    this.outbox = this.box.outbox;
    this.outbox.on('change', () => this.emit('change'));
    hub.bus.onPeer('welcome', (id) => this._ensure(id));
    for (const s of hub.sessions.list()) if (s.connected) this._ensure(s.id);
  }

  // Kept when the device goes: its peer is bound to its id and hears it again when it's back. Binding
  // gives it 'client': its FileSend sends our drag policy, and what waited for the device goes.
  _ensure(id) {
    if (!id || this.byId.has(id)) return;
    const peer = new ScopedPeer(this.hub, this.server, null);
    const f = new this.FileSend(peer, this.getSettings, { outbox: this.box.viewFor(id) });
    f.recent = this.recent;
    for (const e of ['change', 'policy', 'dragEnd']) f.on(e, (...a) => this.emit(e, ...a));
    f.on('batchDone', (b) => this.emit('batchDone', { ...b, to: id }));
    this.byId.set(id, f);
    peer.bind(id);
  }

  get units() {
    return [...this.byId.values()];
  }

  get selected() {
    return this.byId.get(this.hub.selectedId) || null;
  }

  // The FileSend that sends to a device (fclip-mesh.js: a paste it asked for).
  unit(id) {
    if (!this.byId.has(id) && this.box.peer(id)) this._ensure(id);
    return this.byId.get(id) || null;
  }

  // ---- the single fileSend API ----

  get dragOn() { return this.getSettings().files.dragEdge !== false; }
  get peerDrag() { const f = this.selected; return f ? f.peerDrag : true; }
  sendPolicy() { for (const f of this.units) f.sendPolicy(); }
  planDrag(paths) { return this.FileSend.prototype.planDrag(paths); }

  // kvm.js sets its partner, the device crossed to, before this.
  startDrag(plan) {
    const f = this.byId.get(this.partner()) || this.selected;
    return f ? f.startDrag(plan) : null;
  }

  cancelDrag(drag, tell) { for (const f of this.units) if (f.drags.has(drag) || [...f.outgoing.values()].some((x) => x.drag === drag)) f.cancelDrag(drag, tell); }
  forgetDrag(drag) { for (const f of this.units) if (f.drags.has(drag)) f.forgetDrag(drag); }

  send(paths) {
    const f = this.selected;
    return f ? f.send(paths) : this.outbox.add(paths); // nothing selected: kept for the device last connected
  }

  sendBatch(...args) { const f = this.selected; return f ? f.sendBatch(...args) : null; }
  pause(batch) { return this.units.some((f) => f.batches.has(batch) && f.pause(batch)); }
  resume(id) { return this.box.resume(id); }
  forget(id) { this.outbox.remove(id); }
  cancelSending() { for (const f of this.units) f.cancelSending(); }

  clearRecent() {
    this.recent.length = 0;
    this.emit('change');
  }

  get view() {
    const views = this.units.map((f) => f.view);
    const sending = views.flatMap((v) => v.sending).slice(0, 5);
    return {
      peerDrag: this.peerDrag,
      sending,
      sendingMore: views.reduce((n, v) => n + v.sendingMore, 0) + Math.max(0, views.reduce((n, v) => n + v.sending.length, 0) - sending.length),
      outBatches: views.flatMap((v) => v.outBatches),
      outbox: this.outbox.view,
      outboxPeer: this.outbox.last ? this.outbox.last.name : '',
      sent: this.recent,
    };
  }
}

module.exports = { SendSet };
