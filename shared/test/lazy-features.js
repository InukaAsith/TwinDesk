// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Features with a switch that's off until turned on (or can be turned off) aren't loaded while off:
// their modules are required only where they're made (load…() in main.js, loadPad), never at the
// top of a main.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LAZY = {
  'windows/main.js': ['nowplaying', 'btaudio', 'terminal', 'gamepad', 'camshare', 'vcam', 'phone-remote', 'rezume', 'rezume-shelf', 'activity', 'mic'],
  'linux/main.js': ['nowplaying', 'btaudio', 'a2dp', 'terminal', 'gamepad', 'camshare', 'vcam', 'phone-remote', 'rezume', 'rezume-shelf', 'activity', 'mic'],
  'mac/main.js': ['nowplaying', 'camshare', 'vcam', 'phone-remote', 'rezume', 'rezume-shelf', 'activity', 'mic'],
  'windows/mesh/main.js': ['mic'],
  'linux/mesh/main.js': ['mic'],
  'mac/mesh/main.js': ['mic'],
  // Move windows: its code loads only once a window moves
  'windows/pcapps.js': ['movewin'],
  'linux/pcapps.js': ['movewin'],
  'mac/appsend.js': ['movewin'],
};

for (const [file, mods] of Object.entries(LAZY)) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const line of src.split('\n')) {
    if (!/^(const|let|var)\b.*require\(/.test(line)) continue; // top level only
    for (const m of mods) assert.ok(!new RegExp(`require\\(['"][./]*(shared/)?${m}(\\.js)?['"]\\)`).test(line), `${file} loads ${m} at start: ${line.trim()}`);
  }
  for (const m of mods) assert.ok(new RegExp(`require\\(['"][./]*(shared/)?${m}(\\.js)?['"]\\)`).test(src), `${file}: ${m} is never loaded`);
}

// Turned off, Camera stays loaded (stopped): the tab's switch shows the setting, not that it's loaded
// (it was on: true whenever CamShare existed, so the switch couldn't be turned off).
for (const file of Object.keys(LAZY)) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  assert.ok(!/camShare\.state, on: true/.test(src), `${file}: Camera's switch shows on whenever CamShare is loaded`);
}

console.log('lazy-features: passed');
