// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Whether the console session on this Mac is locked. Read-only: ioreg and plutil.
// A failed read, a missing list, or a list that is not the console users is null.
// Null is unknown. A preview treats unknown the same as locked and does not capture.
// This does not open Screen Sharing, store a credential, or draw the login window.
'use strict';

const { execFile } = require('child_process');

function run(file, args, input) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
    if (input !== undefined && child && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Only this user's single, fully logged-in console session proves a usable read.
// IOConsoleUsers omits ScreenIsLocked when unlocked on macOS 27; a read-only
// probe confirmed that shape here. A missing/foreign/ambiguous session is unknown.
function lockedConsole(users, uid) {
  if (!Array.isArray(users) || !Number.isInteger(uid) || uid < 0) return null;
  const consoleUsers = users.filter((u) => u && u.kCGSSessionOnConsoleKey === true);
  if (consoleUsers.length !== 1 || consoleUsers[0].kCGSSessionUserIDKey !== uid ||
      consoleUsers[0].kCGSessionLoginDoneKey !== true) return null;
  const locked = consoleUsers[0].CGSSessionScreenIsLocked;
  return locked === true ? true : (locked === false || locked === undefined) ? false : null;
}

// false: unlocked. true: locked. null: unknown, which must not capture.
async function readLocked(execute = run, uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  const plist = await execute('/usr/sbin/ioreg', ['-a', '-n', 'Root', '-d1']);
  if (plist === null) return null;
  let json = await execute('/usr/bin/plutil', ['-extract', 'IOConsoleUsers', 'json', '-o', '-', '-'], plist);
  if (json === null) json = await execute('/usr/bin/plutil', ['-extract', '0.IOConsoleUsers', 'json', '-o', '-', '-'], plist);
  if (typeof json !== 'string') return null;
  try {
    const users = JSON.parse(json);
    return Array.isArray(users) ? lockedConsole(users, uid) : null;
  } catch { return null; }
}

module.exports = { readLocked, lockedConsole };
