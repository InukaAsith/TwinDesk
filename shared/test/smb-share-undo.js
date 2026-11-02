// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/scripts/smb-share.sh with every macOS command stubbed (no root, any OS with sh): a step that
// fails undoes what this run added and only that (#34, #56); a second share adds no second ACL entry.
// Run with: node shared/test/smb-share-undo.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../mac/scripts/smb-share.sh');
const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
if (sh.status !== 0) { console.log('smb-share-undo: skipped (no sh)'); process.exit(0); }

// The stubs log each call to $LOG; FAIL=<name> makes that command fail; HAVE_USER=1 and
// HAVE_ACL=1 say the account / the folder's entry are there already.
const STUBS = {
  id: '[ -n "$HAVE_USER" ] || [ -f "$STATE/user" ]',
  sysadminctl: 'case "$1" in -addUser) touch "$STATE/user";; -deleteUser) rm -f "$STATE/user";; esac',
  dscl: 'true', pwpolicy: 'true', dseditgroup: 'true',
  chmod: 'case "$1" in +a) touch "$STATE/acl";; -a) rm -f "$STATE/acl";; esac',
  ls: '[ -n "$HAVE_ACL" ] || [ -f "$STATE/acl" ] && echo " 0: user:macshare allow list"; true',
  sharing: 'case "$1" in -a) touch "$STATE/share";; -r) rm -f "$STATE/share";; esac',
  launchctl: 'true',
};

function run(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-share-'));
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const dir = path.join(root, 'Shared');
  for (const d of [bin, state, dir]) fs.mkdirSync(d);
  for (const [name, body] of Object.entries(STUBS)) {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "$LOG"\n[ "$FAIL" = "${name}" ] && [ "$FAIL_ARG" = "" -o "$1" = "$FAIL_ARG" ] && exit 1\n${body}\n`);
    fs.chmodSync(f, 0o755);
  }
  const pw = path.join(root, 'pw');
  fs.writeFileSync(pw, 'secret');
  if (env.HAVE_USER) fs.writeFileSync(path.join(state, 'user'), '');
  if (env.HAVE_ACL) fs.writeFileSync(path.join(state, 'acl'), '');
  const log = path.join(root, 'log');
  fs.writeFileSync(log, '');
  const r = spawnSync('sh', [SCRIPT, dir, pw], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, LOG: log, STATE: state, ...env },
  });
  const has = (n) => fs.existsSync(path.join(state, n));
  const out = { status: r.status, user: has('user'), acl: has('acl'), share: has('share'), log: fs.readFileSync(log, 'utf8'), pwGone: !fs.existsSync(pw) };
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows: best effort */ }
  return out;
}

// Success: everything stays.
let r = run({});
assert.strictEqual(r.status, 0, r.log);
assert.deepStrictEqual([r.user, r.acl, r.share, r.pwGone], [true, true, true, true]);

// A new account, chmod +a fails (a privacy-protected folder): the account goes again.
r = run({ FAIL: 'chmod' });
assert.notStrictEqual(r.status, 0);
assert.deepStrictEqual([r.user, r.acl, r.share], [false, false, false], 'nothing left behind');

// An account from before (sharing again), chmod +a fails: the account stays.
r = run({ FAIL: 'chmod', HAVE_USER: '1' });
assert.notStrictEqual(r.status, 0);
assert.strictEqual(r.user, true, "an account this run didn't add is kept");

// sharing -a fails: its ACL entry and the new account are removed.
r = run({ FAIL: 'sharing', FAIL_ARG: '-a' });
assert.notStrictEqual(r.status, 0);
assert.deepStrictEqual([r.user, r.acl, r.share], [false, false, false]);

// The SMB server can't be switched on: the share it added comes off too.
r = run({ FAIL: 'launchctl', FAIL_ARG: 'enable' });
assert.notStrictEqual(r.status, 0);
assert.deepStrictEqual([r.user, r.acl, r.share], [false, false, false]);

// Sharing the same folder again: no second ACL entry, and a later failure leaves the first one.
r = run({ HAVE_USER: '1', HAVE_ACL: '1' });
assert.strictEqual(r.status, 0);
assert.ok(!/chmod \+a/.test(r.log), 'the entry was there: not added again');
r = run({ HAVE_USER: '1', HAVE_ACL: '1', FAIL: 'sharing', FAIL_ARG: '-a' });
assert.strictEqual(r.acl, true, 'an entry from before stays');

console.log('smb-share-undo: ok');
