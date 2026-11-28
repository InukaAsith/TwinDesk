// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/phonechat.js: Enter sends only in a chat app, and only as that app can; arrows swipe only when asked.
'use strict';

const assert = require('assert');
const chat = require('../phonechat.js');

const run = (o) => {
  const did = [];
  const r = chat.enter({ on: true, shift: false, a11y: false, phoneSend: () => did.push('send'), tap: (k) => did.push(k), text: (t) => did.push(JSON.stringify(t)), ...o });
  return { r, did };
};

(async () => {
  // Anywhere but a chat app (a browser's address bar, a form): Enter is Enter.
  assert.deepStrictEqual(run({ pkg: 'com.android.chrome' }), { r: false, did: [] });
  assert.deepStrictEqual(run({ pkg: '' }), { r: false, did: [] });
  assert.deepStrictEqual(run({ pkg: 'com.example.sendmoney', a11y: true }), { r: false, did: [] });
  // The setting off: Enter is Enter everywhere.
  assert.deepStrictEqual(run({ pkg: 'com.whatsapp', on: false, a11y: true }), { r: false, did: [] });
  // With Accessibility the phone clicks Send; never a Tab and Enter typed blind.
  assert.deepStrictEqual(run({ pkg: 'com.whatsapp', a11y: true }), { r: true, did: ['send'] });
  assert.deepStrictEqual(run({ pkg: 'org.telegram.messenger', a11y: true }), { r: true, did: ['send'] });
  assert.deepStrictEqual(run({ pkg: 'com.facebook.orca', a11y: true }), { r: true, did: ['send'] }, 'Messenger (#331)');
  // Messenger without it: no keyboard way to Send, Enter is left as the app takes it.
  assert.deepStrictEqual(run({ pkg: 'com.facebook.orca' }), { r: false, did: [] });
  // Without it: WhatsApp and Telegram get their Enter (their own "Enter is send"), Instagram Tab, Enter.
  assert.deepStrictEqual(run({ pkg: 'com.whatsapp' }), { r: false, did: [] });
  const ig = run({ pkg: 'com.instagram.android' });
  assert.strictEqual(ig.r, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(ig.did, [61, 66]);
  // Shift+Enter: a new line in a chat app, as text; where text can't be typed, the key.
  assert.deepStrictEqual(run({ pkg: 'com.whatsapp', shift: true, a11y: true }), { r: true, did: [JSON.stringify('\n')] });
  assert.deepStrictEqual(run({ pkg: 'com.whatsapp', shift: true, text: null }), { r: false, did: [] });
  assert.deepStrictEqual(run({ pkg: 'com.android.chrome', shift: true }), { r: false, did: [] });

  // Arrows swipe only with the setting on and no modifier held.
  const none = new Set();
  assert.strictEqual(chat.swipeOf('ArrowDown', false, none), '');
  assert.strictEqual(chat.swipeOf('ArrowDown', true, none), 'down');
  assert.strictEqual(chat.swipeOf('ArrowLeft', true, new Set(['ShiftLeft'])), '', 'Shift+arrow selects text');
  assert.strictEqual(chat.swipeOf('KeyA', true, none), '');
  assert.ok(chat.isEnter('NumpadEnter') && !chat.isEnter('Space'));
  console.log('phonechat: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
