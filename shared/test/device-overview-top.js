// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../ui-device.js'), 'utf8');
const line = source.split('\n').find(text => /const top = \(phone/.test(text));
assert(line, 'found the production overview top-app expression');
const run = (phone, top, apps) => vm.runInNewContext(line + '\ntop;', { phone, ph: { top }, apps });
assert.deepStrictEqual(Array.from(run(false, [], [])), [], 'computer overview must not call map on false');
const apps = [{ id: 'a' }, { id: 'b' }];
assert.deepStrictEqual(Array.from(run(true, ['b', 'missing', 'a'], apps), app => app.id), ['b', 'a'], 'phone ordering and unknown-app filtering are preserved');
assert.strictEqual(run(true, Array(10).fill('a'), apps).length, 8, 'phone overview still limits the tiles');
assert.strictEqual(run(true, undefined, apps).length, 0);
console.log('device-overview-top: computer and phone overview branches passed');
