// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/files-relay.js: a phone's Send to another computer of the mesh. Only a phone's batch, only to a
// connected device that isn't this one or the phone; it lands in a folder of its own and is passed on.
// Run: node shared/test/files-relay.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { filesRelay, ROOT } = require('../files-relay.js');

const sent = [];
const said = [];
const r = filesRelay({
  selfId: 'MAC', isPhone: (id) => id === 'PHONE', connected: (id) => id === 'PC' || id === 'PHONE',
  sendTo: (id, paths) => { sent.push([id, paths]); return true; }, nameOf: (id) => id.toLowerCase(), notify: (k, v) => said.push([k, v]),
});
assert.strictEqual(r.dir('PHONE', 'MAC', 'b1'), '', 'to this computer: received as usual');
assert.strictEqual(r.dir('PC', 'PHONE', 'b1'), '', 'only phones ask for it');
assert.strictEqual(r.dir('PHONE', 'OFFICE', 'b1'), '', 'not connected: received here');
assert.strictEqual(r.dir('PHONE', '../x', 'b1'), '', 'bad id');
const d = r.dir('PHONE', 'PC', 'b-1/../2');
assert.ok(d.startsWith(ROOT) && fs.existsSync(d) && !d.includes('..'), d);
assert.strictEqual(r.done({ kind: 'send', files: 2, placed: ['/x/a'] }), false, 'a batch for here');
assert.strictEqual(r.done({ kind: 'send', files: 2, to: 'PC', placed: [path.join(d, 'a'), path.join(d, 'b')] }), true);
assert.deepStrictEqual(sent, [['PC', [path.join(d, 'a'), path.join(d, 'b')]]]);
assert.deepStrictEqual(said[0], ['Passing {count} file(s) to {name}', { count: 2, name: 'pc' }]);
fs.rmSync(d, { recursive: true, force: true });
console.log('files-relay: ok');
process.exit(0);
