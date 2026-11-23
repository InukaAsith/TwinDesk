// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An introduction again for a pair that is already linked (autojoin.js): the host makes a new token, and
// the guest must not be locked out by it. Before, the host took only the newest token and the guest,
// linked already, threw it away: at its next connect the host said BAD_TOKEN and the guest forgot it for
// good (the Mac 'via Ryzen9' on nitro, 2026-11-23). Now the host takes the last ones too, and the guest
// keeps the new one.
// Run with: node windows/mesh/test/regrant.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { memoryStorage } = require('./lib/mesh.js');

function fakeServer() {
  const s = new EventEmitter();
  s.failed = [];
  s.authed = [];
  s.fail = (ctx, code) => s.failed.push(code);
  s.authenticate = (ctx, who) => s.authed.push(who.deviceId);
  s.closeDevice = () => {};
  return s;
}

const hello = (server, token) => server.emit('preauth', {}, { t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: 'guest-1', name: 'Guest', os: P.OS.MAC, token });

// Host: every grant a new token; the last two before it still let the guest in, an older one doesn't.
{
  const server = fakeServer();
  const pairing = new Pairing(server, { id: 'host-1', name: 'Host', fp: 'ab'.repeat(32) }, { storage: memoryStorage() });
  const t1 = pairing.grantFor({ id: 'guest-1', name: 'Guest', os: P.OS.MAC }).token;
  const t2 = pairing.grantFor({ id: 'guest-1', name: 'Guest', os: P.OS.MAC }).token;
  hello(server, t1);
  assert.deepStrictEqual(server.authed, ['guest-1'], 'the token before the new one');
  const t3 = pairing.grantFor({ id: 'guest-1', name: 'Guest', os: P.OS.MAC }).token;
  const t4 = pairing.grantFor({ id: 'guest-1', name: 'Guest', os: P.OS.MAC }).token;
  hello(server, t2);
  hello(server, t3);
  hello(server, t4);
  assert.deepStrictEqual(server.authed, ['guest-1', 'guest-1', 'guest-1', 'guest-1']);
  hello(server, t1);
  hello(server, 'ff'.repeat(32));
  assert.deepStrictEqual(server.failed, [P.E.BAD_TOKEN, P.E.BAD_TOKEN], 'three grants old, or never made');
  assert.strictEqual(pairing.paired.length, 1);
  pairing.forget('guest-1');
  hello(server, t4);
  assert.strictEqual(server.failed.length, 3, 'forgotten: none of them');
}

// Guest: a grant for a host it is linked to already keeps the new token (stored too), the session untouched.
{
  const storage = memoryStorage();
  const links = new LinkManager({ device: { id: 'guest-1', name: 'Guest' }, storage, hostPairing: { list: () => [] } });
  const grant = (token) => ({ macId: 'host-1', macName: 'Host', os: P.OS.MAC, fp: 'ab'.repeat(32), port: 47800, addrs: ['192.168.1.2'], token });
  assert.strictEqual(links.addGrant(grant('11'.repeat(32))), 'added');
  const link = links.get('host-1');
  link.authed = true;
  assert.strictEqual(links.addGrant(grant('22'.repeat(32))), 'kept the new token of');
  assert.strictEqual(links.get('host-1'), link, 'the same link');
  assert.strictEqual(link.pairing.token, '22'.repeat(32));
  assert.strictEqual(storage.read('pairings.json', []).find((e) => e.macId === 'host-1').token, '22'.repeat(32));
  assert.strictEqual(links.addGrant(grant('22'.repeat(32))), '', 'the same token: nothing');
  links.close && links.close();
}

console.log('regrant: all passed');
