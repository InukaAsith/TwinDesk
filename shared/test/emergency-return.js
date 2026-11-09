// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Check the one-to-one state machine without starting Electron or the native input helper.
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const P = require('../protocol.js');
const originalLoad = Module._load;
const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ id: 1 }),
  getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }],
});
Module._load = function (name, ...args) {
  if (name === 'electron') return { screen };
  if (name === './store') return { saveSettings() {} };
  return originalLoad.call(this, name, ...args);
};
const { Kvm } = require('../../mac/kvm.js');
const oldInterval = global.setInterval;
global.setInterval = () => null;
const server = Object.assign(new EventEmitter(), {
  current: { deviceId: 'peer', name: 'Peer', lastRx: Date.now(), transport: 'ip' },
  messages: [], sendToClient(msg) { this.messages.push(msg); },
});
const helper = Object.assign(new EventEmitter(), {
  commands: [], send(cmd, args) { this.commands.push({ cmd, args }); }, request(cmd, args) { this.commands.push({ cmd, args }); return Promise.resolve({ ok: true }); },
});
const settings = { kvm: { pcSide: 'right', mouse: true, keyboard: true, driveOther: true, beDriven: true,
  linked: true, linkedBy: {}, resistancePx: 10, speed: 1, ble: true }, keys: { hotkey: 'AltRight', lockKeys: 'F14' } };
const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, cancelDrag() {} });
const drop = { dragIn: { dragging: false, onDriven() {}, cancel() {} }, cancelDrag() {} };
const kvm = new Kvm({ server, helper, getSettings: () => settings, clipboard: { sendIfChanged() {} }, input: { releaseAll() {} }, drop, fileSend });
global.setInterval = oldInterval;
Module._load = originalLoad;

kvm.config();
assert.equal(helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.emergencyKeys, 'Control+Alt+Command+Escape');
settings.keys.emergencyKeys = 'Control+Alt+R';
kvm.config();
assert.equal(helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.emergencyKeys, 'Control+Alt+R');
settings.keys.emergencyKeys = 'unsupported';
kvm.config();
assert.equal(helper.commands.filter((c) => c.cmd === 'kvmConfig').at(-1).args.emergencyKeys, 'Control+Alt+Command+Escape');

kvm._setMode('driving', '');
assert.deepEqual(helper.commands.at(-1), { cmd: 'emergencyActive', args: { on: true } });
helper.emit('event', 'emergency', {});
assert.equal(kvm.mode, 'home');
assert.equal(settings.kvm.linked, false);
assert.ok(helper.commands.some((c) => c.cmd === 'capture' && c.args.on === false));
assert.ok(server.messages.some((m) => m.t === P.T.KVM_RELEASE));
assert.ok(helper.commands.some((c) => c.cmd === 'emergencyActive' && c.args.on === false));

settings.kvm.linked = true;
kvm._setMode('driven', '');
helper.emit('event', 'emergency', {});
assert.equal(kvm.mode, 'home');
assert.equal(settings.kvm.linked, false);
assert.ok(helper.commands.some((c) => c.cmd === 'releaseAll'));
assert.ok(server.messages.some((m) => m.t === P.T.KVM_HOME));
console.log('emergency return state machine: ok');
