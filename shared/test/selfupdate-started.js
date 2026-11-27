// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/selfupdate.js (#204): the app's sign of life for a Mac update waiting to keep it, and the note of
// one that didn't start, said once; the swap script keeps the old app until the marker comes.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SelfUpdate, STARTED_MS } = require('../selfupdate.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const lines = [];
const su = new SelfUpdate({ platform: 'mac', dir: path.join(root, 'updates'), app: null, log: (...a) => lines.push(a.join(' ')) });
assert.strictEqual(su.markerFile(), path.join(root, '.update-started'));
assert.strictEqual(su.markStarted(), '');
assert.ok(fs.existsSync(su.markerFile()), 'the marker is there');
fs.writeFileSync(su.failedFile(), '3.3.0\n');
assert.strictEqual(su.markStarted(), '3.3.0', 'a version that did not start');
assert.ok(lines.some((l) => /3\.3\.0 didn’t start/.test(l)));
assert.strictEqual(su.markStarted(), '', 'said once');
assert.strictEqual(STARTED_MS, 90000);
// The script waits for the marker before it removes the old app, and puts it back otherwise.
const src = fs.readFileSync(path.join(__dirname, '..', 'selfupdate.js'), 'utf8');
const i = src.indexOf("'rm -f \"$marker\"'");
assert.ok(i > 0 && src.indexOf("'if [ -f \"$marker\" ]; then rm -rf \"$old\"; exit 0; fi'") > i, 'old removed only after the marker');
assert.ok(src.includes('mv "$old" "$app"') && src.includes('echo "$ver" > "$note"'), 'put back, with a note');
console.log('selfupdate-started: ok');
