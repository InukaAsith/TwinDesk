// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// #123: the HID keyboard's reports, and scrcpy's UHID messages byte for byte.
'use strict';
const assert = require('assert');
const { UhidKeyboard, uhidKey, USAGE, DESCRIPTOR } = require('../uhidkbd.js');

const sent = [];
const ctl = { uhidCreate: (...a) => sent.push(['create', ...a]), uhidInput: (id, r) => sent.push(['input', id, r.toString('hex')]) };
assert.strictEqual(uhidKey(ctl, true, 'ShiftLeft', true), true);
assert.deepStrictEqual(sent[0].slice(0, 5), ['create', 1, 0, 0, 'TwinDesk keyboard']);
assert.strictEqual(sent[0][5], DESCRIPTOR);
assert.deepStrictEqual(sent[1], ['input', 1, '0200000000000000']);
uhidKey(ctl, true, 'KeyA', true);
assert.deepStrictEqual(sent[2], ['input', 1, '0200040000000000'], 'Shift+A');
uhidKey(ctl, true, 'KeyA', true); // a repeat: Android repeats a held key itself
assert.strictEqual(sent.length, 3);
uhidKey(ctl, true, 'Digit1', true);
assert.deepStrictEqual(sent[3], ['input', 1, '0200041e00000000']);
uhidKey(ctl, true, 'KeyA', false);
assert.deepStrictEqual(sent[4], ['input', 1, '02001e0000000000']);
assert.strictEqual(uhidKey(ctl, true, 'MediaPlayPause', true), false, 'not a key a HID keyboard has: as before');
assert.strictEqual(uhidKey(ctl, false, 'KeyB', true), false, 'off: as before');
assert.deepStrictEqual(sent[sent.length - 1], ['input', 1, '0000000000000000'], 'switching off lets everything go');
assert.strictEqual(uhidKey({ key() {} }, true, 'KeyA', true), false, 'the phone’s own input (no scrcpy): as before');
assert.strictEqual(USAGE.KeyZ, 0x1d); assert.strictEqual(USAGE.Digit0, 0x27); assert.strictEqual(USAGE.F12, 0x45); assert.strictEqual(USAGE.Numpad0, 0x62);

// Seven keys: the newest six go.
const k = new UhidKeyboard({ uhidCreate() {}, uhidInput: (id, r) => { k.last = r.toString('hex'); } });
for (const c of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG']) k.key(c, true);
assert.strictEqual(k.last, '000005060708090a', 'six newest (B…G)');

// scrcpy's messages (control/ControlMessageReader: id u16, vendor u16, product u16, name u8+bytes, descriptor u16+bytes).
const { Session } = require('../../mac/scrcpy.js');
for (const p of ['mac', 'windows', 'linux']) {
  const S = require(`../../${p}/scrcpy.js`).Session;
  const s = Object.create(S.prototype);
  const out = [];
  s._send = (b) => out.push(b.toString('hex'));
  s.uhidCreate(1, 0, 0, 'TD', Buffer.from([0xaa, 0xbb]));
  s.uhidInput(1, Buffer.from([2, 0, 4, 0, 0, 0, 0, 0]));
  s.uhidDestroy(1);
  assert.deepStrictEqual(out, ['0c0001000000000254440002aabb', '0d000100080200040000000000', '0e0001'], p);
}
assert.ok(Session);
console.log('uhidkbd: reports, repeats, rollover and scrcpy UHID messages');
