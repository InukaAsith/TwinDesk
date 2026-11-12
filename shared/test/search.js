// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Search (shared/search-index.js): finds features by what they do, the way the query goes counts,
// every page it names is a page of that app, and the phones' generated copies are up to date.
// Run with: node shared/test/search.js   (to fix those: node android/tools/gen-search.js; node ios/tools/gen-search.js)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../search-index.js');
const ROOT = path.join(__dirname, '../..');

const first = (q, app = 'mac') => (S.match(q, S.forApp(app))[0] || {}).t;
assert.strictEqual(first('share pc audio to phone'), 'Play the computer’s sound on the phone');
assert.strictEqual(first('phone audio on pc'), 'Play the phone’s sound on the computer');
assert.strictEqual(first('laptop sound on my mobile', 'android'), 'Play the computer’s sound on the phone');
assert.ok(S.match('share audio', S.forApp('windows')).slice(0, 3).every((e) => e.page === 'audio'));
assert.strictEqual(first('phone mic'), 'Use the phone as a microphone');
assert.strictEqual(first('webcam'), 'Use the phone as a webcam');
assert.strictEqual(first('dark mode'), 'Dark mode');
assert.strictEqual(first('send file'), 'Send files');
assert.strictEqual(first('mous'), 'One mouse and keyboard for both computers');
assert.strictEqual(first('reorder tabs', 'ios'), 'Arrange the pages');
assert.deepStrictEqual(S.match('', S.forApp('mac')), []);
assert.deepStrictEqual(S.match('zzzz qqqq', S.forApp('mac')), []);
assert.strictEqual(S.direction('phone audio on pc'), 'p2c');
assert.strictEqual(S.direction('pc audio to phone'), 'c2p');
assert.strictEqual(S.direction('audio on phone'), 'c2p');

// Pages: each a page of that app.
const deskIds = (os) => {
  const ids = new Set();
  for (const dir of [os, 'shared']) for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => /^ui-.*\.js$/.test(n))) {
    for (const m of fs.readFileSync(path.join(ROOT, dir, f), 'utf8').matchAll(/\bid: '([a-z-]+)'/g)) ids.add(m[1]);
  }
  return ids;
};
for (const os of ['mac', 'windows', 'linux']) {
  const ids = deskIds(os);
  for (const e of S.forApp(os)) assert.ok(ids.has(e.id), `${os}: no page ${e.id} (${e.t})`);
}
const kt = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/twindesk/android/MainActivity.kt'), 'utf8');
const tabs = new Set([...kt.matchAll(/^ {4}([A-Z][A-Za-z]+)\("/gm)].map((m) => m[1]));
for (const e of S.forApp('android')) assert.ok(tabs.has(e.id), `android: no Tab ${e.id}`);
const sw = fs.readFileSync(path.join(ROOT, 'ios/TwinDesk/UI/RootView.swift'), 'utf8');
const cases = new Set(sw.match(/enum Page[^{]*\{\s*case ([^\n]+)/)[1].split(',').map((x) => x.trim()));
for (const e of S.forApp('ios')) assert.ok(cases.has(e.id), `ios: no Page .${e.id}`);

// The phones' copies.
for (const g of ['android/tools/gen-search.js', 'ios/tools/gen-search.js']) {
  const { make, OUT } = require(path.join(ROOT, g));
  assert.strictEqual(fs.readFileSync(OUT, 'utf8'), make(), `${path.basename(OUT)} is out of date: run node ${g}`);
}
console.log('search: ok');
