// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Advanced › Input protocol: TCP (tdv1) turns the input lane off for this run, so the hello
// asks for none and an offer from the other side is answered with none (it stays on the session);
// UDP (tdv2) is the default. Run with: node shared/test/inputlane-protocol.js
'use strict';

const assert = require('assert');
delete process.env.TWINDESK_NO_IL;
const IL = require('../inputlane.js');

(async () => {
  assert.strictEqual(IL.laneOff(), false, 'UDP by default');

  const lane = new IL.InputLane();
  await lane.bind();
  assert.ok(lane.port, 'the lane bound');
  const hello = lane.helloField();
  assert.ok(hello && hello.v === 1, 'UDP: the hello carries the lane');

  IL.setLaneProtocol('tcp');
  assert.strictEqual(IL.laneOff(), true, 'TCP: no lane');
  assert.strictEqual(lane.helloField(), null, 'TCP: the hello asks for no lane');
  assert.strictEqual(lane.offer(hello, '127.0.0.1'), null, 'TCP: an offered lane is refused');
  assert.strictEqual(IL.linkLane(), null, 'TCP: a mesh link binds no lane');

  IL.setLaneProtocol('udp');
  assert.strictEqual(IL.laneOff(), false, 'back to UDP');
  IL.setLaneProtocol('nonsense');
  assert.strictEqual(IL.laneOff(), false, 'anything else is UDP');
  lane.stop();

  // The setting itself: udp unless tcp was chosen, on every desktop.
  for (const p of ['windows', 'linux']) {
    const { normalize } = require(`../../${p}/settings.js`);
    assert.strictEqual(normalize({}).app.inputProtocol, 'udp', `${p}: UDP by default`);
    assert.strictEqual(normalize({ app: { inputProtocol: 'tcp' } }).app.inputProtocol, 'tcp', `${p}: TCP kept`);
    assert.strictEqual(normalize({ app: { inputProtocol: 'x' } }).app.inputProtocol, 'udp', `${p}: junk is UDP`);
  }
  console.log('inputlane-protocol: ok');
})().catch((e) => { console.error(e); process.exit(1); });
