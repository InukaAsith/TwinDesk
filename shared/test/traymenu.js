// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/traymenu.js: the tray menu by kind; only connecting, the window and Quit while not connected.
'use strict';

const assert = require('assert');
const { template } = require('../traymenu.js');

const sw = (label) => ({ label, checked: false, set: () => {} });
const model = (connected) => ({
  connected, status: connected ? 'Connected to PC' : 'Not connected', home: null,
  shared: sw(), keyboard: sw(), lock: connected ? sw('Lock') : null, drive: sw('Drive'), driven: sw('Driven'), popup: sw(),
  screen: [sw('Share Screen'), sw('Receive Screen')], clipboard: sw(), sound: sw(), drag: sw(), shortcuts: sw('Copy and Paste Files (⌃⌥C, ⌃⌥V)'),
  found: [], byAddress() {}, lookAgain() {}, again: null, disconnect: connected ? { label: 'Disconnect PC', click() {} } : null,
  update: { label: 'Update', click() {} }, open() {}, log() {}, quit() {},
});
const labels = (t) => t.filter((i) => i.label).map((i) => i.label);

assert.deepStrictEqual(labels(template(model(false))), ['Not connected', 'Connect To', 'Open TwinDesk…', 'Quit TwinDesk']);
const on = template(model(true));
assert.deepStrictEqual(labels(on), ['Connected to PC', 'Cursor Sharing', 'Mouse and Keyboard', 'Screen', 'Clipboard and Sound', 'Files', 'Connection', 'Update', 'Open TwinDesk…', 'Quit TwinDesk']);
assert.deepStrictEqual(labels(on.find((i) => i.label === 'Screen').submenu), ['Share Screen', 'Receive Screen']);
assert.strictEqual(on.find((i) => i.label === 'Connection').submenu[0].label, 'Disconnect PC');
assert.strictEqual(on.find((i) => i.label === 'Mouse and Keyboard').submenu[0].label, 'Share Keyboard');
console.log('traymenu: ok');
