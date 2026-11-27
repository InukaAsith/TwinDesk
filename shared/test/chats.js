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
again.stop();

// Multi-device (#313): every phone's conversations, whichever device is selected; each connected phone is
// told chat.want; answers go to the phone the Messages page shows (who()); a computer isn't a phone.
{
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-chats-mesh-'));
  const handlers = {};
  const peerFns = { welcome: [], closed: [] };
  const out = [];
  const connected = new Set(['phoneA']);
  const bus = {
    on: (t, fn) => (handlers[t] = fn),
    onPeer: (ev, fn) => peerFns[ev].push(fn),
    send: (id, m) => connected.has(id) && out.push([id, m]) > 0,
    connectedIds: () => [...connected],
  };
  const phones = new Set(['phoneA', 'phoneB']);
  let shown = 'phoneA';
  let on = true;
  const m = new Chats({ mesh: { bus, isPhone: (id) => phones.has(id) }, who: () => shown, dir: mdir, want: () => on });
  assert.deepStrictEqual(out, [['phoneA', { t: 'chat.want', on: true }]], 'the phone already connected is told');
  connected.add('phoneB');
  connected.add('pc');
  for (const fn of peerFns.welcome) { fn('phoneB'); fn('pc'); }
  assert.deepStrictEqual(out.map((x) => x[0]), ['phoneA', 'phoneB'], 'each phone once, not the computer');
  // B isn't shown (nor selected): its conversation is kept under its id.
  handlers['chat.conv'](conv([{ at: 1000, from: 'Ana', text: 'Hola' }], { key: 'b1' }), 'phoneB');
  handlers['chat.conv'](conv([{ at: 1000, from: 'x', text: 'from a pc' }], { key: 'pc1' }), 'pc');
  assert.deepStrictEqual(m.view(), [], 'A shows nothing of B');
  shown = 'phoneB';
  let mv = m.view();
  assert.deepStrictEqual(mv.map((x) => x.items[0].text), ['Hola'], 'B shows its own, nothing from the computer');
  assert.strictEqual(m.reply(mv[0].key, 'Hey'), true);
  assert.deepStrictEqual(out.at(-1), ['phoneB', { t: 'notif.reply', id: 'k1', text: 'Hey' }], 'the answer goes to B');
  // The switch off: every phone is told once.
  on = false;
  m.sync();
  assert.deepStrictEqual(out.slice(-2), [['phoneA', { t: 'chat.want', on: false }], ['phoneB', { t: 'chat.want', on: false }]]);
  // B goes: no Reply for it; back, it's told again.
  connected.delete('phoneB');
  for (const fn of peerFns.closed) fn('phoneB');
  assert.strictEqual(m.view()[0].reply, false);
  connected.add('phoneB');
  for (const fn of peerFns.welcome) fn('phoneB');
  assert.deepStrictEqual(out.at(-1), ['phoneB', { t: 'chat.want', on: false }]);
  m.stop();
  fs.rmSync(mdir, { recursive: true, force: true });
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('chats ok');
