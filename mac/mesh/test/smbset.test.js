// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/mesh/smbset.js: each device's folder mounts from its own offer, at its own address, whichever
// device is selected; its revoke unmounts it; this Mac's folder is offered to every device. The Smb is a
// stand-in that uses its `server` as ../smb.js does.
// Run with: node mac/mesh/test/smbset.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { SmbSet } = require('../smbset.js');

const T = P.T;

class FakeSmb extends EventEmitter {
  constructor({ server, getSettings }) {
    super();
    Object.assign(this, { server, getSettings });
    this.offer = null;
    this.mount = { path: null, error: null, busy: false };
    this.share = { busy: false, error: null, peer: null };
    server.on(`t:${T.SMB_OFFER}`, (m, ctx) => { this.offer = { share: m.share, host: ctx.address }; this.mountPc(); });
    server.on(`t:${T.SMB_REVOKE}`, () => { this.offer = null; this.unmountPc(); });
    server.on(`t:${T.SMB_STATE}`, (m) => { this.share.peer = { mounted: !!m.mounted }; });
    server.on('client', () => this._offerOurs());
  }
  get cfg() { return this.getSettings().smb; }
  get onBle() { const c = this.server.server.current; return !!c && c.transport === 'ble'; }
  _offerOurs() { if (this.cfg.sharing) this.server.sendToClient({ t: T.SMB_OFFER, share: 'MacShare' }); }
  async mountPc() { if (this.offer && this.cfg.connectPc) this.mount.path = '/Volumes/' + this.offer.host; this.emit('change'); }
  async unmountPc() { this.mount.path = null; this.emit('change'); }
  openPc() { this.opened = true; }
  password() { return 'pw'; }
  async startSharing() { this.cfg.sharing = true; this._offerOurs(); }
  async stopSharing() { this.cfg.sharing = false; this.server.sendToClient({ t: T.SMB_REVOKE, share: 'MacShare' }); }
  get view() { return { pcOffered: !!this.offer, pcShare: this.offer ? this.offer.share : null, mounted: this.mount.path, mountError: null, mounting: false, wifi: false, shareBusy: false, shareError: null, peer: this.share.peer }; }
}

function fakeHub() {
  const handlers = new Map();
  const peerFns = [];
  const transportFns = [];
  const devices = new Map();
  return {
    selectedId: null,
    bus: {
      on: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
      onPeer: (ev, fn) => { if (ev === 'welcome') peerFns.push(fn); else if (ev === 'transport') transportFns.push(fn); },
      send: (id, m) => { const d = devices.get(id); if (!d) return false; d.sent.push(m); return true; },
      connectedIds: () => [...devices.keys()],
    },
    sessions: { get: (id) => { const d = devices.get(id); return d ? { id, connected: true, hostUp: true, ctx: { address: d.address }, role: 'host', transport: 'ip', peerOs: 'win', status: {}, lastRx: 0, displayName: () => id } : null; } },
    connect(id, address) { devices.set(id, { address, sent: [] }); for (const fn of peerFns) fn(id, {}); },
    moved(id) { for (const fn of transportFns) fn(id, {}); },
    from(id, m) { for (const fn of handlers.get(m.t) || []) fn(m, id); },
    sent: (id) => devices.get(id).sent,
  };
}

const settings = { smb: { sharing: true, connectPc: true } };
const hub = fakeHub();
hub.connect('B', '10.0.0.2');
const set = new SmbSet({ Smb: FakeSmb, hub, helper: null, getSettings: () => settings, saveSettings() {} });
hub.connect('C', '10.0.0.3');
assert.deepStrictEqual(hub.sent('B').map((m) => m.t), [T.SMB_OFFER], 'B: this Mac\'s folder offered once');
assert.deepStrictEqual(hub.sent('C').map((m) => m.t), [T.SMB_OFFER], 'C: offered once');
hub.selectedId = 'B';

hub.from('C', { t: T.SMB_OFFER, share: 'MacShare' });
assert.strictEqual(set.byId.get('C').smb.mount.path, '/Volumes/10.0.0.3', 'C folder mounted at C address, B selected');
assert.strictEqual(set.view.mounted, null, 'the view shows the selected device (B)');
assert.deepStrictEqual(set.view.drives, [{ id: 'C', name: 'C', path: '/Volumes/10.0.0.3', selected: false }]);
set.openPc();
assert.ok(set.byId.get('C').smb.opened, 'Open: the one mounted folder when the selected device has none');
hub.from('C', { t: T.SMB_REVOKE, share: 'MacShare' });
assert.strictEqual(set.byId.get('C').smb.mount.path, null, 'revoked by a device that is not selected');

let changes = 0;
set.on('change', () => changes++);
hub.from('B', { t: T.SMB_STATE, share: 'MacShare', mounted: true });
assert.deepStrictEqual(set.view.peer, { mounted: true });
set.stopSharing().then(() => {
  assert.strictEqual(hub.sent('B').at(-1).t, T.SMB_REVOKE);
  assert.strictEqual(hub.sent('C').at(-1).t, T.SMB_REVOKE);
  assert.strictEqual(set.view.peer, null, 'not shared: what B said of it is gone');
  assert.ok(changes > 0);
  const fn = () => Promise.resolve(true);
  set.wifi = fn;
  hub.connect('D', '10.0.0.4');
  assert.strictEqual(set.byId.get('D').smb.wifi, fn, 'a later device gets the Wi-Fi Direct hook');
  // A device that isn't selected moves off Bluetooth: its offered folder mounts then (mountPc waits on Bluetooth).
  const d = set.byId.get('D').smb;
  d.offer = { share: 'DShare', host: '10.0.0.4' };
  hub.moved('D');
  assert.strictEqual(d.mount.path, '/Volumes/10.0.0.4', 'mounted at its move, D not selected');
  hub.moved('B'); // no offer from B: nothing
  assert.strictEqual(set.byId.get('B').smb.mount.path, null);
  console.log('passed: smbset');
});
