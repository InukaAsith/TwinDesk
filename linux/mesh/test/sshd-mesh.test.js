// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/sshd.js in Multi-device (the hub's bus, shared/consent.js): every device's ssh.key is heard and
// installed under its own marker, by its own pair's "Let {name} open a terminal". On the facade a key from
// a device that wasn't selected was dropped, and a crossing to a pair with it off removed every key (#313).
// Run: node linux/mesh/test/sshd-mesh.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshd-mesh-'));
process.env.HOME = home; // KEYS is ~/.ssh/authorized_keys, read when the module loads
const P = require('../../../shared/protocol.js');
const Sshd = require('../../sshd.js');

const T = P.T;
const KEYS = path.join(home, '.ssh', 'authorized_keys');
const keyA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const lines = () => (fs.existsSync(KEYS) ? fs.readFileSync(KEYS, 'utf8').split('\n').filter(Boolean) : []);
const markers = () => lines().map((l) => l.split(' macshare:')[1]).sort();

async function main() {
  const on = new Map();
  const peers = [];
  const sent = [];
  let selected = 'A';
  const bus = {
    on: (t, fn) => on.set(t, fn),
    onPeer: (ev, fn) => peers.push([ev, fn]),
    send: (id, m) => { sent.push([id, m]); return true; },
    selectedId: () => selected,
  };
  const pairs = { A: true, B: true }; // each device's "Let it open a terminal here"
  const consent = { get: (id, f, dir) => (f === 'terminal' && dir === 'out' ? !!pairs[id] : false) };
  const settings = { terminal: { allowMac: true, installedKey: '', installedKeys: {} } };
  const link = { on: () => { throw new Error('the facade isn’t used in Multi-device'); } };
  const sshd = new Sshd({ link, bus, consent, settings, save: () => {}, onChange: () => {} });
  sshd.refresh = async () => { sshd.service = 'running'; };

  // B isn't selected: its key is heard and goes in under B's marker; then A's under A's.
  await on.get(T.SSH_KEY)({ pub: keyB }, 'B');
  await on.get(T.SSH_KEY)({ pub: keyA }, 'A');
  assert.deepStrictEqual(markers(), ['A', 'B'], 'each device’s key, under its own marker');
  assert.ok(lines().find((l) => l.endsWith('macshare:B')).includes(keyB), 'B’s line has B’s key');
  assert.deepStrictEqual(sent.filter(([, m]) => m.t === T.SSH_INFO).map(([id, m]) => [id, m.enabled]), [['B', true], ['A', true]], 'each told it’s ready');
  assert.strictEqual(sshd.view().macAsked, true, 'the page shows A, the selected device');

  // A crossing to B, whose pair is on, with A's pair off: only A's key comes out.
  pairs.A = false;
  selected = 'B';
  await sshd.apply();
  assert.deepStrictEqual(markers(), ['B'], 'B’s key stays');
  assert.deepStrictEqual(sent.pop(), ['A', { t: T.SSH_INFO, enabled: false, why: 'not_allowed' }]);

  // A's pair on again: its key, still in memory, goes back in.
  pairs.A = true;
  await sshd.apply();
  assert.deepStrictEqual(markers(), ['A', 'B']);

  // B forgets this computer: B's line only.
  await on.get(T.SSH_FORGET)({}, 'B');
  assert.deepStrictEqual(markers(), ['A']);
  // A goes away: its key stays installed (it's paired), its pending key is gone from memory.
  for (const [ev, fn] of peers) if (ev === 'closed') fn('A');
  assert.deepStrictEqual(markers(), ['A']);
  selected = 'A';
  assert.strictEqual(sshd.view().macAsked, false);
  console.log('sshd-mesh: ok');
}

main().then(() => fs.rmSync(home, { recursive: true, force: true }), (e) => {
  fs.rmSync(home, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
