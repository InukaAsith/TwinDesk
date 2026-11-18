// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/appstart.js: HyperOS gets the app full screen through adb on scrcpy's display; other
// phones, and any failure, go through scrcpy's start_app (#265).
'use strict';
const assert = require('assert');
const a = require('../appstart.js');

(async () => {
  assert.strictEqual(a.displayIdOf(['x', '[server] INFO: New display: 1080x2400/440 (id=12)']), 12);
  assert.strictEqual(a.displayIdOf(['nothing']), null);
  assert.strictEqual(a.component('priority=0\ncom.miui.calculator/.cal.CalculatorActivity\n', 'com.miui.calculator'), 'com.miui.calculator/.cal.CalculatorActivity');
  assert.strictEqual(a.component('No activity found', 'com.x'), '');
  let started = null;
  const s = { log: ['INFO: New display: 1x1/1 (id=7)'], startApp: (x) => (started = x) };
  const cmds = [];
  const adb = { shell: async (_s, c) => (cmds.push(c), c.startsWith('cmd') ? { out: 'com.miui.calculator/.Main' } : { out: 'Starting: Intent' }) };
  await a.startApp(s, { adb, serial: 'x', maker: 'Xiaomi', app: 'com.miui.calculator' });
  assert.deepStrictEqual(cmds.slice(-1), ['am start --display 7 --windowingMode 1 -n com.miui.calculator/.Main']);
  assert.strictEqual(started, null);
  await a.startApp(s, { adb, serial: 'x', maker: 'samsung', app: 'com.x.y' });
  assert.strictEqual(started, 'com.x.y', 'other phones: scrcpy');
  started = null;
  const bad = { shell: async (_s, c) => (c.startsWith('cmd') ? { out: 'com.p.q/.M' } : { out: 'Error: Activity not started' }) };
  await a.startApp(s, { adb: bad, serial: 'x', maker: 'Redmi', app: 'com.p.q' });
  assert.strictEqual(started, 'com.p.q', 'am start failed: scrcpy');
  started = null;
  await a.startApp(s, { adb, serial: 'x', maker: 'Xiaomi', app: 'com.p.q; reboot' });
  assert.strictEqual(started, 'com.p.q; reboot', 'never a shell command from an odd name');
  console.log('appstart: ok');
})().catch((e) => { console.error(e); process.exit(1); });
