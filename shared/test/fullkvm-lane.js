// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM: no native input lane on our own helper, not even before the service is up (the moves
// went past the service's return watch and the pointer never came back).
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
process.env.TWINDESK_KVM_SOCK = path.join(__dirname, 'no-such-kvm.sock'); // the service isn't there (yet)
const edition = require('../edition.js');

class Base extends EventEmitter {
  request(cmd, args) { return Promise.resolve({ cmd, ...args, port: 4242 }); }
  send() {}
}
const Helper = require('../fullkvm/route.js')(Base);

(async () => {
  const h = new Helper();
  assert.ok(h.svc, 'Full KVM is on in this checkout');
  assert.strictEqual(h.viaService, false);
  await assert.rejects(h.request('lane', { op: 'bind', lane: 1 }), /no native lane/);
  assert.deepStrictEqual(await h.request('info', {}), { cmd: 'info', port: 4242 }); // the rest still goes to ours
  h.svc.stop();

  edition.moduleOff(true); // General › Modules › Full KVM off: our helper's lane as ever
  const plain = new Helper();
  assert.strictEqual(plain.svc, null);
  assert.strictEqual((await plain.request('lane', { op: 'bind', lane: 1 })).port, 4242);
  console.log('fullkvm-lane: ok');
})().catch((e) => { console.error(e); process.exit(1); });
