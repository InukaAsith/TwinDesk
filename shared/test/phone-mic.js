// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio › Microphone with a phone: each phoneview.js opens one hidden audio-only session capturing
// the phone's microphone (scrcpy audio_source=mic) while it's on and wireless debugging is up,
// starts again when another output is picked, closes when off, and keeps it out of the windows list;
// each phone-bridge.js asks for it from Audio › Microphone's receive switch.
// Run with: node shared/test/phone-mic.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..', '..');
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') {
    const stub = new Proxy(function () {}, { get: (t, k) => (k === 'app' ? { getPath: () => '/tmp', on() {}, isPackaged: false, getVersion: () => '0' } : k === 'ipcMain' ? new EventEmitter() : stub), apply: () => stub, construct: () => stub });
    return stub;
  }
  return load.call(this, id, ...args);
};

for (const p of ['windows', 'mac', 'linux']) {
  const { PhoneViews } = require(path.join(root, p, 'phoneview.js'));
  const opened = [];
  const fake = {
    views: new Map(),
    bridge: { serial: 'phone:5555' },
    _i18n: () => ({ t: (s) => s }),
    _open(o) { const v = { id: opened.length + 1, ...o }; opened.push(v); this.views.set(v.id, v); },
    close(id) { this.views.delete(id); },
  };
  const mic = PhoneViews.prototype.mic;
  mic.call(fake, true, '');
  assert.strictEqual(opened.length, 1, p + ': on opens it');
  const v = opened[0];
  assert.strictEqual(v.kind, 'mic');
  assert.strictEqual(v.hidden, true, p + ': hidden');
  assert.deepStrictEqual(v.opts, { video: false, audio: true, control: false, audioSource: 'mic' }, p + ': the phone microphone, audio only');
  mic.call(fake, true, '');
  assert.strictEqual(opened.length, 1, p + ': on again: the same one');
  mic.call(fake, true, 'cable-id');
  assert.strictEqual(opened.length, 2, p + ': another output: started again');
  assert.strictEqual(opened[1].sink, 'cable-id');
  assert.strictEqual(fake.views.size, 1, p + ': only one');
  fake.views.get(2).sink = 'cable-id';
  mic.call(fake, false);
  assert.strictEqual(fake.views.size, 0, p + ': off closes it');
  fake.bridge.serial = null;
  mic.call(fake, true, '');
  assert.strictEqual(opened.length, 2, p + ': no wireless debugging: nothing');
  // kept out of the windows list
  fake.views.set(9, { id: 9, kind: 'mic', title: 'x' });
  fake.views.set(10, { id: 10, kind: 'screen', title: 'y' });
  const list = PhoneViews.prototype.list.call(fake);
  assert.deepStrictEqual(list.map((x) => x.kind), ['screen'], p + ': not listed');
  // the renderer plays it into a microphone
  const r = fs.readFileSync(path.join(root, p, 'phoneview-renderer.js'), 'utf8');
  assert.ok(/kind !== 'mic'/.test(r) && /setSinkId/.test(r) && /TwinDesk\.Microphone\.output/.test(r), p + ': renderer routes the phone microphone');
}
Module._load = load;

for (const f of ['windows/phone-bridge.js', 'mac/phone-bridge.js', 'linux/phone-bridge.js', 'windows/mesh/phone-bridge.js', 'mac/mesh/phone-bridge.js', 'linux/mesh/phone-bridge.js']) {
  const s = fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(/this\.views\.mic\(isPhone\(c\) && adb && !!audio\.micReceive, audio\.micOut \|\| ''\)/.test(s), f + ': asks for the phone microphone');
}
console.log('phone-mic: ok');
