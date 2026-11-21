// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: the keyboard that crossed onto the phone sends in a chat app the same way the
// one-to-one bridge does (shared/phonechat.js, mac/phone-bridge.js). The hook is PhoneBridge#_key.
// It eats Return when phone.enterSends is on (the default; only false turns it off), the front app
// is a chat, and either Accessibility can click Send or, for a new line, the control channel can
// type. A raw Enter through Accessibility is a new line in a multiline field, so the message never
// goes. WhatsApp and Telegram without Accessibility keep their own Enter. Instagram without it is
// reached with Tab, then Enter. The matching key-up is swallowed only for a Return the hook ate.
// Run with: node --test mac/mesh/test/phone-enter.test.js
'use strict';

const assert = require('assert');
const os = require('os');
const Module = require('module');
const { test } = require('node:test');

// electron: only if a module asks while PhoneBridge loads (app.getPath). Nothing is written.
const electronStub = new Proxy(function stub() {}, {
  get(t, key) {
    if (key === Symbol.toPrimitive) return () => '';
    if (key === 'then') return undefined;
    if (key === 'getPath') return () => os.tmpdir();
    return electronStub;
  },
  apply() { return electronStub; },
  construct() { return electronStub; },
});
const realLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};

const P = require('../../../shared/protocol.js');
const { KeyState } = require('../../android-keys');
const { PhoneBridge } = require('../phone-bridge.js');

test.after(() => { Module._load = realLoad; });

const T = P.T;
const DOWN = 0; // KeyEvent.ACTION_DOWN, scrcpy's ACTION.DOWN
const UP = 1;
const ENTER = 66; // Android KEYCODE_ENTER
const TAB = 61;

function bridge(over) {
  const sent = [];
  const pressed = [];
  const taps = [];
  const typed = [];
  const b = {
    kvm: { route: 'phone' },
    ctl: {
      key: (action, keycode, meta) => pressed.push({ action, keycode, meta }),
      tap: (k) => taps.push(k),
    },
    server: {
      keySwap: () => false,
      sendToClient: (m) => sent.push(m),
    },
    getSettings: () => ({ phone: { enterSends: true }, keys: {} }),
    keys: new KeyState(),
    views: { activeApp: 'com.whatsapp', a11y: true },
    ...over,
  };
  return Object.assign(b, { sent, pressed, taps, typed });
}

const down = (code) => ({ t: T.K_KEY_DOWN, code });
const up = (code) => ({ t: T.K_KEY_UP, code });
const hit = (b, m) => PhoneBridge.prototype._key.call(b, m);

// Both edges of an ordinary Return: the key itself, down and up, and nothing else.
function ordinaryEnter(b) {
  hit(b, down('Enter'));
  hit(b, up('Enter'));
  assert.deepStrictEqual(b.sent, []);
  assert.deepStrictEqual(b.taps, []);
  assert.deepStrictEqual(b.typed, []);
  assert.deepStrictEqual(b.pressed, [
    { action: DOWN, keycode: ENTER, meta: 0 },
    { action: UP, keycode: ENTER, meta: 0 },
  ]);
}

test('Return in a chat app with Accessibility sends, and the key-up is swallowed', () => {
  const b = bridge();
  hit(b, down('Enter'));
  assert.deepStrictEqual(b.sent, [{ t: T.PHONE_SEND }]);
  assert.deepStrictEqual(b.pressed, []);
  assert.deepStrictEqual(b.taps, []);
  assert.strictEqual(b.enterEaten, true);
  hit(b, up('Enter'));
  assert.deepStrictEqual(b.sent, [{ t: T.PHONE_SEND }]);
  assert.deepStrictEqual(b.pressed, []);
  assert.strictEqual(b.enterEaten, false);
});

test('NumpadEnter in a chat app with Accessibility sends, and the key-up is swallowed', () => {
  const b = bridge();
  hit(b, down('NumpadEnter'));
  hit(b, up('NumpadEnter'));
  assert.deepStrictEqual(b.sent, [{ t: T.PHONE_SEND }]);
  assert.deepStrictEqual(b.pressed, []);
  assert.strictEqual(b.enterEaten, false);
});

test('Shift+Return types a new line and does not send, and the key-up is swallowed', () => {
  const b = bridge();
  b.ctl.text = (t) => b.typed.push(t);
  b.keys.held.add('ShiftLeft');
  hit(b, down('Enter'));
  hit(b, up('Enter'));
  assert.deepStrictEqual(b.typed, ['\n']);
  assert.deepStrictEqual(b.sent, []);
  assert.deepStrictEqual(b.pressed, []);
  assert.deepStrictEqual(b.taps, []);
  assert.strictEqual(b.enterEaten, false);
});

test('Return outside a chat app is an ordinary key', () => {
  const b = bridge();
  b.views = { activeApp: 'com.google.android.apps.messaging', a11y: true };
  ordinaryEnter(b);
});

test('Return with Enter sends messages off is an ordinary key', () => {
  const b = bridge();
  b.getSettings = () => ({ phone: { enterSends: false }, keys: {} });
  ordinaryEnter(b);
});

test('Return in WhatsApp without Accessibility is an ordinary key', () => {
  const b = bridge();
  b.views = { activeApp: 'com.whatsapp', a11y: false };
  ordinaryEnter(b);
});

test('Shift+Return with no text to type is an ordinary key and does not send', () => {
  const b = bridge();
  b.keys.held.add('ShiftLeft');
  const meta = b.keys.meta();
  hit(b, down('Enter'));
  hit(b, up('Enter'));
  assert.notStrictEqual(meta, 0);
  assert.deepStrictEqual(b.sent, []);
  assert.deepStrictEqual(b.typed, []);
  assert.deepStrictEqual(b.taps, []);
  assert.deepStrictEqual(b.pressed, [
    { action: DOWN, keycode: ENTER, meta },
    { action: UP, keycode: ENTER, meta },
  ]);
});

test('Instagram without Accessibility taps Tab then Enter and does not also inject the key', async () => {
  const b = bridge();
  b.views = { activeApp: 'com.instagram.android', a11y: false };
  hit(b, down('Enter'));
  hit(b, up('Enter'));
  assert.deepStrictEqual(b.sent, []);
  assert.deepStrictEqual(b.pressed, []);
  assert.deepStrictEqual(b.taps, [TAB]);
  assert.strictEqual(b.enterEaten, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(b.taps, [TAB, ENTER]);
  assert.deepStrictEqual(b.pressed, []);
});
