// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tailscale (#161): which addresses count, and when an attempt goes through one.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../tailnet.js');

for (const a of ['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:ab12::5']) assert.ok(T.isTailnet(a), a);
for (const a of ['100.63.255.255', '100.128.0.1', '10.0.0.5', '192.168.1.2', '100.64.0', '100.64.0.1.2', '', null, 'fd7a:115c:a1e1::1', ' 100.64.0.1']) assert.ok(!T.isTailnet(a), String(a));
assert.deepStrictEqual(T.clean(['100.64.0.1', '192.168.1.2', '100.64.0.1', 'fd7a:115c:a1e0::1', '100.70.0.1']), ['100.64.0.1', 'fd7a:115c:a1e0::1']);
assert.deepStrictEqual(T.clean('100.64.0.1'), []);

const on = () => ['100.90.0.2'], off = () => [];
const base = { address: '192.168.1.20', tail: ['fd7a:115c:a1e0::9', '100.80.0.9'], here: on, on: true };
assert.strictEqual(T.pick({ ...base, attempt: 1 }), '100.80.0.9', 'odd attempt, not seen: Tailscale (IPv4 first)');
assert.strictEqual(T.pick({ ...base, attempt: 2 }), '192.168.1.20', 'even attempt: the last address');
assert.strictEqual(T.pick({ ...base, attempt: 1, seen: { address: '192.168.1.30' } }), '192.168.1.20', 'seen by discovery: never Tailscale');
assert.strictEqual(T.pick({ ...base, attempt: 1, here: off }), '192.168.1.20', 'this device not on Tailscale');
assert.strictEqual(T.pick({ ...base, attempt: 1, on: false }), '192.168.1.20', 'switched off');
assert.strictEqual(T.pick({ ...base, attempt: 1, tail: undefined }), '192.168.1.20', 'nothing announced (an older app)');
T.use(() => false);
assert.strictEqual(T.pick({ address: 'a', tail: ['100.80.0.9'], attempt: 1, here: on }), 'a', 'General › Tailscale off');
T.use(() => true);
assert.strictEqual(T.pick({ address: 'a', tail: ['100.80.0.9'], attempt: 1, here: on }), '100.80.0.9');
assert.ok(Array.isArray(T.mine()) && T.mine().every(T.isTailnet));

// Every computer announces it; every client keeps it and dials it for one attempt only.
const ROOT = path.join(__dirname, '..', '..');
for (const f of ['mac/pairing.js', 'mac/mesh/pairing.js', 'windows/hostpair.js', 'windows/mesh/hostpair.js', 'linux/hostpair.js', 'linux/mesh/hostpair.js']) {
  assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /tail: require\('[./]+\/shared\/tailnet\.js'\)\.mine\(\)/, `${f} announces`);
}
for (const f of ['windows/link.js', 'windows/mesh/link.js', 'linux/link.js', 'linux/mesh/link.js', 'mac/mesh/link.js', 'mac/link.js']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(s, /Tailnet\.clean\(msg\.tail\)/, `${f} keeps it`);
  assert.match(s, /Tailnet\.pick\(/, `${f} dials it`);
}
for (const f of ['mac/main.js', 'mac/mesh/main.js', 'windows/main.js', 'windows/mesh/main.js', 'linux/main.js', 'linux/mesh/main.js']) {
  assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /shared\/tailnet\.js'\)\.use\(/, `${f} wires the switch`);
}
console.log('tailnet: addresses, the alternate attempt and every app wired');
