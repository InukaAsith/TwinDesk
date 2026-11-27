// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal's host side in Multi-device (linux/sshd.js; windows/sshd.js the same): each device's key line is
// remembered by its id, so switching between two devices that both have keys installs each once, instead
// of rewriting authorized_keys at every switch (behind an administrator prompt on Windows).
// Run with: node shared/test/sshd-perdevice.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshd-perdevice-'));
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
const P = require('../protocol.js');
const Sshd = require('../../linux/sshd.js');
Sshd.prototype.refresh = async function () { this.service = 'running'; };

const KEYS = path.join(home, '.ssh', 'authorized_keys');
const KEY = { A: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyOfDeviceA', B: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyOfDeviceB' };

(async () => {
  const link = new EventEmitter();
  link.send = () => {};
  let who = 'A';
  link.snapshot = () => ({ session: { id: who } }); // the facade: the selected device
  const settings = { terminal: { allowMac: true, installedKey: '' } };
  const s = new Sshd({ link, settings, save: () => {}, onChange: () => {} });
  let installs = 0;
  const install = s._install.bind(s);
  s._install = (line) => { installs++; return install(line); };
  const key = async (id) => { who = id; link.emit(P.T.SSH_KEY, { pub: KEY[id] }); await new Promise((r) => setTimeout(r, 30)); };

  await key('A');
  await key('B');
  assert.strictEqual(installs, 2, 'each once');
  for (let i = 0; i < 3; i++) { await key('A'); await key('B'); } // the selection goes back and forth
  assert.strictEqual(installs, 2, 'no rewrite at a switch');
  const lines = fs.readFileSync(KEYS, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.some((l) => l.endsWith(' macshare:A')) && lines.some((l) => l.endsWith(' macshare:B')), 'both lines there');
  assert.deepStrictEqual(Object.keys(settings.terminal.installedKeys).sort(), ['A', 'B']);

  // A forgets its key: only its line goes; B's stays and isn't installed again.
  who = 'A';
  link.emit(P.T.SSH_FORGET, {});
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(Object.keys(settings.terminal.installedKeys), ['B']);
  assert.ok(settings.terminal.installedKey, 'B is still installed');
  await key('B');
  assert.strictEqual(installs, 2);

  // Off: every line of ours goes, and the list with them.
  settings.terminal.allowMac = false;
  await s.apply();
  assert.deepStrictEqual(settings.terminal.installedKeys, {});
  assert.strictEqual(settings.terminal.installedKey, '');
  console.log('sshd-perdevice: ok');
})().catch((e) => { console.error(e); process.exit(1); });
