// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A laptop's battery in dev.state (shared/devlocal.js, shared/devctl.js): Linux's power_supply files
// (a mouse's battery isn't the computer's), the range, and what dev.state keeps of it.
// Run with: node shared/test/devlocal-battery.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { battery, linuxBattery } = require('../devlocal.js');

assert.deepStrictEqual(battery(85, true), { battery: 85, charging: true });
assert.deepStrictEqual(battery('100', false), { battery: 100, charging: false });
assert.deepStrictEqual(battery(255, false), {}); // Win32_Battery's "unknown"
assert.deepStrictEqual(battery(NaN, false), {});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ps-'));
const dev = (name, files) => { fs.mkdirSync(path.join(root, name)); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(root, name, k), v + '\n'); };
assert.deepStrictEqual(linuxBattery(root), {}, 'a desktop: no battery');
dev('AC', { type: 'Mains', online: '1' });
dev('hidpp_battery_0', { type: 'Battery', scope: 'Device', capacity: '40', status: 'Discharging' }); // a wireless mouse
assert.deepStrictEqual(linuxBattery(root), {});
dev('BAT0', { type: 'Battery', capacity: '57', status: 'Charging' });
assert.deepStrictEqual(linuxBattery(root), { battery: 57, charging: true });
fs.writeFileSync(path.join(root, 'BAT0', 'status'), 'Not charging\n'); // plugged in, held at a limit
assert.deepStrictEqual(linuxBattery(root), { battery: 57, charging: false });
assert.deepStrictEqual(linuxBattery(path.join(root, 'missing')), {});
fs.rmSync(root, { recursive: true, force: true });

// dev.state keeps a battery in range only.
const { EventEmitter } = require('events');
const { DevCtl } = require('../devctl.js');
const ev = new EventEmitter();
const d = new DevCtl({ link: { on: (e, fn) => ev.on(e, fn), send() {}, current: { os: 'win' } }, local: { can: () => ({}), state: async () => ({}), stop() {} } });
ev.emit('dev.state', { can: {}, battery: 42, charging: true });
assert.strictEqual(d.view.battery, 42);
assert.strictEqual(d.view.charging, true);
ev.emit('dev.state', { can: {}, battery: 400 });
assert.strictEqual(d.view.battery, undefined);
d.stop();
console.log('devlocal-battery: ok');
