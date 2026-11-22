// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/peerstate.js and the Route that uses it (every Mac feature, and sound and mic everywhere): a
// device's policies sent while the route was elsewhere are played on 'client'; the device a route
// leaves hears the policies it was told go off; a device that drops is forgotten.
// Run: node shared/test/peerstate.test.js
'use strict';

const assert = require('assert');
const { Heard, Said } = require('../peerstate.js');
const { Route } = require('../hub-route.js');

// A hub as Route sees it: sessions by id, the selected id, the Heard of every device.
function fakeHub(ids) {
  const sent = {};
  const sessions = new Map();
  for (const id of ids) {
    sent[id] = [];
    sessions.set(id, {
      id, connected: true, hostUp: false, linkUp: false, role: 'guest', transport: 'ip', peerOs: 'win',
      status: { rtt: 1 }, lastRx: 0, link: null, ctx: null,
      displayName: () => id,
      send(m) { if (!this.connected) return false; sent[id].push(m); return true; },
    });
  }
  return { sessions, sent, selectedId: null, heard: new Heard() };
}

// Heard: the latest of each remembered type, without ask; other types are not kept.
{
  const h = new Heard();
  h.note('B', { t: 'audio.policy', accept: false });
  h.note('B', { t: 'audio.policy', accept: true, ask: true });
  h.note('B', { t: 'clip', text: 'x' });
  assert.deepStrictEqual(h.replay('B'), [{ t: 'audio.policy', accept: true }], 'latest, ask removed, clip not kept');
  assert.ok(h.by.get('B').get('audio.policy').ask, 'the kept message itself is untouched');
  h.forget('B');
  assert.deepStrictEqual(h.replay('B'), []);
}

// Said: what is on for the device it talks to; a policy switched off before is not switched off again.
{
  const s = new Said();
  s.note('B', { t: 'audio.policy', accept: true });
  s.note('B', { t: 'cam.policy', share: true });
  s.note('B', { t: 'cam.policy', share: false });
  s.note('B', { t: 'screen.state', on: true });
  assert.deepStrictEqual(s.goodbyes('C'), [], 'nothing for a device it did not talk to');
  assert.deepStrictEqual(s.goodbyes('B'), [{ t: 'audio.policy', accept: false }]);
  assert.deepStrictEqual(s.goodbyes('B'), [], 'once');
  s.note('B', { t: 'mic.policy', accept: true });
  s.note('C', { t: 'audio.policy', accept: true });
  assert.deepStrictEqual(s.goodbyes('B'), [], 'a new device: the old one was left already');
  s.forget('C');
  assert.deepStrictEqual(s.goodbyes('C'), [], 'forgotten (disconnected)');
}

// Route: replay after 'client', goodbye on leaving a device that is still connected, none after a drop.
{
  const hub = fakeHub(['B', 'C']);
  const route = new Route(hub, (h) => h.selectedId);
  const got = [];
  route.on('client', (v) => got.push(['client', v.deviceId]));
  route.on('closed', () => got.push(['closed']));
  route.on('t:audio.policy', (m) => got.push(['audio.policy', m.accept]));

  hub.selectedId = 'B';
  route.refresh();
  assert.deepStrictEqual(got, [['client', 'B']]);
  hub.heard.note('C', { t: 'audio.policy', accept: true }); // C spoke while the route was on B
  assert.strictEqual(route.send({ t: 'audio.policy', accept: true }), true);

  got.length = 0;
  hub.selectedId = 'C';
  route.refresh();
  assert.deepStrictEqual(got, [['closed'], ['client', 'C'], ['audio.policy', true]], 'closed, client, then what C said');
  assert.deepStrictEqual(hub.sent.B, [{ t: 'audio.policy', accept: true }, { t: 'audio.policy', accept: false }], 'B hears it go off');

  // C drops: no goodbye goes out (its session is down), and nothing is left to send later.
  route.send({ t: 'audio.policy', accept: true });
  hub.sessions.get('C').connected = false;
  route.drop('C');
  assert.deepStrictEqual(hub.sent.C, [{ t: 'audio.policy', accept: true }]);
  hub.sessions.get('C').connected = true;
  hub.selectedId = 'B';
  route.refresh();
  hub.selectedId = 'C';
  route.refresh();
  assert.deepStrictEqual(hub.sent.C, [{ t: 'audio.policy', accept: true }], 'no stale goodbye to C');
}

console.log('peerstate: all passed');
