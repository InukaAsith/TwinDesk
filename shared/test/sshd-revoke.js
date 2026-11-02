// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal's host side (linux/sshd.js; windows/sshd.js does the same, its admin file through
// scripts/sshd-key.ps1 -All): switching Terminal off, or forgetting the device, leaves no key of
// ours in authorized_keys, even one added before a restart, and never touches the user's own keys.
// Run with: node shared/test/sshd-revoke.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshd-revoke-'));
process.env.HOME = home; // os.homedir(): ~/.ssh/authorized_keys is read at load
process.env.USERPROFILE = home;
const Sshd = require('../../linux/sshd.js');
Sshd.prototype.refresh = async function () { this.service = 'running'; }; // no sshd here: taken as running

const KEYS = path.join(home, '.ssh', 'authorized_keys');
const OWN = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnKeyOfTheUser me@laptop';
const PEER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPeerKeyFromTheOtherSide';

function make(allowMac) {
  const link = new EventEmitter();
  link.sent = [];
  link.send = (m) => link.sent.push(m);
  link.snapshot = () => ({ session: { id: 'peer-1' } });
  const settings = { terminal: { allowMac, installedKey: '' } };
  const s = new Sshd({ link, settings, save: () => {}, onChange: () => {} });
  return { s, link, settings };
}
const lines = () => fs.readFileSync(KEYS, 'utf8').split('\n').filter(Boolean);

(async () => {
  fs.mkdirSync(path.dirname(KEYS), { recursive: true });
  fs.writeFileSync(KEYS, OWN + '\n');

  // On: the other side's key is added, the user's own stays.
  const { s, link, settings } = make(true);
  link.emit(P().T.SSH_KEY, { pub: PEER });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(lines().length, 2);
  assert.ok(lines().some((l) => l.includes(PEER) && l.endsWith(' macshare:peer-1')));
  assert.ok(settings.terminal.installedKey);

  // Off: our line is gone, the user's own is kept, and the other side is told.
  settings.terminal.allowMac = false;
  await s.apply();
  assert.deepStrictEqual(lines(), [OWN]);
  assert.strictEqual(settings.terminal.installedKey, '');
  assert.strictEqual(link.sent[link.sent.length - 1].enabled, false);

  // On again: the key it still has in memory goes back in, no new ssh.key needed.
  settings.terminal.allowMac = true;
  await s.apply();
  assert.strictEqual(lines().length, 2);

  // After a restart (no key in memory, another session id), off still removes it.
  const r = make(false);
  r.settings.terminal.installedKey = settings.terminal.installedKey;
  r.link.snapshot = () => ({ session: { id: 'some-other-id' } });
  await r.s.apply();
  assert.deepStrictEqual(lines(), [OWN], 'removed whatever session is open');

  // Forgetting the device (Forget in the app): removed too, and the key is dropped from memory.
  const f = make(true);
  f.link.emit(P().T.SSH_KEY, { pub: PEER });
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(lines().length, 2);
  f.s.revokeAll();
  assert.deepStrictEqual(lines(), [OWN]);
  assert.strictEqual(f.s.pendingKey, null);

  fs.rmSync(home, { recursive: true, force: true });
  console.log('sshd-revoke: ok');
})().catch((e) => { console.error(e); process.exit(1); });

function P() { return require('../protocol.js'); }
