// The fork's install identity: the phone app id choice and the one-time data-folder copy.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../appid.js');
const B = require('../brand.js');

// ---- phone app id: Mesh first, upstream as a fallback, Mesh when none is installed ----
assert.strictEqual(A.APP_ID, 'com.twindesk.mesh');
assert.strictEqual(A.pickAppId('package:com.twindesk.mesh\npackage:com.twindesk.android\n'), 'com.twindesk.mesh');
assert.strictEqual(A.pickAppId('package:com.twindesk.android\r\n'), 'com.twindesk.android', 'only the old app: it still works');
assert.strictEqual(A.pickAppId(''), 'com.twindesk.mesh');
assert.strictEqual(A.pickAppId('package:com.twindesk.meshx'), 'com.twindesk.mesh', 'a lookalike is not matched');
assert.strictEqual(A.comp('com.twindesk.mesh', 'MainActivity'), 'com.twindesk.mesh/com.twindesk.android.MainActivity', 'classes keep the namespace');
(async () => {
  assert.strictEqual(await A.resolveAppId(async (s, c) => { assert.ok(/pm list packages/.test(c)); return { out: 'package:com.twindesk.android\n' }; }, 'x'), 'com.twindesk.android');
  assert.strictEqual(await A.resolveAppId(async () => { throw new Error('offline'); }, 'x'), 'com.twindesk.mesh');
})().catch((e) => { console.error(e); process.exit(1); });

// ---- one-time data copy ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
const old = path.join(root, 'MacShare');
fs.mkdirSync(path.join(old, 'identity'), { recursive: true });
fs.mkdirSync(path.join(old, 'logs'));
fs.mkdirSync(path.join(old, 'Cache'));
fs.writeFileSync(path.join(old, 'settings.json'), '{"a":1}');
fs.writeFileSync(path.join(old, 'device.json'), '{"id":"x"}');
fs.writeFileSync(path.join(old, 'identity', 'key.pem'), 'KEY');
fs.writeFileSync(path.join(old, 'logs', 'main.log'), 'log');
fs.writeFileSync(path.join(old, 'Cache', 'c'), 'c');
const target = path.join(root, B.DATA_DIR);
assert.strictEqual(B.migrateUserData(root), old, 'copied from the upstream folder');
assert.strictEqual(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"a":1}');
assert.strictEqual(fs.readFileSync(path.join(target, 'identity', 'key.pem'), 'utf8'), 'KEY');
assert.ok(!fs.existsSync(path.join(target, 'logs')) && !fs.existsSync(path.join(target, 'Cache')), 'logs and caches stay behind');
assert.ok(fs.existsSync(path.join(old, 'settings.json')) && fs.existsSync(path.join(old, 'identity', 'key.pem')), 'the source is never touched');
fs.writeFileSync(path.join(target, 'settings.json'), '{"a":2}');
assert.strictEqual(B.migrateUserData(root), '', 'not again once the new folder has state');
assert.strictEqual(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"a":2}', 'never overwrites');
// no upstream folder: nothing happens
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
assert.strictEqual(B.migrateUserData(empty), '');
assert.ok(!fs.existsSync(path.join(empty, B.DATA_DIR)));
// the older "TwinDesk" folder is the fallback
const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
fs.mkdirSync(path.join(r2, 'TwinDesk'));
fs.writeFileSync(path.join(r2, 'TwinDesk', 'settings.json'), '{}');
assert.strictEqual(B.migrateUserData(r2), path.join(r2, 'TwinDesk'));
console.log('identity: ok');
