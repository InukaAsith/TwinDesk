'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { install } = require('../logfile');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-log-'));
const fake = { log() {}, info() {}, warn() {}, error() {} };
const log = install(path.join(dir, 'logs'), { maxBytes: 600, target: fake });

fake.log('hello', { a: 1 });
fake.error(new Error('boom').message, 42);
const text = fs.readFileSync(log.file, 'utf8');
assert.ok(/INFO --- start/.test(text), 'a start line');
assert.ok(/LOG hello \{ a: 1 \}/.test(text), 'console.log is written');
assert.ok(/ERROR boom 42/.test(text), 'console.error is written');

// the file is capped: it rolls over to main.log.1 and stays small
for (let i = 0; i < 60; i++) fake.log('line number', i, 'x'.repeat(20));
assert.ok(fs.statSync(log.file).size <= 700, 'main.log stays near the cap');
assert.ok(fs.existsSync(log.file + '.1'), 'the old part is kept as main.log.1');
assert.ok(!fs.existsSync(log.file + '.2'), 'nothing older than that');

// a folder that cannot be made must not break anything
const bad = install(path.join(dir, 'logs', 'main.log', 'sub'), { target: { ...fake } });
assert.strictEqual(bad.file, null);

log.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log('logfile: passed');
