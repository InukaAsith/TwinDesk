// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/chats.js: a phone's chat app conversations kept per phone, merged without doubles, an
// answer typed here replaced by the phone's copy, chat.want sent once per change.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chats } = require('../chats.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-chats-'));
const on = {};
const sent = [];
const link = { on: (ev, fn) => (on[ev] = fn), send: (m) => sent.push(m), current: { deviceId: 'phone1' } };
let want = true;
const c = new Chats({ link, dir, want: () => want });

assert.strictEqual(c.view(), null, 'nothing heard: null (Messages falls back to notifications)');
on.welcome();
assert.deepStrictEqual(sent, [{ t: 'chat.want', on: true }]);
c.sync();
assert.strictEqual(sent.length, 1, 'once per change');

const conv = (items, extra = {}) => ({ key: 'sc1', app: 'com.whatsapp', appName: 'WhatsApp', name: 'Family', group: true, id: 'k1', reply: true, items, ...extra });
on['chat.conv'](conv([{ at: 1000, from: 'Mum', text: 'Dinner?' }, { at: 2000, from: 'Dad', text: 'Yes' }]));
on['chat.conv'](conv([{ at: 2000, from: 'Dad', text: 'Yes' }, { at: 3000, from: 'Mum', text: 'At 8' }]));
let v = c.view();
assert.strictEqual(v.length, 1);
assert.deepStrictEqual(v[0].items.map((x) => x.text), ['Dinner?', 'Yes', 'At 8'], 'merged, no doubles');
assert.strictEqual(v[0].reply, true);

assert.strictEqual(c.reply(v[0].key, 'On my way'), true);
assert.deepStrictEqual(sent[1], { t: 'notif.reply', id: 'k1', text: 'On my way' });
on['chat.conv'](conv([{ at: Date.now() + 500, from: '', text: 'On my way', me: true }]));
v = c.view();
assert.strictEqual(v[0].items.filter((x) => x.text === 'On my way').length, 1, "the phone's copy replaces the one typed here");
assert.ok(!v[0].items.some((x) => x.local));

on['chat.conv']({ key: 'x', app: 'com.google.android.apps.messaging', items: [{ at: 1, text: 'hi' }] });
on['chat.conv']({ key: 'y', app: 'not a package', items: [{ at: 1, text: 'hi' }] });
assert.strictEqual(c.view().length, 1, 'never a texting app (those are the texts), nor anything but a package');
on['chat.conv']({ key: 'z', app: 'com.viber.voip', appName: 'Viber', name: 'Ann', items: [{ at: 2, text: 'hi' }] });
assert.strictEqual(c.view().length, 2, 'other chat apps too');
assert.ok(c.view().some((x) => x.app === 'com.viber.voip'));

link.current = { deviceId: 'phone2' };
assert.deepStrictEqual(c.view(), [], 'another phone: its own');
link.current = { deviceId: 'phone1' };

on.closed();
assert.strictEqual(c.view()[0].reply, false, 'no Reply without a session');
c.stop();
const again = new Chats({ link, dir, want: () => false });
assert.strictEqual(again.view().length, 2, 'kept after a restart');
fs.rmSync(dir, { recursive: true, force: true });
console.log('chats ok');
