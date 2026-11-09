// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Exercise both real reset entry points with a fake process runner; never touch TCC.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resetMissing } = require('../permission-reset');

async function check(file, id, failReset = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('let staleChecked = false;');
  const end = source.indexOf('// Setup shows once:', start);
  assert.ok(start >= 0 && end > start, `missing permission handler in ${file}`);
  const resets = [];
  let saves = 0, refreshes = 0, warnings = 0;
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const execFile = (name, args, cb) => {
    if (name === '/usr/bin/codesign') return setImmediate(() => cb(null, 'designated => test-signature', ''));
    if (name === '/usr/bin/plutil') return setImmediate(() => cb(null, id));
    if (name === '/usr/bin/tccutil') {
      resets.push(args);
      return setImmediate(() => cb(failReset ? new Error('reset failed') : null));
    }
    throw new Error(`unexpected program ${name}`);
  };
  const context = {
    app: { isPackaged: true }, path, process: { execPath: '/some/Test.app/Contents/MacOS/TwinDesk' },
    settings: { app: { signature: 'old' } },
    state: { permissions: { screen: 'denied', accessibility: false, inputMonitoring: false } },
    store: { saveSettings() { saves++; } }, refreshPermissions() { refreshes++; finished(); },
    console: { log() {}, warn() { warnings++; finished(); } },
    require(name) {
      if (name === 'child_process') return { execFile };
      if (name === './permission-reset' || name === '../permission-reset') return { resetMissing };
      throw new Error(`unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nclearStalePermissions();`, context, { filename: file });
  await done;
  assert.deepEqual(resets.map((args) => Array.from(args)), [
    ['reset', 'ScreenCapture', id], ['reset', 'Accessibility', id], ['reset', 'ListenEvent', id],
  ]);
  assert.equal(saves, failReset ? 0 : 1);
  assert.equal(refreshes, failReset ? 0 : 1);
  assert.equal(warnings, failReset ? 1 : 0);
}

(async () => {
  for (const file of ['main.js', 'mesh/main.js']) {
    await check(file, 'org.macshare.portals.safe');
    await check(file, 'org.macshare.mac');
    await check(file, 'org.macshare.portals.safe', true);
  }
  console.log('permission reset: both app modes use their own identity and fail closed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
