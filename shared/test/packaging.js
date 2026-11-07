// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
'use strict';

// Every shared module an app requires has to be in its installer. A list kept by hand once left the
// Windows installer without shared/mesh.js: the installed app died at start ("Cannot find module").
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const shared = fs.readdirSync(path.join(ROOT, 'shared')).filter((f) => f.endsWith('.js'));

// 1. what the apps require from shared/ exists there (the app folders and their multi-device mesh/ folders)
const required = new Set();
for (const dir of ['windows', 'mac', 'linux', 'windows/mesh', 'mac/mesh', 'linux/mesh']) {
  if (!fs.existsSync(path.join(ROOT, dir))) continue;
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
    for (const m of read(`${dir}/${f}`).matchAll(/require\('(?:\.\.\/)+shared\/([a-z0-9-]+(?:\.js)?)'\)/g)) {
      required.add(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
    }
  }
}
for (const f of required) assert.ok(shared.includes(f), `shared/${f} is required but missing`);

// 2. the installers stage the WHOLE shared folder, not a list
for (const f of ['windows/installer/build.js', 'linux/installer/build.js']) {
  const s = read(f);
  const perFile = /readdirSync\(path\.join\(ROOT, 'shared'\)\)/.test(s) && /\.\(js\|css\|html\)/.test(s);
  const wholeDir = /copy\(path\.join\(ROOT, 'shared'\), path\.join\(STAGE, 'shared'\)/.test(s) && /\.\(js\|css\|html\)/.test(s);
  assert.ok(perFile || wholeDir, `${f} copies every shared/*.js`);
  assert.ok(!/copy\(path\.join\(ROOT, 'shared', '(?!protocol)[a-z-]+\.js'\)/.test(s), `${f} has no hand-kept list of shared files`);
  assert.ok(/name === 'lang'/.test(s), `${f} stages shared/lang for shared player imports`);
  assert.ok(/name === 'airplay'/.test(s), `${f} stages shared/airplay (the AirPlay receiver)`);
}
// The Windows filter applies at every depth: the receiver's wasm has to pass it too.
assert.ok(/name === 'playfair\.wasm'/.test(read('windows/installer/build.js')), 'windows/installer/build.js stages shared/airplay/playfair.wasm');
assert.ok(/cp "\$ROOT"\/shared\/\*\.js/.test(read('mac/build-app.sh')), 'mac/build-app.sh copies every shared/*.js');
assert.ok(/cp -R "\$ROOT\/shared\/lang"/.test(read('mac/build-app.sh')), 'mac/build-app.sh stages shared/lang');

console.log(`packaging: passed (${required.size} shared modules required, all staged)`);
