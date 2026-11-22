// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Network folders in Multi-device on the Mac: one Smb (../smb.js) per connected device for ITS folder,
// and one for this Mac's folder, offered to every device (as shared/smb-mesh.js does on Windows and Linux).
//
// On the facade, Smb heard only the selected device: a PC's smb.offer while another device was selected
// was dropped (its folder never mounted), and its smb.revoke too (the folder stayed mounted). Here:
//   lead   this Mac's share: Share, Stop sharing, its revoke, to every device; it hears nothing
//   byId   each device's folder: its offer and revoke, its smb.state about ours, at its own address
// view, openPc() and onBle are the selected device's, as before; view.drives lists every mounted folder.
'use strict';

const { EventEmitter } = require('events');
const { viewOf } = require('../../shared/hub-route.js');

class SmbSet extends EventEmitter {
  // Smb: ../smb.js; hub: the mesh hub; helper, getSettings, saveSettings: what Smb takes.
  constructor({ Smb, hub, helper, getSettings, saveSettings }) {
    super();
    Object.assign(this, { Smb, hub, helper, getSettings, saveSettings });
    this.byId = new Map(); // device id -> { smb, clients: [fn] }
    this._wifi = null;
    this.lead = this._make(this._broadcast());
    hub.bus.onPeer('welcome', (id) => this._welcome(id));
    for (const id of hub.bus.connectedIds()) this._welcome(id);
  }

  _make(server) {
    const smb = new this.Smb({ server, helper: this.helper, getSettings: this.getSettings, saveSettings: this.saveSettings });
    if (this._wifi) smb.wifi = this._wifi;
    smb.on('change', () => this.emit('change'));
    return smb;
  }

  // A device came (again): its Smb, then its 'client' (this Mac's folder is offered to it).
  _welcome(id) {
    if (!id) return;
    let e = this.byId.get(id);
    if (!e) {
      e = { smb: null, clients: [] };
      e.smb = this._make(this._device(id, e));
      this.byId.set(id, e);
    }
    const v = viewOf(this.hub.sessions.get(id));
    for (const fn of e.clients) fn(v);
  }

  // The `server` Smb uses, for ONE device: its messages (with its address), sends to it, its session.
  _device(id, e) {
    const hub = this.hub;
    const view = () => viewOf(hub.sessions.get(id));
    return {
      on(ev, fn) {
        if (ev === 'client') e.clients.push(fn);
        else if (ev.startsWith('t:')) hub.bus.on(ev.slice(2), (m, from) => from === id && fn(m, view() || {}));
      },
      sendToClient: (m) => hub.bus.send(id, m),
      server: { get current() { return view(); } },
    };
  }

  // This Mac's share: what it sends goes to every connected device; it hears nothing.
  _broadcast() {
    const hub = this.hub;
    return {
      on() {},
      sendToClient: (m) => {
        let any = false;
        for (const id of hub.bus.connectedIds()) if (hub.bus.send(id, m)) any = true;
        return any;
      },
      server: { current: null },
    };
  }

  get current() {
    const e = this.hub.selectedId ? this.byId.get(this.hub.selectedId) : null;
    return e ? e.smb : null;
  }

  // main.js: Wi-Fi Direct for a folder reached through Bluetooth (every Smb calls it, kept for later ones).
  get wifi() { return this._wifi; }
  set wifi(fn) {
    this._wifi = fn;
    this.lead.wifi = fn;
    for (const e of this.byId.values()) e.smb.wifi = fn;
  }

  get cfg() { return this.lead.cfg; }
  get onBle() { const c = this.current; return !!c && c.onBle; }

  // Settings › Connect the other computer's folder: every device's.
  mountPc() { return Promise.all([...this.byId.values()].map((e) => e.smb.mountPc())); }
  unmountPc() { return Promise.all([...this.byId.values()].map((e) => e.smb.unmountPc())); }

  // Open: the selected device's folder, else the one device whose folder is mounted.
  openPc() {
    const c = this.current;
    if (c && (c.mount.path || c.offer)) return c.openPc();
    const any = [...this.byId.values()].find((e) => e.smb.mount.path);
    return any ? any.smb.openPc() : undefined;
  }

  // This Mac's folder.
  password() { return this.lead.password(); }
  startSharing(folder) {
    return this.lead.startSharing(folder);
  }

  async stopSharing() {
    await this.lead.stopSharing();
    if (!this.cfg.sharing) for (const e of this.byId.values()) e.smb.share.peer = null; // not shared: what each said of it is gone
    this.emit('change');
  }

  get view() {
    const lead = this.lead.view;
    const c = this.current;
    const cv = c ? c.view : null;
    const drives = [];
    for (const [id, e] of this.byId) {
      if (!e.smb.mount.path) continue;
      const s = this.hub.sessions.get(id);
      drives.push({ id, name: s ? s.displayName() : '', path: e.smb.mount.path });
    }
    const pc = cv || { pcOffered: false, pcShare: null, mounted: null, mountError: null, mounting: false, wifi: false, peer: null };
    return {
      ...lead,
      pcOffered: pc.pcOffered,
      pcShare: pc.pcShare,
      mounted: pc.mounted,
      mountError: pc.mountError,
      mounting: pc.mounting,
      wifi: pc.wifi,
      peer: pc.peer,
      drives,
    };
  }
}

module.exports = { SmbSet };
