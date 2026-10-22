// Tests for shared/intro.js and the members part of shared/mesh.js.
// Run with: node shared/test/intro.js
'use strict';
const assert = require('assert');
const I = require('../intro.js');
const { Mesh, Roster } = require('../mesh.js');

// pickHost: a computer hosts for a phone; between computers the smaller id; two phones: none.
assert.strictEqual(I.pickHost({ id: 'p', os: 'android' }, { id: 'm', os: 'mac' }).host.id, 'm');
assert.strictEqual(I.pickHost({ id: 'b', os: 'win' }, { id: 'a', os: 'mac' }).host.id, 'a');
assert.strictEqual(I.pickHost({ id: 'p1', os: 'android' }, { id: 'p2', os: 'android' }), null);
assert.strictEqual(I.pickHost({ id: 'a', os: 'win' }, { id: 'b', os: 'mac' }, new Set(['a>b'])).host.id, 'b', 'an existing dial direction wins');

// plan: W linked to M, P1, P2; nobody else linked. Expect M<-P1, M<-P2 and no phone-phone.
{
  const roster = new Roster({ selfId: 'W' });
  roster.setSelf(['M', 'P1', 'P2']);
  const state = new Map();
  const peers = [{ id: 'M', os: 'mac' }, { id: 'P1', os: 'android' }, { id: 'P2', os: 'android' }];
  const out = I.plan({ selfId: 'W', peers, roster, state, now: 1000 });
  assert.deepStrictEqual(out.map((x) => `${x.host}>${x.guest}`).sort(), ['M>P1', 'M>P2']);
  assert.strictEqual(I.plan({ selfId: 'W', peers, roster, state, now: 2000 }).length, 0, 'not again within RETRY_MS');
  assert.strictEqual(I.plan({ selfId: 'W', peers, roster, state, now: 1000 + I.RETRY_MS + 1 }).length, 2, 'again later when still not linked');
  roster.setPeer('M', ['W', 'P1', 'P2']);
  assert.strictEqual(I.plan({ selfId: 'W', peers, roster, state: new Map(), now: 9e6 }).length, 0, 'linked pairs are left alone');
}

// validators
{
  const ok = { t: I.GRANT, req: 'r', macId: 'm', macName: 'Mac', os: 'mac', fp: 'ab'.repeat(32), port: 5000, addrs: ['192.168.1.5'], token: 'cd'.repeat(32) };
  assert.ok(I.validGrant(ok));
  assert.ok(!I.validGrant({ ...ok, fp: 'zz' }));
  assert.ok(!I.validGrant({ ...ok, token: 'not hex!' }));
  assert.ok(!I.validGrant({ ...ok, port: 0 }));
  assert.ok(!I.validGrant({ ...ok, addrs: [] }));
  assert.ok(I.validGrant({ t: I.REPLY, req: 'r', ok: false, error: 'no' }));
  assert.ok(I.validAsk({ t: I.ASK, req: 'r', for: 'g' }));
  assert.ok(!I.validAsk({ t: I.ASK, for: 'g' }));
}

// Pending: only the asked host, once, in time.
{
  const p = new I.Pending(1000);
  p.add('r', 'M', 'P', 0);
  assert.strictEqual(p.take('r', 'X', 10), null);
  p.add('r', 'M', 'P', 0);
  assert.ok(p.take('r', 'M', 10));
  assert.strictEqual(p.take('r', 'M', 10), null, 'once');
  p.add('r', 'M', 'P', 0);
  assert.strictEqual(p.take('r', 'M', 5000), null, 'expired');
}

// Mesh.known(): members of a peer's roster are listed as indirect devices.
{
  const m = new Mesh({ selfId: 'P' });
  m.addPeer({ id: 'W', name: 'Win', os: 'win', send: () => true, mesh: true });
  assert.strictEqual(m.known().length, 1);
  m.handle('W', { t: 'mesh.roster', peers: ['P', 'M'], members: [{ id: 'P', name: 'me', os: 'android' }, { id: 'M', name: 'Mac', os: 'mac' }] });
  const k = m.known();
  assert.deepStrictEqual(k.map((x) => `${x.id}:${x.direct}`).sort(), ['M:false', 'W:true']);
  assert.deepStrictEqual(k.find((x) => x.id === 'M').via, ['W']);
  m.addPeer({ id: 'M', name: 'Mac', os: 'mac', send: () => true, mesh: true });
  assert.strictEqual(m.known().find((x) => x.id === 'M').direct, true, 'now direct');
  m.removePeer('W');
  assert.strictEqual(m.known().length, 1, 'W gone: its members are forgotten');
  const msg = m.rosterMessage();
  assert.deepStrictEqual(msg.members, [{ id: 'M', name: 'Mac', os: 'mac' }]);
}
console.log('intro: passed');
