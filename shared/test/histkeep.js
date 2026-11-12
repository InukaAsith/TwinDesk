// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/histkeep.js: sealed without the private key, opened only by unlock(), old items dropped,
// merged once, off forgets everything.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HistKeep, merge } = require('../histkeep.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'histkeep-'));
const secret = crypto.randomBytes(32);
let unwraps = 0;
const wrap = {
  encrypt: (b) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secret, iv); return Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]); },
  decrypt: (b) => { unwraps++; const d = crypto.createDecipheriv('aes-256-gcm', secret, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); },
};

const h = new HistKeep({ dir, name: 'clip', wrap });
h.add([{ at: Date.now(), text: 'off: not kept' }]);
assert.ok(!fs.existsSync(h.file), 'nothing while off');
h.setOn(true, 7);
const now = Date.now();
h.add([{ at: now - 1000, text: 'one' }]);
h.add([{ at: now, text: 'two' }, { at: now - 10 * 86400000, text: 'old' }]);
const raw = fs.readFileSync(h.file, 'utf8');
assert.ok(!raw.includes('one') && !raw.includes('two'), 'sealed on disk');
assert.strictEqual(raw.trim().split('\n').length, 2);
assert.strictEqual(unwraps, 0, 'writing never unwraps the key');

// A new session: unlock opens it, once.
const h2 = new HistKeep({ dir, name: 'clip', wrap });
h2.setOn(true, 7);
const items = h2.unlock();
assert.deepStrictEqual(items.map((x) => x.text), ['two', 'one'], 'newest first, the old one gone');
assert.strictEqual(unwraps, 1);
assert.strictEqual(fs.readFileSync(h2.file, 'utf8').trim().split('\n').length, 1, 'compacted to one line');
h2.add([{ at: now + 1, text: 'three' }]);
assert.deepStrictEqual(h2.unlock().map((x) => x.text), ['three', 'two', 'one']);
assert.strictEqual(unwraps, 1, 'once a session');

// A day's keeping drops lines by their time without opening them.
const h3 = new HistKeep({ dir, name: 'n', wrap });
h3.setOn(true, 1);
h3.add([{ at: now - 3 * 86400000, id: 'a', title: 'old' }]);
h3.add([{ at: now, id: 'b', title: 'new' }]);
h3.prune();
assert.strictEqual(fs.readFileSync(h3.file, 'utf8').trim().split('\n').length, 1);

// Off: the file and the keys go.
h2.setOn(false, 7);
assert.ok(!fs.existsSync(h2.file) && !fs.existsSync(h2.keyFile));

assert.deepStrictEqual(merge([{ id: 'x', at: 2 }], [{ id: 'x', at: 2 }, { id: 'y', at: 1 }], 10).map((x) => x.id), ['x', 'y']);
fs.rmSync(dir, { recursive: true, force: true });
console.log('histkeep: ok');
