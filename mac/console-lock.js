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

// True only for this user's single console session with login finished and the
// screen locked. Anything else that is still a user list is not that lock.
function lockedConsole(users, uid) {
  if (!Array.isArray(users)) return false;
  const consoleUsers = users.filter((u) => u && u.kCGSSessionOnConsoleKey === true);
  return consoleUsers.length === 1 && consoleUsers[0].kCGSSessionUserIDKey === uid &&
    consoleUsers[0].kCGSessionLoginDoneKey === true && consoleUsers[0].CGSSessionScreenIsLocked === true;
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
