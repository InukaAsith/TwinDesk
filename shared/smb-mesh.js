// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Network folders in Multi-device (Windows and Linux): one Smb (windows/smb.js, linux/smb.js) per
// connected device for ITS folder, and one for ours, offered to every device.
//
// On the facade, Smb talked only to the selected device: an smb.offer that came while another device
// was selected was dropped and its folder never connected; an smb.revoke was dropped too, so a folder
// stayed connected after it was no longer shared; and the folder of one device was connected at the
// address of whichever device was selected. Here:
//   lead     our share: Share this folder, Choose…, Remove, and the offer and revoke, to every device
//   byId     each device's folder: its offer, its revoke, its state about our share, at its own address
// The getters the rest of the app reads (mac, mounted, drive, mountMessage, mount(), open()) are the
// selected device's, as before; view() adds `drives`, every device's connected folder.
'use strict';

const P = require('./protocol.js');

const T = P.T;

class SmbSet {
  // Smb: the platform's class; hub: the mesh hub (bus, sessions, peers(), selectedId); settings, save(), onChange().
  // canMount(id): false while that device is reached through Bluetooth (main.js: its folder waits for Wi-Fi).
  constructor({ Smb, hub, settings, save, onChange }) {
    Object.assign(this, { Smb, hub, settings, save, onChange });
    this.canMount = () => true;
    this.byId = new Map(); // device id -> { smb, life: {welcome: [fn]} }
    const bus = hub.bus;
    // Ours: sent to every connected device; it hears nothing (each device's answers go to its own Smb).
    this.lead = new Smb({ link: this._broadcastLink(), settings, save, onChange });
    bus.onPeer('welcome', (id) => this._welcome(id));
    for (const id of bus.connectedIds()) this._welcome(id);
  }

  // ---- a device comes ----

  _welcome(id) {
    if (!id) return; // phones too: their Files app connects our folder (Android Pointer.kt, iOS Media.swift)
    let e = this.byId.get(id);
    if (!e) {
      e = { smb: null, life: { welcome: [] } };
      e.smb = new this.Smb({ link: this._deviceLink(id, e), settings: this.settings, save: this.save, onChange: this.onChange });
      this._guardMount(id, e.smb);
      e.smb.canWifi = () => !this.canMount(id); // its view: Open connects it over Wi-Fi Direct
      this.byId.set(id, e);
    }
    for (const fn of e.life.welcome) fn({});
  }

  // The device's folder waits for Wi-Fi while it is reached through Bluetooth (canMount); mountNow() doesn't.
  _guardMount(id, smb) {
    const mount = smb.mount.bind(smb);
    smb.mountNow = mount;
    smb.mount = () => {
      if (this.canMount(id)) return mount();
      smb.mountMessage = '';
      smb.onChange();
      return Promise.resolve();
    };
  }

  // A link to ONE device, in the shape Smb uses: on(type) hears only it, send() goes only to it,
  // snapshot().link.address is its address (not the selected device's).
  _deviceLink(id, e) {
    const hub = this.hub;
    return {
      on(type, fn) {
        if (type === 'welcome') e.life.welcome.push(fn);
        else if (type !== 'closed') hub.bus.on(type, (m, from) => from === id && fn(m));
      },
      send: (m) => hub.bus.send(id, m),
      // The live address, as the facade's snapshot gives it (after a move to Wi-Fi Direct, not the paired one).
      snapshot: () => {
        const p = hub.peers().find((x) => x.id === id) || {};
        const s = hub.sessions.get(id);
        let address = '';
        if (s && s.connected && s.hosting && s.ctx) address = s.ctx.address || '';
        else if (s && s.link && typeof s.link.snapshot === 'function') address = (s.link.snapshot().link || {}).address || '';
        return { link: { address: address || p.address || '', macName: p.name || '' }, session: { id, name: p.name || '', os: p.os } };
      },
    };
  }

  // Our share's link: offers and revokes go to every connected computer.
  _broadcastLink() {
    const hub = this.hub;
    return {
      on() {},
      send: (m) => {
        let any = false;
        for (const id of hub.bus.connectedIds()) if (hub.bus.send(id, m)) any = true;
        return any;
      },
      snapshot: () => hub.facade.snapshot(),
    };
  }

  // ---- the selected device's folder (what the Files page shows and Open opens) ----

  get current() {
    const e = this.hub.selectedId ? this.byId.get(this.hub.selectedId) : null;
    return e ? e.smb : null;
  }

  get mac() { const c = this.current; return c ? c.mac : null; }
  get mounted() { const c = this.current; return c ? c.mounted || null : null; }
  get drive() { const c = this.current; return c ? c.drive || '' : ''; }
  get mountMessage() { const c = this.current; return c ? c.mountMessage : ''; }
  set mountMessage(v) { const c = this.current; if (c) c.mountMessage = v; }

  mount() { const c = this.current; return c ? c.mount() : Promise.resolve(); }
  mountNow() { const c = this.current; return c ? c.mountNow() : Promise.resolve(); }
  open() { const c = this.current; if (c && c.open) c.open(); }

  // Files › Connect the other computer's shared folder: every device's.
  applyMount() {
    for (const e of this.byId.values()) e.smb.applyMount();
  }

  // ---- our share ----

  get cfg() { return this.lead.cfg; }
  get busy() { return this.lead.busy; }
  get message() { return this.lead.message; }
  _creds() { return this.lead._creds(); }
  checkShare() { return this.lead.checkShare(); }
  chooseFolder(folder) { return this.lead.chooseFolder(folder); }

  async setShareOn(on) {
    await this.lead.setShareOn(on);
    if (!on) this._forgetPeerStates();
  }

  async unshare() {
    await this.lead.unshare();
    this._forgetPeerStates();
  }

  // Not shared any more: what each device said about our folder is gone with it.
  _forgetPeerStates() {
    for (const e of this.byId.values()) e.smb.peerState = null;
    this.onChange();
  }

  view() {
    const v = this.lead.view();
    const c = this.current;
    const cv = c ? c.view() : null;
    const drives = [];
    for (const [id, e] of this.byId) {
      const d = e.smb.mounted ? e.smb.mounted.path || e.smb.mounted.uri : e.smb.drive;
      if (d) drives.push({ id, name: (this.hub.peers().find((x) => x.id === id) || {}).name || '', drive: d });
    }
    return {
      ...v,
      peer: cv ? cv.peer : null,
      macShare: cv ? cv.macShare : '',
      drive: cv ? cv.drive : '',
      mountMessage: cv ? cv.mountMessage : '',
      wifi: cv ? cv.wifi : false,
      drives,
    };
  }
}

module.exports = { SmbSet };
