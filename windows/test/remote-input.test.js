'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const RemoteInput = require('../remote-input');
const P = require('../../shared/protocol');
function fixture() {
  const sent = [], settings = { pcScreen: { input: true }, keys: { swapCtrlCmd: true } };
  const input = new RemoteInput({ settings, link: { peerOs: P.OS.MAC }, inputAllowed: () => true, helper: { send: (cmd, args) => sent.push({ cmd, ...args }) } });
  return { input, settings, sent };
}
test('keyup preserves keydown mapping when Ctrl/Cmd preference changes', () => {
  const f = fixture();
  f.input.handle({ t: P.T.IN_KEY_DOWN, code: 'MetaLeft' });
  const code = f.sent[0].ev.code; f.settings.keys.swapCtrlCmd = false;
  f.input.handle({ t: P.T.IN_KEY_DOWN, code: 'MetaLeft' });
  f.input.handle({ t: P.T.IN_KEY_UP, code: 'MetaLeft' });
  assert.equal(f.sent[1].ev.code, code); assert.equal(f.sent[2].ev.code, code);
  assert.equal(f.input.keyCodes.size, 0);
});
test('release clears previous key mappings before next control session', () => {
  const f = fixture(); f.input.handle({ t: P.T.IN_KEY_DOWN, code: 'MetaLeft' });
  f.input.release(); f.settings.keys.swapCtrlCmd = false;
  f.input.handle({ t: P.T.IN_KEY_DOWN, code: 'MetaLeft' });
  assert.equal(f.sent.at(-1).ev.code, 'MetaLeft');
});
test('nonfinite wheel deltas and invalid button numbers are ignored', () => {
  const f = fixture();
  f.input.handle({ t: P.T.IN_WHEEL, dx: Infinity, dy: 1 });
  f.input.handle({ t: P.T.IN_DOWN, b: -1 });
  f.input.handle({ t: P.T.IN_UP, b: 5 });
  f.input.handle({ t: 'unknown', code: 'KeyA' });
  assert.equal(f.sent.length, 0);
});
test('ordinary wheel and mouse button input remains available', () => {
  const f = fixture(); f.input.handle({ t: P.T.IN_WHEEL, dx: 1, dy: 2 });
  f.input.handle({ t: P.T.IN_DOWN, b: 0 }); f.input.handle({ t: P.T.IN_UP, b: 0 });
  assert.equal(f.sent.length, 3); assert.equal(f.sent[1].ev.t, P.T.K_DOWN); assert.equal(f.sent[2].ev.t, P.T.K_UP);
});
