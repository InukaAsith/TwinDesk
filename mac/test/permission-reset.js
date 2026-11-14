// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Verify reset targets without changing any macOS privacy permissions.
'use strict';

const assert = require('node:assert/strict');
const { resetMissing } = require('../permission-reset');

function run(id, { readError = null, resetError = null, services = ['ScreenCapture', 'Accessibility'] } = {}) {
  const calls = [];
  return new Promise((resolve) => {
    const exec = (file, args, cb) => {
      calls.push({ file, args });
      if (file === '/usr/bin/plutil') return setImmediate(() => cb(readError, id));
      if (file === '/usr/bin/tccutil') return setImmediate(() => cb(resetError));
      throw new Error(`unexpected executable: ${file}`);
    };
    resetMissing('/some/Test.app', services, exec, (err) => resolve({ err, calls }));
  });
}

(async () => {
  const copy = await run('org.macshare.portals.test\n');
  assert.ifError(copy.err);
  assert.deepEqual(copy.calls.slice(1).map((c) => c.args), [
    ['reset', 'ScreenCapture', 'org.macshare.portals.test'],
    ['reset', 'Accessibility', 'org.macshare.portals.test'],
  ]);
  const standard = await run('org.macshare.mac\n');
  assert.ifError(standard.err);
  assert.ok(standard.calls.slice(1).every((c) => c.args[2] === 'org.macshare.mac'));
  for (const invalid of ['', 'org.macshare.mac\nother', 'org.macshare.mac;other', '../org.macshare.mac']) {
    const result = await run(invalid);
    assert.ok(result.err, 'invalid bundle identity must fail closed');
    assert.equal(result.calls.length, 1, 'never reset another application');
  }
  const unreadable = await run('', { readError: new Error('unreadable plist') });
  assert.ok(unreadable.err);
  assert.equal(unreadable.calls.length, 1);
  const failedReset = await run('org.macshare.mac', { resetError: new Error('reset failed') });
  assert.ok(failedReset.err, 'the caller can retry on a later launch');
  const none = await run('', { services: [] });
  assert.ifError(none.err);
  assert.equal(none.calls.length, 0);
  console.log('permission reset scope: ok');
})().catch((err) => { console.error(err); process.exitCode = 1; });
