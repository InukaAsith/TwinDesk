// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The console lock read fails closed. Unknown is not unlocked.
// Run with: node shared/test/console-lock.js
'use strict';

const assert = require('assert');
const { readLocked, lockedConsole } = require('../../mac/console-lock.js');
const Preview = require('../display-preview.js');

function user(uid, locked) {
  return {
    kCGSSessionOnConsoleKey: true,
    kCGSSessionUserIDKey: uid,
    kCGSessionLoginDoneKey: true,
    CGSSessionScreenIsLocked: locked,
  };
}

assert.strictEqual(lockedConsole([user(501, true)], 501), true);
assert.strictEqual(lockedConsole([user(501, false)], 501), false);
assert.strictEqual(lockedConsole([user(501, true)], 502), null);
assert.strictEqual(lockedConsole([user(501, true), user(501, true)], 501), null);
assert.strictEqual(lockedConsole(null, 501), null);
assert.strictEqual(lockedConsole([], 501), null);
assert.strictEqual(lockedConsole([user(501, undefined)], 501), false);
assert.strictEqual(lockedConsole([{ ...user(501, false), kCGSessionLoginDoneKey: false }], 501), null);
assert.strictEqual(lockedConsole([user(501, 'false')], 501), null);
assert.strictEqual(Preview.screenUnlocked(false), true);
assert.strictEqual(Preview.screenUnlocked(true), false);
assert.strictEqual(Preview.screenUnlocked(null), false);

async function main() {
  assert.strictEqual(await readLocked(async () => null, 501), null);
  assert.strictEqual(await readLocked(async (file) => (file.endsWith('ioreg') ? '<plist/>' : null), 501), null);
  assert.strictEqual(await readLocked(async (file) => (file.endsWith('ioreg') ? '<plist/>' : 'not-json'), 501), null);
  assert.strictEqual(await readLocked(async (file) => (file.endsWith('ioreg') ? '<plist/>' : '{"not":"users"}'), 501), null);
  const locked = JSON.stringify([user(501, true)]);
  assert.strictEqual(await readLocked(async (file) => (file.endsWith('ioreg') ? '<plist/>' : locked), 501), true);
  const open = JSON.stringify([user(501, false)]);
  assert.strictEqual(await readLocked(async (file) => (file.endsWith('ioreg') ? '<plist/>' : open), 501), false);
  let sawFallback = false;
  const viaRoot = await readLocked(async (file, args) => {
    if (file.endsWith('ioreg')) return '<plist/>';
    if (args.includes('IOConsoleUsers')) return null;
    sawFallback = args.includes('0.IOConsoleUsers');
    return open;
  }, 501);
  assert.strictEqual(viaRoot, false);
  assert.strictEqual(sawFallback, true);
  console.log('console-lock: unknown is not unlocked, and a locked console is locked.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
