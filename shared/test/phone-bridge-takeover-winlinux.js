// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Windows and Linux: a second Android phone takes the session before the first one's socket closed.
// The first phone's control session, windows and adb address go, and a lookup that was running for
// it is redone for the new phone (#263). The real PhoneBridge, fake services, no device.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-pb-'));
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData }, BrowserWindow: class {}, screen: {}, clipboard: {} };
  return realLoad.call(this, request, parent, isMain);
};
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ph = (id) => ({ deviceId: id, name: id, os: 'android', transport: 'ip', address: '10.0.0.' + id.length });

async function run(dir) {
  const { PhoneBridge } = require(path.join(__dirname, '..', '..', dir, 'phone-bridge.js'));
  const server = new EventEmitter();
  server.current = null;
  server.sendToClient = () => {};
  const phone = new EventEmitter();
  let resets = 0;
  phone._reset = () => { resets++; phone.adb = null; phone.info = null; };
  const settings = { phone: { input: 'adb', inputPicked: true, mirror: 'adb', soundVia: 'adb', wallpaper: false }, audio: {}, kvm: {} };
  const bridge = new PhoneBridge({ server, phone, getSettings: () => settings, clipboard: null });
  let closed = 0;
  bridge.views = new Proxy({ closeAll() { closed++; }, list: () => [] }, { get: (t, k) => (k in t ? t[k] : () => {}) });
  let stopped = 0;
  const a = ph('a');
  server.current = a;
  server.emit('client', a);
  bridge.serial = '10.0.0.1:5555';
  bridge.control = { closed: false, stop() { stopped++; this.closed = true; } };
  bridge.state = 'ready';
  phone.adb = { address: '10.0.0.1' };
  const b = ph('bb');
  server.current = b; // b is current before a's socket closes
  server.emit('client', b);
  assert.strictEqual(stopped, 1, `${dir}: the first phone's control session stops`);
  assert.ok(closed >= 1, `${dir}: its windows close`);
  assert.strictEqual(bridge.serial, null, `${dir}: its serial goes`);
  assert.strictEqual(phone.adb, null, `${dir}: its adb address goes`);
  assert.strictEqual(resets, 1);
  server.emit('closed', a); // a's late close doesn't touch b
  assert.strictEqual(resets, 1);
  // The same phone again (socket moved) keeps its session.
  bridge.control = { closed: false, stop() { stopped++; } };
  server.emit('client', b);
  assert.strictEqual(stopped, 1, `${dir}: the same phone reconnecting keeps its session`);
  // A lookup running for b when c takes over is redone.
  bridge.control = null;
  bridge.state = 'connecting';
  let release;
  bridge._step = () => new Promise((r) => { release = r; });
  const polling = bridge._poll();
  const c = ph('ccc');
  server.current = c;
  server.emit('client', c);
  bridge.serial = 'stale:5555'; // what the old lookup found
  let kicked = 0;
  bridge._kick = () => kicked++;
  release();
  await polling;
  assert.strictEqual(bridge.serial, null, `${dir}: the old lookup's serial is dropped`);
  assert.ok(kicked >= 1, `${dir}: and the new phone is looked up`);
  clearTimeout(bridge.kickTimer);
  console.log(`passed: ${dir}`);
}

(async () => {
  for (const d of ['windows', 'linux']) await run(d);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
