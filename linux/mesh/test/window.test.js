// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The Linux mesh window (linux/mesh/app.html) loads every script it names, and the same shared ones
// as the Windows mesh window it was made from: without shared/sidebar-model.js, mesh/app.js threw on
// every redraw (no device list, no layout grid).
// Run with: node linux/mesh/test/window.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

// The scripts a mesh window loads, as paths from the repo root (<base href="../">: from the platform folder).
function scripts(platform) {
  const html = fs.readFileSync(path.join(ROOT, platform, 'mesh', 'app.html'), 'utf8');
  assert.ok(html.includes('<base href="../">'), `${platform}: the page loads from its platform folder`);
  // A module script (shared/modload.js) counts as the script it loads.
  return [...html.matchAll(/<script src="([^"]+)"(?: data-src="([^"]+)")?><\/script>/g)].map((m) => path.posix.normalize(`${platform}/${m[2] || m[1]}`));
}

const linux = scripts('linux');
const windows = scripts('windows');
for (const s of [...linux, ...windows]) assert.ok(fs.existsSync(path.join(ROOT, s)), `${s} exists`);

const WINDOWS_ONLY = ['shared/ui-portable.js']; // TwinDesk Portable is a Windows build (windows/portable.js)
const shared = (list) => list.filter((s) => s.startsWith('shared/') && !WINDOWS_ONLY.includes(s));
assert.deepStrictEqual(shared(linux), shared(windows), 'the same shared scripts, in the same order');
assert.ok(linux.indexOf('shared/sidebar-model.js') >= 0 && linux.indexOf('shared/sidebar-model.js') < linux.indexOf('linux/mesh/app.js'),
  'sidebar-model.js before mesh/app.js, which uses it');

console.log('window: passed');
