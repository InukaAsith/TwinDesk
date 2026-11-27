// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// DebugLocal's update through the mesh (shared/debuglocal.js put/update): pieces written at their offsets in
// any order, the whole file's SHA-256 checked, an installer this copy can't take refused, the edition kept.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DebugLocal } = require('../debuglocal.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-update-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const app = { getPath: () => root, getVersion: () => '3.2.1' };
const installed = [];
let kind = 'appimage';
const su = {
  quitMs: 300,
  check: async () => kind,
  fits: (d) => ({ appimage: /\.AppImage$/i, win: /\.exe$/i, mac: /\.dmg$/i }[kind] || /^$/).test(d.name),
  install: async (file) => { installed.push([path.basename(file), fs.readFileSync(file).length]); },
};
let edition = 'fullkvm';
const L = new DebugLocal({ app, selfUpdate: () => su, edition: () => edition, updatesCfg: () => ({ auto: true, install: false }) });
const fail = (p) => p.then(() => '', (e) => e.message);

(async () => {
  const body = crypto.randomBytes(300 * 1024 + 17);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const name = 'TwinDesk-FullKVM-3.2.1-x86_64.AppImage';
  const P = 128 * 1024;
  // Out of order after the first; the last one in completes it.
  assert.strictEqual((await L.put({ name, size: body.length, sha256, at: 0 }, body.subarray(0, P))).done, false);
  await L.put({ name, size: body.length, sha256, at: 2 * P }, body.subarray(2 * P));
  await L.put({ name, size: body.length, sha256, at: 2 * P }, body.subarray(2 * P)); // again: counted once
  const r = await L.put({ name, size: body.length, sha256, at: P }, body.subarray(P, 2 * P));
  assert.deepStrictEqual(r, { name, got: body.length, size: body.length, done: true });
  assert.ok(fs.readFileSync(path.join(root, 'mesh-update', name)).equals(body));

  // Received whole: its install may go on without the switch for a while; another file's may not.
  assert.strictEqual(L.granted('update', { name }), true);
  assert.strictEqual(L.granted('update', { name: 'other.AppImage' }), false);
  assert.strictEqual(L.granted('put', { name, sha256 }), false, 'nothing being received now');

  // Installed as the app's updater would, with time for the answer to leave.
  const u = await L.update({ name });
  assert.deepStrictEqual(u, { installing: 'appimage', file: name, was: '3.2.1' });
  assert.deepStrictEqual(installed, [[name, body.length]]);
  assert.strictEqual(su.quitMs, 2500);

  // The other edition: only with force.
  edition = 'standard';
  assert.match(await fail(L.update({ name })), /Full KVM edition/);
  edition = 'fullkvm';

  // Not what this install takes; this copy can't update itself.
  kind = 'win';
  assert.match(await fail(L.update({ name })), /isn’t what a win install takes/);
  kind = '';
  assert.match(await fail(L.update({ name })), /can’t update itself/);
  assert.deepStrictEqual(await L.updateInfo(), { kind: '', auto: true, install: false });
  kind = 'appimage';

  // A piece that spoils the file: the last one finds it, and nothing is left to install.
  const bad = Buffer.from(body);
  bad[5] ^= 1;
  await L.put({ name, size: body.length, sha256, at: 0 }, bad.subarray(0, P));
  assert.strictEqual(L.granted('put', { name, sha256 }), true, 'its later pieces go on');
  assert.strictEqual(L.granted('put', { name, sha256: 'a'.repeat(64) }), false);
  await L.put({ name, size: body.length, sha256, at: P }, body.subarray(P, 2 * P));
  assert.match(await fail(L.put({ name, size: body.length, sha256, at: 2 * P }, body.subarray(2 * P))), /SHA-256/);
  assert.match(await fail(L.update({ name })), /send the file first/);

  // Names and sizes: installers only, no paths, nothing past the size.
  assert.match(await fail(L.put({ name: '../../.bashrc', size: 10, sha256, at: 0 }, Buffer.alloc(1))), /not an installer/);
  assert.match(await fail(L.put({ name: 'x.sh', size: 10, sha256, at: 0 }, Buffer.alloc(1))), /not an installer/);
  assert.match(await fail(L.put({ name: 'x.exe', size: 10, sha256, at: 5 }, Buffer.alloc(6))), /bad piece/);
  assert.match(await fail(L.put({ name: 'x.exe', size: 10, sha256: 'nope', at: 0 }, Buffer.alloc(1))), /sha256/);
  console.log('debuglocal-update: ok');
})().catch((e) => { console.error(e); process.exit(1); });
