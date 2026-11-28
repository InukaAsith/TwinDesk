// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files with the shortcuts in Multi-device (Windows and Linux): the platform's FileClip
// (windows|linux/fclip.js, written for two computers) with every connected device.
//
// On the facade it had only the selected device: our copy was offered to it alone, a copy made on
// another device was never heard, and the device driving this one (not selected here) got neither its
// paste nor its shortcut's copy. Here, by what each message is:
//   fclip.offer, fclip.gone   to every connected device; theirs from any, the newest copy wins (incoming.from)
//   fclip.paste               ours to the device whose copy we paste; theirs answered to the device that
//                             asked, its files sent through a sender of its own (makeSender, on its link)
//   fclip.key                 ours to the device we drive; theirs only from the device driving us
// and the batch a paste brings is expected by the receivers of the device it comes from (shared/files-mesh.js).
// The Mac's FileClip (mac/fclip.js) has the same shape behind its own names: `server` (on('t:…'),
// sendToClient, current) for the link, `drop` (mac/mesh/dropset.js) for the receivers, events for onChange.
'use strict';

const fs = require('fs');
const P = require('./protocol.js');

const T = P.T;

// mac: the Mac's FileClip. o.files is then its DropSet (a Drop per device), makeSender(id) a FileSend.
function meshFileClip(FileClip, { mac = false } = {}) {
  return class MeshFileClip extends FileClip {
    // o: FileClip's opts without link, fileRecv, dragRecv (the Mac's: server, drop), and: hub (bus,
    // sessions, selectedId), files (shared/files-mesh.js FilesSet; the Mac's DropSet), makeSender(id) → a
    // FileDrop (the Mac's FileSend) on a link (peer) of that device's, to send it what it pastes.
    constructor(o) {
      const { hub, files } = o;
      // `this`, once super() is done; FileClip's handlers, registered during it, wait until then.
      const me = { clip: null, pending: [] };
      me.on = (type, fn) => me.pending.push([type, fn]);
      // Where the batch of a paste comes from: the receivers of the device whose copy it is.
      const recvOf = () => { const c = me.clip; return (c && c.incoming && files.byId.get(c.incoming.from)) || null; };
      const connected = () => hub.bus.connectedIds().length > 0;
      super(mac ? {
        ...o,
        server: {
          on: (event, fn) => { if (event.startsWith('t:')) me.on(event.slice(2), fn); }, // 'closed': _closed()
          sendToClient: (m) => me.clip._route(m),
          // Who "the other computer" is in its popups: the selected device, else any.
          get current() {
            const ids = hub.bus.connectedIds();
            const s = ids.length ? hub.sessions.get(ids.includes(hub.selectedId) ? hub.selectedId : ids[0]) : null;
            return s ? { name: s.displayName() } : null;
          },
        },
        drop: { expectBatch: (...a) => { const d = recvOf(); if (d) d.expectBatch(...a); }, on: (event, fn) => files.on(event, fn) },
      } : {
        ...o,
        link: {
          on: (type, fn) => me.on(type, fn),
          send: (m) => me.clip._route(m),
          get status() { return { state: connected() ? 'connected' : 'disconnected' }; },
        },
        fileRecv: { expectBatch: (...a) => { const u = recvOf(); if (u) u.fileRecv.expectBatch(...a); } },
        dragRecv: { startPaste: (...a) => { const u = recvOf(); return !!u && !!u.dragRecv.startPaste && u.dragRecv.startPaste(...a); } },
      });
      me.clip = this;
      this.hub = hub;
      this.makeSender = o.makeSender; // the Mac's FileClip keeps only the options it knows
      this.senders = new Map(); // device id → its FileDrop, for the pastes it asks for
      const bus = hub.bus;
      bus.on(T.FCLIP_PASTE, (m, from) => this._sendTo(from, m && m.id));
      bus.onPeer('closed', (id) => this._closed(id));
      for (const [type, fn] of me.pending) this._listen(type, fn);
      me.on = (type, fn) => this._listen(type, fn);
    }

    // FileClip's own handlers (offer, gone, key), heard from every device. Its paste and closed are
    // replaced above: they answer one device, and a device leaving isn't all of them leaving.
    _listen(type, fn) {
      const bus = this.hub.bus;
      if (type === T.FCLIP_OFFER) {
        bus.on(type, (m, from) => {
          fn(m);
          if (this.incoming && m && this.incoming.id === m.id) this.incoming.from = from;
        });
      } else if (type === T.FCLIP_GONE) {
        bus.on(type, (m, from) => { if (!this.incoming || this.incoming.from === from) fn(m); });
      } else if (type === T.FCLIP_KEY) {
        // The copy or paste shortcut of the device driving us: done here, where its pointer is.
        bus.on(type, (m, from) => { const k = this.kvm; if (!k || (k.mode === 'driven' && k.partner === from)) fn(m); });
      }
    }

    // By what it is: see the top of this file. True when it went to at least one device.
    _route(m) {
      const bus = this.hub.bus;
      if (m.t === T.FCLIP_OFFER || m.t === T.FCLIP_GONE) return bus.connectedIds().map((id) => bus.send(id, m)).some(Boolean);
      if (m.t === T.FCLIP_PASTE) return !!this.incoming && !!this.incoming.from && bus.send(this.incoming.from, m);
      if (m.t === T.FCLIP_KEY) {
        const k = this.kvm;
        const to = (k && k.partner) || this.hub.selectedId;
        return !!to && bus.send(to, m);
      }
      return false;
    }

    // A device asked for our copy: its files go to it (or it hears they're gone).
    _sendTo(id, batch) {
      if (!id || typeof batch !== 'string') return;
      let sender = this.senders.get(id);
      if (!sender) {
        sender = this.makeSender(id);
        this.senders.set(id, sender);
      }
      if (sender.batches && sender.batches.has(batch)) return; // a repeated shortcut while this copy is already going
      const o = this.offer;
      const there = o && o.id === batch ? o.paths.filter((p) => fs.existsSync(p)) : [];
      if (!there.length || !sender.sendBatch(there, 'paste', batch)) this.hub.bus.send(id, { t: T.FCLIP_GONE, id: batch });
    }

    // The device whose copy we'd paste left: nothing to paste from it. Ours stays for the others,
    // until nobody is connected.
    _closed(id) {
      if (this.incoming && this.incoming.from === id) {
        this.incoming = null;
        this.pasting = null;
        this.pastePending = null;
      }
      if (!this.hub.bus.connectedIds().length) {
        ++this.copySequence;
        this.offer = null;
      }
      if (this.onChange) this.onChange();
      else this.emit('change'); // the Mac's
    }
  };
}

module.exports = { meshFileClip };
