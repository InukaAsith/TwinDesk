// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// phone.info keeps the app's version and caps (Mac, PC, Linux phone.js): without them every phone
// looked too old for Limited mirroring.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const P = require('../protocol.js');
const Modes = require('../phonemodes.js');

for (const os of ['mac', 'windows', 'linux']) {
  const { Phone } = require(path.join(__dirname, '..', '..', os, 'phone.js'));
  const server = new EventEmitter();
  server.sendToClient = () => {};
  server.current = null;
  const phone = new Phone({ server, raw: new EventEmitter(), discovery: new EventEmitter(), pairing: new EventEmitter() });
  const ctx = { os: P.OS.ANDROID };
  server.emit(`t:${P.T.PHONE_INFO}`, { model: 'X', app: '2.5.0', caps: ['mirror.native', 7] }, ctx);
  assert.strictEqual(phone.info.app, '2.5.0', os);
  assert.ok(Modes.caps(phone.info).has('mirror.native'), `${os}: caps kept`);
  server.emit(`t:${P.T.PHONE_INFO}`, { model: 'X' }, ctx);
  assert.ok(!Modes.caps(phone.info).has('mirror.native'), `${os}: an older app has none`);
}
console.log('phone info caps ok');
