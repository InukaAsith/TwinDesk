// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Advanced › Hardware encoder (windows/encoder.js, #133): off adds Chromium's
// disable-webrtc-hw-encoding at startup; a change asks for a restart; the stall watch fires when the
// hardware encoder sends nothing while frames are captured (not for a still screen, nor in software),
// and turns it off for the next start.
// Run with: node shared/test/hw-encoder.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-enc-'));
const switches = [];
const app = { getPath: () => dir, commandLine: { appendSwitch: (s) => switches.push(s) } };
const load = Module._load;
Module._load = function (id, ...args) { return id === 'electron' ? { app } : load.call(this, id, ...args); };
const enc = require('../../windows/encoder.js');
Module._load = load;

// nothing saved: on, no switch
assert.deepStrictEqual(enc.start(app), { hw: true, auto: false, reason: '' });
assert.deepStrictEqual(switches, []);
assert.strictEqual(enc.view().restart, false);

const hwStats = (mbps, dropped) => ({ encoder: 'MediaFoundationVideoEncodeAccelerator', hw: true, mbps, dropped });
// a still screen: nothing sent, nothing captured → never fires
let w = new enc.StallWatch();
for (let i = 0; i < 3; i++) assert.strictEqual(w.feed(hwStats(5, 0)), false);
for (let i = 0; i < 20; i++) assert.strictEqual(w.feed(hwStats(0, 0)), false, 'still screen');
// software encoder: never fires
w = new enc.StallWatch();
w.feed({ encoder: 'OpenH264', hw: false, mbps: 5, dropped: 0 });
for (let i = 0; i < 10; i++) assert.strictEqual(w.feed({ encoder: 'OpenH264', hw: false, mbps: 0, dropped: i * 30 }), false, 'software');
// never sent anything yet (connecting): never fires
w = new enc.StallWatch();
for (let i = 0; i < 10; i++) assert.strictEqual(w.feed(hwStats(0, i * 30)), false, 'not sent yet');
// sent, then stalled with frames piling up → fires once, after 4 s
w = new enc.StallWatch();
w.feed(hwStats(12, 0));
const fired = [];
for (let i = 1; i <= 8; i++) fired.push(w.feed(hwStats(0, i * 30)));
assert.deepStrictEqual(fired, [false, false, false, true, false, false, false, false]);
// a brief dip that recovers: no
w = new enc.StallWatch();
w.feed(hwStats(12, 0));
for (const m of [0, 0, 0, 8, 0, 0, 0, 9]) assert.strictEqual(w.feed(hwStats(m, 100)), false, 'recovers');

// the watch fired: off from the next start, Restart shown
assert.strictEqual(enc.fallBack('stalled'), true);
assert.strictEqual(enc.fallBack('stalled'), false, 'already off');
let v = enc.view();
assert.deepStrictEqual([v.hw, v.auto, v.restart, v.reason], [false, true, true, 'stalled']);
// next start: the switch, no restart needed
switches.length = 0;
enc.start(app);
assert.deepStrictEqual(switches, ['disable-webrtc-hw-encoding']);
v = enc.view();
assert.deepStrictEqual([v.hw, v.auto, v.restart], [false, true, false]);
// off at start, the watch stays quiet
w = new enc.StallWatch();
w.feed(hwStats(12, 0));
for (let i = 1; i <= 8; i++) assert.strictEqual(w.feed(hwStats(0, i * 30)), false, 'already software');
// turned on by hand: not auto any more, Restart shown
enc.write(true);
v = enc.view();
assert.deepStrictEqual([v.hw, v.auto, v.restart], [true, false, true]);

// wired in: both pcscreen.js watch, both ipc.js set it, the General page shows it
const root = path.join(__dirname, '..', '..');
for (const f of ['windows/pcscreen.js', 'windows/mesh/pcscreen.js']) assert.ok(/StallWatch/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
for (const f of ['windows/ipc.js', 'windows/mesh/ipc.js', 'windows/preload-app.js', 'windows/mesh/preload-app.js']) assert.ok(/setEncoder/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
assert.ok(/require\('\.\/encoder'\)\.start\(app\)/.test(fs.readFileSync(path.join(root, 'windows/main.js'), 'utf8')), 'main.js reads it at startup');
fs.rmSync(dir, { recursive: true, force: true });
console.log('hw-encoder: ok');
