// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/kvm-map.js Identify (#182): where the numbers can be shown another way (the Linux helper on
// Wayland), each monitor's rectangle and number go there and no window of ours is made; else our windows.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { KvmMap } = require('../kvm-map.js');

const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }];
const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) });
let windows = 0;
function BrowserWindow() { windows++; return { setIgnoreMouseEvents() {}, setAlwaysOnTop() {}, loadURL() {}, once() {}, isDestroyed: () => false, close() {} }; }
const make = (identifyHere) => new KvmMap({ electron: { screen, BrowserWindow }, send() {}, side: () => null, getAlong: () => null, setAlong() {}, identifyHere });

let list = null;
const m = make((l) => { list = l; return true; });
m.identify(false);
assert.ok(/^0,0,1920,1080,\d;1920,0,2560,1440,\d$/.test(list), list);
assert.deepStrictEqual(list.split(';').map((x) => +x.split(',')[4]).sort(), [1, 2], 'each its own number');
assert.strictEqual(windows, 0, 'no window of ours');
make((l) => false).identify(false); // couldn't: our windows, as before
assert.strictEqual(windows, 2);
make(null).identify(false);
assert.strictEqual(windows, 4);
console.log('kvm-map-identify: ok');
