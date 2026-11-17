// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A second Android phone takes the Mac session. The real PhoneBridge, with fake services and no
// device: the first phone's control session has to stop, and a lookup that then fails for that
// phone must not be recorded against the phone that replaced it (#263).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-phone-bridge-'));
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, parent, isMain);
};
const { PhoneBridge } = require('../phone-bridge.js');
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function phone(id, address) {
  return { deviceId: id, name: id, os: 'android', transport: 'ip', address };
}

function harness(input = 'adb') {
  const server = new EventEmitter();
  server.current = null;
  const sent = [];
  server.sendToClient = (msg) => sent.push({ msg, deviceId: server.current && server.current.deviceId });
  server.inject = () => {};
  server.keySwap = () => false;
  const phoneHub = new EventEmitter();
  phoneHub.info = null;
  phoneHub.adb = null;
  const settings = {
    phone: { input, inputPicked: true, mirror: 'adb', soundVia: 'adb', wallpaper: false },
    audio: {},
    kvm: {},
  };
  const calls = { devices: 0, control: 0, views: 0, mouse: 0 };
  let devices = async () => [];
  const adb = {
    available: true,
    wake() {},
    devices() { calls.devices++; return devices(); },
    connect: async () => ({ ok: false, text: '' }),
    disconnect: async () => ({ ok: true, text: '' }),
    mdns: async () => [],
    shell: async () => ({ out: '', err: '' }),
    run: async () => ({ code: 0, out: '', err: '' }),
    pair: async () => ({ ok: false, text: '' }),
  };
  const bridge = new PhoneBridge({ server, phone: phoneHub, getSettings: () => settings, clipboard: null });
  bridge.adb = adb;
  bridge.views = {
    closeAll() { calls.views++; },
    list() { return []; },
    cameraState() { return null; },
    sound() {},
    mic() {},
    netMic() {},
    netSound() {},
    screenWithSound: false,
  };
  return {
    server, phoneHub, bridge, calls, sent,
    setDevices(fn) { devices = fn; },
    stop() {
      clearInterval(bridge.pollTimer);
      clearTimeout(bridge.kickTimer);
    },
  };
}

test('a second Android phone releases the first and looks that phone up', async () => {
  for (const input of ['adb', 'phone']) {
  const h = harness(input);
  try {
    const a = phone('phone-a', '10.0.0.2');
    const b = phone('phone-b', '10.1.1.8');
    h.server.current = a;
    h.phoneHub.info = { model: 'Phone A', display: { w: 1080, h: 2400, rot: 0, dpi: 420 }, caps: [] };
    h.phoneHub.adb = { wifi: true, address: '10.0.0.2', port: 37000, devOptions: true, canEnable: true, full: true, net: true };
    h.server.emit('client', a);
    const controlA = {
      closed: false,
      stop() { this.closed = true; h.calls.control++; },
      mouse() { h.calls.mouse++; },
    };
    h.bridge.serial = 'serial-a';
    h.bridge.control = controlA;
    h.bridge.state = 'ready';
    h.bridge.phoneInput = true;
    h.bridge.kvm = { route: 1, x: 10, y: 20, side: 'left', push: 0, buttons: input === 'phone' ? 1 : 0, mouse: true };
    h.bridge.input.scroll(10, 20, 1080, 2400, 0, 1);
    h.server.current = b;
    h.server.emit('client', b);
    // The old socket closes after current is already B (authenticate does this).
    h.server.emit('closed', a);
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
    assert.equal(h.bridge.kvm, null);
    assert.equal(h.phoneHub.info, null);
    assert.equal(h.phoneHub.adb, null);
    assert.equal(h.calls.control, 1);
    assert.equal(h.calls.views, 1);
    assert.equal(h.calls.mouse, input === 'adb' ? 1 : 0);
    h.phoneHub.adb = { wifi: true, address: '10.1.1.8', port: 38000, devOptions: true, canEnable: true, full: true, net: true };
    await wait(200);
    assert.ok(h.calls.devices > 0);
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
    assert.notEqual(h.bridge.state, 'ready');
    assert.equal(h.calls.control, 1);
    assert.equal(h.calls.views, 1);
    assert.ok(!h.sent.some(({ msg, deviceId }) => msg.t === 'phone.in' && deviceId === 'phone-b'), 'old touch release or queued scroll reached the new phone');
    h.phoneHub.info = { model: 'Phone B' };
    h.server.current = { deviceId: 'iphone', os: 'ios' };
    h.server.emit('client', h.server.current);
    assert.equal(h.phoneHub.info, null);
    assert.equal(h.phoneHub.adb, null, 'an intervening non-Android peer must not preserve the retired phone address');
  } finally {
    h.stop();
  }
  }
});

test('a device lookup that fails after another phone is selected is not that phone’s failure', async () => {
  const h = harness();
  try {
    let rejectLookup;
    h.setDevices(() => new Promise((_, reject) => { rejectLookup = reject; }));
    const a = phone('phone-a', '10.0.0.2');
    const b = phone('phone-b', '10.1.1.8');
    h.server.current = a;
    h.phoneHub.adb = { wifi: true, address: '10.0.0.2', port: 37000, devOptions: true, canEnable: true, full: true, net: true };
    h.server.emit('client', a);
    await wait(80);
    assert.equal(h.calls.devices, 1);
    assert.equal(typeof rejectLookup, 'function');
    h.server.current = b;
    h.server.emit('client', b);
    h.server.emit('closed', a);
    rejectLookup(new Error('lookup failed'));
    await wait(250);
    assert.equal(h.bridge.state, 'connecting');
    assert.equal(h.bridge.message, 'Waiting for the phone…');
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
  } finally {
    h.stop();
  }
});
