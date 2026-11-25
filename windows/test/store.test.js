// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for windows/store.js: a rename Windows refuses for a moment (another process has the file
// open) is tried again, then written in place; a save that can't be done is logged, never thrown.
// Run with: node --test windows/test/store.test.js
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let tempDir;
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => tempDir } };
  return load.call(this, id, ...args);
};
const store = require('../store');
Module._load = load;

function fixture(t, { renameFails = 0, code = 'EPERM' } = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-store-'));
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (a, b) => {
    calls++;
    if (calls <= renameFails) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    return rename(a, b);
  };
  const warn = console.warn;
  const error = console.error;
  const logged = [];
  console.warn = (m) => logged.push(m);
  console.error = (m) => logged.push(m);
  t.after(() => {
    fs.renameSync = rename;
    console.warn = warn;
    console.error = error;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { calls: () => calls, logged };
}

test('a plain save: the file has it, no temp file left', (t) => {
  const f = fixture(t);
  assert.equal(store.write('multi.json', { on: true }), true);
  assert.deepEqual(store.read('multi.json'), { on: true });
  assert.equal(fs.existsSync(path.join(tempDir, 'multi.json.tmp')), false);
  assert.equal(f.calls(), 1);
});

test('the rename refused a few times (EPERM): tried again, saved atomically', (t) => {
  const f = fixture(t, { renameFails: 3 });
  assert.equal(store.write('multi.json', { on: true, rev: 2 }), true);
  assert.deepEqual(store.read('multi.json'), { on: true, rev: 2 });
  assert.equal(f.calls(), 4);
  assert.deepEqual(f.logged, []);
});

test('the rename always refused: written in place, the temp file removed, logged', (t) => {
  const f = fixture(t, { renameFails: Infinity, code: 'EBUSY' });
  fs.writeFileSync(path.join(tempDir, 'multi.json'), JSON.stringify({ on: false }));
  assert.equal(store.write('multi.json', { on: true }), true);
  assert.deepEqual(store.read('multi.json'), { on: true });
  assert.equal(fs.existsSync(path.join(tempDir, 'multi.json.tmp')), false);
  assert.match(f.logged.join('\n'), /multi\.json: the rename failed \(EBUSY\), written in place/);
});

test('a save that can\'t be done returns false, never throws', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(tempDir, 'multi.json.tmp')); // the temp file can't be written
  assert.equal(store.write('multi.json', { on: true }), false);
  assert.equal(f.calls(), 0);
  assert.match(f.logged.join('\n'), /multi\.json not saved/);
});
