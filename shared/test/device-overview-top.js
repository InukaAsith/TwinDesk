// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// The most used apps on a phone's Overview (shared/ui-device-parts.js lower(): only the Android page asks for them).
const source = fs.readFileSync(path.join(__dirname, '../ui-device-parts.js'), 'utf8');
const line = source.split('\n').find(text => /const list = top\.map\(/.test(text));
assert(line, 'found the production overview top-app expression');
const run = (top, apps) => vm.runInNewContext(line + '\nlist;', { top, apps });
assert.deepStrictEqual(Array.from(run([], [])), [], 'nothing reported: no tiles');
const apps = [{ id: 'a' }, { id: 'b' }];
assert.deepStrictEqual(Array.from(run(['b', 'missing', 'a'], apps), app => app.id), ['b', 'a'], 'phone ordering and unknown-app filtering are preserved');
assert.strictEqual(run(Array(10).fill('a'), apps).length, 8, 'phone overview still limits the tiles');
// The pages pass top only where it exists (default []): the computer's and the iPhone's never ask.
for (const f of ['ui-device-pc.js', 'ui-device-ios.js']) assert(!/withApps: true/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ' has no most used apps');
assert(/withApps: true/.test(fs.readFileSync(path.join(__dirname, '../ui-device-android.js'), 'utf8')), 'Android has its most used apps');
console.log('device-overview-top: the most used apps passed');
