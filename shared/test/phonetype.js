// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/phonetype.js: an AZERTY keyboard on an Android phone (#260).
'use strict';
const assert = require('assert');
const { PhoneType } = require('../phonetype.js');
const t = new PhoneType();
const w = (code, down, key, mods = {}) => t.fromWindow({ code, down, key, ...mods });
// Ctrl+A on AZERTY (the A is in the Q place)
assert.deepStrictEqual(w('KeyQ', true, 'a', { ctrl: true }), { code: 'KeyA' });
assert.deepStrictEqual(w('KeyQ', true, 'a', { ctrl: true, repeat: true }), { code: 'KeyA' }, 'a repeat');
assert.deepStrictEqual(w('KeyQ', false, 'a'), { code: 'KeyA' }, 'released as pressed');
// Ctrl+C / Ctrl+V are in the same places
assert.deepStrictEqual(w('KeyC', true, 'c', { ctrl: true }), { code: 'KeyC' });
assert.deepStrictEqual(w('KeyC', false, 'c'), { code: 'KeyC' });
// AltGr+à is @
assert.deepStrictEqual(w('Digit0', true, '@', { ctrl: true, alt: true, altGr: true }), { text: '@' });
assert.deepStrictEqual(w('Digit0', false, '@'), {});
// é alone on the 2 key; held, it repeats
assert.deepStrictEqual(w('Digit2', true, 'é'), { text: 'é' });
assert.deepStrictEqual(w('Digit2', true, 'é', { repeat: true }), { text: 'é' });
assert.deepStrictEqual(w('Digit2', false, 'é'), {});
// Shift+2 on AZERTY is 2: as text, since the phone's Shift would make it @
assert.deepStrictEqual(w('Digit2', true, '2', { shift: true }), { text: '2' });
w('Digit2', false, '2');
// US QWERTY: unchanged
assert.deepStrictEqual(w('Digit2', true, '@', { shift: true }), { code: 'Digit2' });
assert.deepStrictEqual(w('Digit2', false, '@'), { code: 'Digit2' });
assert.deepStrictEqual(w('KeyA', true, 'A', { shift: true }), { code: 'KeyA' });
w('KeyA', false, 'A');
// dead key, then the letter it makes
assert.deepStrictEqual(w('BracketLeft', true, 'Dead'), {});
assert.deepStrictEqual(w('BracketLeft', false, 'Dead'), {});
assert.deepStrictEqual(w('KeyE', true, 'ê'), { text: 'ê' });
w('KeyE', false, 'ê');
// named keys and the numpad as they are
assert.deepStrictEqual(w('Enter', true, 'Enter'), { code: 'Enter' });
w('Enter', false, 'Enter');
assert.deepStrictEqual(w('Numpad1', true, '1'), { code: 'Numpad1' });
w('Numpad1', false, '1');
// across the edge: letters by what they type here
assert.deepStrictEqual(t.fromHelper('KeyQ', true, 'a'), { code: 'KeyA' });
assert.deepStrictEqual(t.fromHelper('KeyQ', false, 'a'), { code: 'KeyA' });
assert.deepStrictEqual(t.fromHelper('Digit2', true, undefined), { code: 'Digit2' });
assert.deepStrictEqual(t.fromHelper('Digit2', false), { code: 'Digit2' });
// numpad digits carry Num Lock
for (const os of ['mac', 'windows', 'linux']) {
  const { KeyState } = require(`../../${os}/android-keys.js`);
  const e = new KeyState().event('Numpad5', true);
  assert.strictEqual(e.keycode, 149);
  assert.ok(e.meta & 0x200000, `${os}: Num Lock on`);
  assert.strictEqual(new KeyState().event('KeyA', true).meta & 0x200000, 0);
}
console.log('phonetype: ok');
