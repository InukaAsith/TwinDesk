// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/histkeeper.js: off keeps nothing; on, the clipboard's and notifications' new items are
// kept and come back in the next session's lists only on unlock; Clear clears the kept ones.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HistoryKeeper } = require('../histkeeper.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'histkeeper-'));
const secret = crypto.randomBytes(32);
let unwraps = 0;
const wrap = {
  encrypt: (b) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secret, iv); return Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]); },
  decrypt: (b) => { unwraps++; const d = crypto.createDecipheriv('aes-256-gcm', secret, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); },
};
// Like the apps' own: a clipboard with _remember and clearHistory, notifications that replace their list.
const mkClip = () => ({ cfg: { historySize: 20 }, history: [], _remember(dir, text) { this.history.unshift({ dir, at: Date.now() + this.history.length, text, size: text.length }); }, clearHistory() { this.history = []; } });
const mkNotifs = () => ({ _show(m) { this.history = [{ ...m, at: Date.now() }, ...(this.history || [])].slice(0, 50); }, clearHistory() { this.history = []; } });

let clip = mkClip(), notifs = mkNotifs();
let k = new HistoryKeeper({ dir, clip, notifs, wrap });
clip._remember('in', 'before');
k.act({ do: 'set', save: true, days: 7 });
clip._remember('out', 'secret text');
notifs._show({ id: 'n1', app: 'chat', title: 'Hello' });
assert.ok(!fs.readFileSync(path.join(dir, 'clipboard.hist'), 'utf8').includes('secret'));
assert.strictEqual(unwraps, 0);

// The next session: empty lists until the page asks.
clip = mkClip(); notifs = mkNotifs();
k = new HistoryKeeper({ dir, clip, notifs, wrap });
assert.strictEqual(clip.history.length, 0);
assert.strictEqual(unwraps, 0, 'no keychain at start');
k.act({ do: 'unlock', what: 'clip' });
assert.deepStrictEqual(clip.history.map((h) => h.text).sort(), ['before', 'secret text']);
k.act({ do: 'unlock', what: 'notifs' });
assert.deepStrictEqual(notifs.history.map((h) => h.id), ['n1']);
assert.strictEqual(unwraps, 2);
notifs._show({ id: 'n2', title: 'Again' });
assert.deepStrictEqual(notifs.history.map((h) => h.id), ['n2', 'n1']);

// Clear clears what's kept.
clip.clearHistory();
clip = mkClip();
k = new HistoryKeeper({ dir, clip, wrap });
k.act({ do: 'unlock', what: 'clip' });
assert.strictEqual(clip.history.length, 0);

// Off: nothing kept, the files gone.
k.act({ do: 'set', save: false });
assert.ok(!fs.existsSync(path.join(dir, 'clipboard.hist')) && !fs.existsSync(path.join(dir, 'clipboard.key')));
fs.rmSync(dir, { recursive: true, force: true });
console.log('histkeeper: ok');
