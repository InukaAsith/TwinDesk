// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/sshconfig.js with an alias per device (Multi-device): `Host twindesk-<name>` blocks beside
// `Host twindesk`, each written and removed alone, the user's own lines untouched, and a `twindesk` block
// from before (its old end marker) replaced cleanly.
// Run: node shared/test/sshconfig-mesh.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshconfig-mesh-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const SshConfig = require('../sshconfig.js');

const CONFIG = path.join(home, '.ssh', 'config');
const read = () => fs.readFileSync(CONFIG, 'utf8');
const hosts = () => read().split('\n').filter((l) => /^Host /.test(l)).map((l) => l.slice(5));
const host = (address) => ({ address, port: 22, user: 'me', identityFile: '/k', knownHostsFile: '/kh' });

try {
  assert.strictEqual(SshConfig.aliasFor('Ryzen9', 'x'), 'twindesk-ryzen9');
  assert.strictEqual(SshConfig.aliasFor('MacBook Air de Ortega', 'x'), 'twindesk-macbook-air-de-ortega');
  assert.strictEqual(SshConfig.aliasFor('ñandú', 'x'), 'twindesk-nandu');
  assert.strictEqual(SshConfig.aliasFor('', '62896d96-c8e7'), 'twindesk-62896d96');

  // The user's own config, and a twindesk block written by the version before (old end marker).
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, 'Host work\n  HostName w.example\n\n# >>> twindesk (managed by TwinDesk, do not edit)\nHost twindesk\n  HostName 10.0.0.1\n# <<< twindesk\n');
  SshConfig.setHost(host('10.0.0.2'), 'twindesk-ryzen9');
  SshConfig.setHost(host('10.0.0.3'), 'twindesk-macbook');
  assert.deepStrictEqual(hosts(), ['work', 'twindesk', 'twindesk-ryzen9', 'twindesk-macbook'], 'the old block is kept until twindesk is written');
  SshConfig.setHost(host('10.0.0.2'));
  assert.deepStrictEqual(hosts(), ['work', 'twindesk-ryzen9', 'twindesk-macbook', 'twindesk'], 'the old twindesk block replaced');
  assert.ok(!read().includes('10.0.0.1'));
  assert.match(read(), /Host twindesk-ryzen9\n  HostName 10\.0\.0\.2\n[\s\S]*HostKeyAlias twindesk-ryzen9\n/);

  // A device's block goes alone; twindesk and the user's stay.
  SshConfig.setHost(null, 'twindesk-ryzen9');
  assert.deepStrictEqual(hosts(), ['work', 'twindesk-macbook', 'twindesk']);
  SshConfig.setHost(null);
  assert.deepStrictEqual(hosts(), ['work', 'twindesk-macbook']);
  assert.ok(read().startsWith('Host work\n  HostName w.example\n'), 'the user’s lines byte for byte');

  // known_hosts lines for both names the device goes by.
  assert.strictEqual(SshConfig.knownHosts(['ssh-ed25519 AAA'], ['twindesk-macbook', 'twindesk']), 'twindesk-macbook ssh-ed25519 AAA\ntwindesk ssh-ed25519 AAA\n');
  assert.strictEqual(SshConfig.knownHosts(['ssh-ed25519 AAA']), 'twindesk ssh-ed25519 AAA\n');
  console.log('sshconfig-mesh: ok');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
