// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/notifrules.js fromApps: in Multi-device, an app of one device hidden here (Who shares what ›
// Notifications › Apps by device). Only that device's notifications from that app are hidden; the same
// app from another device still shows; it survives a settings reload; switching it back clears it.
// Run: node shared/test/notif-from-apps.js
'use strict';

const assert = require('assert');
const R = require('../notifrules.js');

let cfg = R.saved({});
assert.deepStrictEqual(cfg.fromApps, {});
const wa = { app: 'com.whatsapp', title: 'Hi' };
assert.strictEqual(R.modeOf(cfg, wa, undefined, 'PHONE'), 'show');

Object.assign(cfg, R.clean({ fromApp: { from: 'PHONE', app: 'com.whatsapp', name: 'WhatsApp', hide: true } }, cfg));
assert.deepStrictEqual(cfg.fromApps, { PHONE: { 'com.whatsapp': 'WhatsApp' } });
assert.strictEqual(R.modeOf(cfg, wa, undefined, 'PHONE'), 'hide', 'hidden from that phone');
assert.strictEqual(R.modeOf(cfg, wa, undefined, 'TABLET'), 'show', 'the same app from another device still shows');
assert.strictEqual(R.modeOf(cfg, wa), 'show', 'no origin (one-to-one): as before');

cfg = R.saved(JSON.parse(JSON.stringify(cfg)));
assert.strictEqual(R.modeOf(cfg, wa, undefined, 'PHONE'), 'hide', 'kept across a reload');

Object.assign(cfg, R.clean({ fromApp: { from: 'PHONE', app: 'com.whatsapp', hide: false } }, cfg));
assert.deepStrictEqual(cfg.fromApps, {}, 'shown again: nothing left for that device');
assert.strictEqual(R.modeOf(cfg, wa, undefined, 'PHONE'), 'show');

assert.deepStrictEqual(R.clean({ fromApp: { from: '', app: 'x', hide: true } }, cfg), {}, 'no device: ignored');
console.log('notif-from-apps: ok');
