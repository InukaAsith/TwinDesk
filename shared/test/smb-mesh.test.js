// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/smb-mesh.js: in Multi-device, each device's folder is connected from its own offer, at its own
// address, whichever device is selected; its revoke disconnects it; our share is offered to every device.
// The Smb here is a stand-in that uses its link as windows/smb.js and linux/smb.js do.
// Run: node shared/test/smb-mesh.test.js
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const { SmbSet } = require('../smb-mesh.js');

const T = P.T;

// windows/smb.js and linux/smb.js as far as the link goes: welcome → offer ours; smb.offer → mount at
// link.snapshot().link.address; smb.revoke → unmount; smb.state → peerState.
class FakeSmb {
  constructor(opts) {
    Object.assign(this, opts);
    this.mac = null;
    this.mounted = null;
    this.peerState = null;
    this.mountMessage = '';
    this.busy = '';
    this.message = '';
    this.link.on('welcome', () => this._offer());
    this.link.on(T.SMB_STATE, (m) => { this.peerState = { mounted: !!m.mounted }; });
    this.link.on(T.SMB_OFFER, (m) => { this.mac = { share: m.share, user: m.user, password: m.password }; return this.mount(); });
    this.link.on(T.SMB_REVOKE, () => { this.mounted = null; this.mac = null; });
  }
  get cfg() { return this.settings.files; }
  _creds() { return this.settings.creds; }
  _offer() { if (this.cfg.shareOn) this.link.send({ t: T.SMB_OFFER, share: 'MacShare', user: 'u', password: 'p', port: 445 }); }
  async mount() {
    const addr = this.link.snapshot().link.address;
    if (!this.mac || !addr) return;
    this.mounted = { uri: 'smb://' + addr + '/' + this.mac.share, path: '' };
  }
  applyMount() { if (this.cfg.mountMac && this.mac && !this.mounted) this.mount(); }
  async setShareOn(on) { this.cfg.shareOn = on; if (on) this._offer(); else this.link.send({ t: T.SMB_REVOKE, share: 'MacShare' }); }
  async unshare() { return this.setShareOn(false); }
  chooseFolder() {}
  checkShare() {}
  open() { this.opened = true; }
  view() {
    return { busy: '', message: '', sharing: !!this.cfg.shareOn, peer: this.peerState, macShare: this.mac ? this.mac.share : '', drive: this.mounted ? this.mounted.uri : '', mountMessage: this.mountMessage, wifi: !this.mounted && !!this.mac && !!(this.canWifi && this.canWifi()), folder: '/f' };
  }
}

// A hub as SmbSet uses it: bus (on, onPeer, send, connectedIds), sessions, peers(), selectedId, facade.
function fakeHub() {
  const handlers = new Map();
  const peerFns = [];
  const transportFns = [];
  const devices = new Map(); // id -> {address, name, transport, connected, sent: []}
  const hub = {
    selectedId: null,
    bus: {
      on: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
      onPeer: (ev, fn) => { if (ev === 'welcome') peerFns.push(fn); else if (ev === 'transport') transportFns.push(fn); },
      send: (id, m) => { const d = devices.get(id); if (!d || !d.connected) return false; d.sent.push(m); return true; },
      connectedIds: () => [...devices].filter(([, d]) => d.connected).map(([id]) => id),
    },
    sessions: { get: (id) => { const d = devices.get(id); return d ? { id, connected: d.connected, transport: d.transport, hosting: true, ctx: { address: d.address } } : null; } },
    peers: () => [...devices].map(([id, d]) => ({ id, name: d.name, address: d.address, os: 'win' })),
    facade: { snapshot: () => ({ link: { address: '' } }) },
    // test helpers
    connect(id, address) { devices.set(id, { address, name: id, transport: 'ip', connected: true, sent: [] }); for (const fn of peerFns) fn(id, {}); },
    move(id, transport) { devices.get(id).transport = transport; for (const fn of transportFns) fn(id, {}); },
    from(id, m) { for (const fn of handlers.get(m.t) || []) fn(m, id); },
    sent: (id) => devices.get(id).sent,
    device: (id) => devices.get(id),
  };
  return hub;
}

(async () => {
  const settings = { files: { shareOn: true, mountMac: true }, creds: { user: 'u', password: 'p' } };
  const hub = fakeHub();
  hub.connect('B', '10.0.0.2');
  const set = new SmbSet({ Smb: FakeSmb, hub, settings, save() {}, onChange() {} });
  assert.deepStrictEqual(hub.sent('B').map((m) => m.t), [T.SMB_OFFER], 'a device connected before: offered ours once');
  hub.connect('C', '10.0.0.3');
  assert.deepStrictEqual(hub.sent('C').map((m) => m.t), [T.SMB_OFFER], 'a device that connects: offered ours');
  assert.strictEqual(hub.sent('B').length, 1, 'only to the device that connected');
  hub.selectedId = 'B';

  // C offers its folder while B is selected: connected, at C's address (the facade dropped it, or used B's address).
  hub.from('C', { t: T.SMB_OFFER, share: 'MacShare', user: 'cu', password: 'cp', port: 445 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(set.byId.get('C').smb.mounted.uri, 'smb://10.0.0.3/MacShare', 'C folder at C address');
  assert.strictEqual(set.mounted, null, 'the selected device (B) has no folder');
  assert.deepStrictEqual(set.view().drives, [{ id: 'C', name: 'C', drive: 'smb://10.0.0.3/MacShare', selected: false }], 'view lists every connected folder');
  hub.selectedId = 'C';
  assert.strictEqual(set.mounted.uri, 'smb://10.0.0.3/MacShare', 'getters follow the selected device');
  assert.strictEqual(set.view().macShare, 'MacShare');
  set.open();
  assert.ok(set.byId.get('C').smb.opened, 'Open opens the selected device folder');

  // C revokes while B is selected: disconnected.
  hub.selectedId = 'B';
  hub.from('C', { t: T.SMB_REVOKE, share: 'MacShare' });
  assert.strictEqual(set.byId.get('C').smb.mounted, null, 'revoked from a device that is not selected');

  // B said our folder is connected there; we stop sharing: revoke to all, and B's state about it is gone.
  hub.from('B', { t: T.SMB_STATE, share: 'MacShare', mounted: true });
  assert.deepStrictEqual(set.view().peer, { mounted: true });
  await set.setShareOn(false);
  assert.strictEqual(hub.sent('B').at(-1).t, T.SMB_REVOKE);
  assert.strictEqual(hub.sent('C').at(-1).t, T.SMB_REVOKE);
  assert.strictEqual(set.view().peer, null);

  // A device reached through Bluetooth: its folder waits (canMount), mountNow connects it.
  hub.device('B').transport = 'ble';
  set.canMount = (id) => hub.sessions.get(id).transport !== 'ble';
  hub.from('B', { t: T.SMB_OFFER, share: 'MacShare', user: 'bu', password: 'bp', port: 445 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(set.mounted, null, 'waits for Wi-Fi');
  assert.strictEqual(set.view().wifi, true, 'Open offers Wi-Fi Direct');
  await set.mountNow();
  assert.strictEqual(set.mounted.uri, 'smb://10.0.0.2/MacShare');

  // A device that isn't selected moves from Bluetooth to Wi-Fi: its folder connects then by itself.
  hub.device('C').transport = 'ble';
  hub.from('C', { t: T.SMB_OFFER, share: 'CShare', user: 'cu', password: 'cp', port: 445 });
  await new Promise((r) => setImmediate(r));
  assert.notStrictEqual(hub.selectedId, 'C');
  assert.strictEqual(set.byId.get('C').smb.mounted, null, 'waits while on Bluetooth');
  hub.move('C', 'ble'); // a change that's still Bluetooth: nothing
  assert.strictEqual(set.byId.get('C').smb.mounted, null);
  hub.move('C', 'ip');
  await new Promise((r) => setImmediate(r));
  assert.ok(set.byId.get('C').smb.mounted && /CShare$/.test(set.byId.get('C').smb.mounted.uri), 'connected once on Wi-Fi');

  console.log('smb-mesh: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
