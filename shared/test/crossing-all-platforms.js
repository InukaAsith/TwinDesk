'use strict';
// Hold a key to cross (#230) and the emergency return (#178) on Windows, Linux and Multi-device:
// shared/crossing.js, the settings, and what kvm.js sends the helper.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../crossing.js');
const root = path.join(__dirname, '..', '..');

assert.strictEqual(C.modifier('Alt'), 'Alt');
assert.strictEqual(C.modifier('Super'), '');
assert.strictEqual(C.modifier(undefined), '');
assert.strictEqual(C.emergency('Control+Alt+K'), 'Control+Alt+K');
assert.strictEqual(C.emergency('Shift+K'), C.DEFAULT_EMERGENCY); // Shift alone is no shortcut
assert.strictEqual(C.emergency('F13'), 'F13');
assert.strictEqual(C.emergency('F12'), C.DEFAULT_EMERGENCY);
assert.strictEqual(C.emergency('Control+Control+K'), C.DEFAULT_EMERGENCY);
assert.strictEqual(C.emergency('Super+K'), C.DEFAULT_EMERGENCY); // the shortcut says Command
assert.strictEqual(C.bits(15), 15);
assert.strictEqual(C.bits(16), 0);
assert.strictEqual(C.bits(1.5), 0);
assert.ok(!C.validBits(-1));

// The Mac's own module and this one agree.
const mac = require('../../mac/emergency-shortcut.js');
for (const v of ['Control+Alt+Command+Escape', 'Alt+Up', 'F20', 'F21', 'Shift+F13', 'Command+Shift+1', '', 'Control+Hyper+K']) {
  assert.strictEqual(C.emergency(v), mac.valid(v), v);
}

for (const os of ['windows', 'linux']) {
  const { normalize } = require(`../../${os}/settings.js`);
  const s = normalize({ kvm: { crossingModifier: 'Control' }, keys: { emergencyKeys: 'Control+Alt+Q' } });
  assert.strictEqual(s.kvm.crossingModifier, 'Control', os);
  assert.strictEqual(s.keys.emergencyKeys, 'Control+Alt+Q', os);
  const d = normalize({ kvm: { crossingModifier: 'Hyper' }, keys: { emergencyKeys: 'K' } });
  assert.strictEqual(d.kvm.crossingModifier, '', os);
  assert.strictEqual(d.keys.emergencyKeys, C.DEFAULT_EMERGENCY, os);

  // One-to-one: the edge and the way back; Multi-device: this computer's own edges and the emergency.
  const one = fs.readFileSync(path.join(root, os, 'kvm.js'), 'utf8');
  for (const s of ['crossingModifier: Crossing.modifier', 'emergencyKeys: Crossing.emergency', "'crossingWatch'", "'crossingFlags'", "'emergencyActive'", "case 'emergency':", 'crossingModifierV1: true', 'requireModifier']) {
    assert.ok(one.includes(s), `${os}/kvm.js: ${s}`);
  }
}
for (const os of ['mac', 'windows', 'linux']) {
  const mesh = fs.readFileSync(path.join(root, os, 'mesh', 'kvm.js'), 'utf8');
  for (const s of ['crossingModifier: Crossing.modifier', 'emergencyKeys: Crossing.emergency', "'emergencyActive'", "case 'emergency':"]) {
    assert.ok(mesh.includes(s), `${os}/mesh/kvm.js: ${s}`);
  }
  assert.ok(!mesh.includes('crossingModifierV1'), `${os}/mesh/kvm.js: the key gates only this computer's own edges`);
}
console.log('crossing on every platform: ok');
