// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const Peer = require('../../windows/peer');
const Kvm = require('../../windows/kvm');

// Use the production Peer adapter, KVM connection gate and helper configuration together.
const guest = {
  authed: true, status: { state: 'connected', rtt: 1 }, transport: 'ip',
  onState() {}, on() {}, send() {},
  snapshot: () => ({ paired: { macId: 'mac', macName: 'Mac', os: 'mac' }, link: guest.status }),
};
const peer = new Peer(guest);
const commands = [];
const kvm = Object.assign(Object.create(Kvm.prototype), {
  link: peer, helper: { send: (cmd, args) => commands.push({ cmd, args }) },
  settings: { kvm: { linked: true, mouse: true, keyboard: true, driveOther: true, ble: true }, keys: {}, files: {} },
  pcSide: 'left', mode: 'home', locked: false,
  blockEdge: () => false, map: { zones: () => '0-1' },
});
const configured = () => { kvm.applyConfig(); return commands.findLast((x) => x.cmd === 'kvmConfig').args; };

assert.strictEqual(kvm.connected, true, 'authenticated guest sessions must reach KVM through Peer');
assert.strictEqual(configured().driveOther, true, 'a connected Mac enables physical edge detection');
guest.authed = false; // closed arrives before the UI status changes
assert.strictEqual(kvm.connected, false);
assert.strictEqual(configured().driveOther, false, 'a stale connected status never authorizes input');

peer.server = { current: { authed: true, deviceId: 'client', os: 'win', rttMs: 1 }, send() {} };
assert.strictEqual(kvm.connected, true, 'authenticated host sessions also reach KVM');
assert.strictEqual(configured().driveOther, true);
peer.server.current.authed = false;
assert.strictEqual(kvm.connected, false, 'an unauthenticated host context is never enough');
peer.server.current = null;
assert.strictEqual(kvm.connected, false);
guest.authed = true; guest.status.state = 'reconnecting';
assert.strictEqual(kvm.connected, false, 'both authentication and connected state are required');
guest.status.state = 'connected';
kvm.settings.kvm.linked = false;
assert.strictEqual(configured().driveOther, false, 'sharing off still prevents crossing');
kvm.settings.kvm.linked = true; kvm.locked = true;
assert.strictEqual(configured().driveOther, false, 'cursor lock still prevents crossing');
console.log('peer-kvm-auth: authenticated guest/host sessions enable crossing; stale, off and locked states block it');

// Linux's Peer has the same gate (linux/kvm.js reads link.authed the same way).
const LinuxPeer = require('../../linux/peer');
const lg = { authed: true, status: { state: 'connected' }, transport: 'ip', onState() {}, on() {}, send() {}, snapshot: () => ({}) };
const lp = new LinuxPeer(lg);
assert.strictEqual(lp.authed, true, 'Linux: an authenticated guest session');
lg.authed = false;
assert.strictEqual(lp.authed, false);
lp.server = { current: { authed: true }, send() {} };
assert.strictEqual(lp.authed, true, 'Linux: an authenticated host session');
console.log('peer-kvm-auth: Linux Peer too');
