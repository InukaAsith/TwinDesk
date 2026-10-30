// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connect by address: a paired computer is not asked to confirm again, a host this Mac
// dials is dialled even when it is not a Mac, and the pending hint ends when that
// session is up. Run with: node mac/mesh/test/connect-plan.test.js
'use strict';

const assert = require('assert');
const { planConnect, settleConnect, sessionIsUp } = require('../../connect-plan.js');

const pc = { id: 'pc', name: 'Desk', os: 'win', address: '192.168.1.20', port: 47800 };
const mac = { id: 'mac', name: 'Other', os: 'mac', address: '192.168.1.30', port: 47800 };
const phone = { id: 'ph', name: 'Pixel', os: 'android', address: '192.168.1.40', port: 47800 };

{
  const plan = planConnect({ dev: pc, address: pc.address, pairedIds: ['pc'], hosts: [] });
  assert.strictEqual(plan.action, 'invite');
  assert.strictEqual(plan.expect, true);
  assert.strictEqual(plan.message, 'Connecting to Desk…');
  assert.strictEqual(plan.pending.id, 'pc');
}

{
  const plan = planConnect({
    dev: pc,
    address: pc.address,
    pairedIds: [],
    hosts: [{ id: 'pc', name: 'Desk', address: '10.0.0.8', port: 47800 }],
  });
  assert.strictEqual(plan.action, 'dial');
  assert.strictEqual(plan.id, 'pc');
  assert.strictEqual(plan.address, '192.168.1.20');
  assert.strictEqual(plan.message, 'Connecting to Desk…');
}

{
  const plan = planConnect({ dev: pc, address: pc.address, pairedIds: [], hosts: [] });
  assert.strictEqual(plan.action, 'invite');
  assert.strictEqual(plan.expect, false);
  assert.strictEqual(plan.inviting, false);
  assert.strictEqual(plan.message, 'Asked Desk to connect. Confirm on Desk.');
}

{
  const known = planConnect({ dev: phone, pairedIds: ['ph'], hosts: [] });
  assert.strictEqual(known.action, 'phone');
  const fresh = planConnect({ dev: phone, pairedIds: [], hosts: [] });
  assert.strictEqual(fresh.action, 'invite');
  assert.strictEqual(fresh.inviting, true);
  assert.strictEqual(fresh.message, 'Asked Pixel to connect. Confirm on Pixel.');
}

{
  const plan = planConnect({
    dev: null,
    address: '192.168.1.30',
    pairedIds: [],
    hosts: [{ id: 'mac', name: 'Other', address: '192.168.1.30', port: 47800 }],
  });
  assert.strictEqual(plan.action, 'dial');
  assert.strictEqual(plan.id, 'mac');
}

{
  const plan = planConnect({ dev: null, address: '192.168.1.50', pairedIds: [], hosts: [] });
  assert.strictEqual(plan.action, 'pair');
  assert.strictEqual(plan.address, '192.168.1.50');
}

{
  const guest = planConnect({ dev: mac, pairedIds: ['mac'], hosts: [{ id: 'mac', name: 'Other', address: mac.address }] });
  assert.strictEqual(guest.action, 'invite');
  assert.strictEqual(guest.expect, true);
  const host = planConnect({ dev: mac, pairedIds: [], hosts: [{ id: 'mac', name: 'Other', address: '10.0.0.1' }] });
  assert.strictEqual(host.action, 'dial');
  assert.strictEqual(host.address, mac.address);
}

{
  const connect = {
    busy: false,
    message: 'Asked Desk to connect. Confirm on Desk.',
    error: false,
    pending: { id: 'pc', name: 'Desk', address: '192.168.1.20' },
    inviting: null,
  };
  assert.strictEqual(settleConnect(connect, { deviceId: 'other' }), null);
  assert.deepStrictEqual(settleConnect(connect, { deviceId: 'pc', name: 'Desk' }), {
    busy: false, message: '', error: false, pending: null, inviting: null,
  });
  const phoneWait = { ...connect, pending: null, inviting: { id: 'ph', name: 'Pixel' } };
  assert.strictEqual(settleConnect(phoneWait, { id: 'ph' }).message, '');
}

{
  assert.strictEqual(sessionIsUp('pc', { current: { deviceId: 'pc' } }), true);
  assert.strictEqual(sessionIsUp('pc', { clients: [{ deviceId: 'pc' }] }), true);
  assert.strictEqual(sessionIsUp('pc', { authedHostIds: ['pc'] }), true);
  assert.strictEqual(sessionIsUp('pc', { current: { deviceId: 'other' } }), false);
}

console.log('connect-plan: ok');
