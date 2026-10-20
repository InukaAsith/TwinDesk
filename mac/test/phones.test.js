// Two phones at once on the Mac: a stack each (Phone, bridge, windows) on a link bound to its phone, Kvm's
// `local` routed by the partner it drives, and what one phone says about itself never lands on the other.
// Run with: node mac/test/phones.test.js  (NODE_PATH as in CI)
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { Phone } = require('../phone.js');
const { PhoneSet, PhoneDir } = require('../phones.js');
const { node, close, waitFor, pairPhone, helloPhone } = require('./lib/mesh.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fakeStack(log) {
  return (scoped) => {
    const phone = new Phone({ server: scoped, raw: null, discovery: { list: () => [], get: () => null }, pairing: { list: () => [] } });
    const bridge = {
      state: 'ready', via: 'usb', view: { state: 'ready' }, ready: true,
      handle(m) { log.push({ id: scoped.id, m }); },
      drivable() { return this.ready; },
      on() {},
    };
    phone.bridge = bridge;
    return { phone, bridge, views: { focused: false, shutdown() {}, on() {} } };
  };
}

test('two phones: a stack each, routed by id, what each says about itself stays with it', async () => {
  const A = await node('A');
  const clients = [];
  try {
    const log = [];
    const set = new PhoneSet({ hub: A.hub, link: new PhoneDir(A.hub, A.server), raw: A.server, discovery: { list: () => [], get: () => null }, pairing: { list: () => [] }, make: fakeStack(log) });
    assert.strictEqual(set.all.length, 1);
    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await waitFor(() => set.byId.has(p1.id), 'phone one has its stack');
    assert.strictEqual(set.all.length, 1, 'the first phone took the waiting stack');
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p2.id), 'phone two has its stack');
    assert.strictEqual(set.all.length, 2);

    p1.client.send({ t: T.PHONE_INFO, model: 'Pixel', maker: 'g', release: '15', sdk: 35, battery: 50, charging: false });
    p2.client.send({ t: T.PHONE_INFO, model: 'Galaxy', maker: 's', release: '15', sdk: 35, battery: 70, charging: true });
    await waitFor(() => set.byId.get(p1.id).phone.info && set.byId.get(p2.id).phone.info, 'both told about themselves');
    assert.strictEqual(set.byId.get(p1.id).phone.info.model, 'Pixel');
    assert.strictEqual(set.byId.get(p2.id).phone.info.model, 'Galaxy');

    assert.ok(set.drives(p1.id) && set.drives(p2.id) && !set.drives('nobody'));
    set.handle({ t: T.K_MOVE, dx: 1, dy: 1 }, p2.id);
    set.handle({ t: T.K_MOVE, dx: 2, dy: 2 }, p1.id);
    assert.deepStrictEqual(log.map((x) => x.id), [p2.id, p1.id]);
    set.byId.get(p2.id).bridge.ready = false;
    assert.strictEqual(set.drivable(p2.id), false);
    assert.strictEqual(set.drivable(p1.id), true);

    // a phone's answer reaches Kvm as that phone's message
    const answers = [];
    set.reply = (msg, id) => answers.push([id, msg.t]);
    set.byId.get(p1.id).bridge.reply({ t: T.KVM_ACCEPT });
    assert.deepStrictEqual(answers, [[p1.id, T.KVM_ACCEPT]]);

    A.hub.select(p2.id);
    assert.strictEqual(set.active, set.byId.get(p2.id));
    A.hub.select(p1.id);
    assert.strictEqual(set.active, set.byId.get(p1.id));
    assert.strictEqual(set.view.phones.length, 2);

    p2.client.close();
    await waitFor(() => !set.byId.get(p2.id).link.current, 'phone two is gone');
    assert.ok(set.drives(p1.id) && !set.drives(p2.id));
    assert.strictEqual(set.view.phones.length, 1);
  } finally {
    for (const c of clients) { try { c.close(); } catch (_) { /* already */ } }
    close(A);
  }
});

const { runTests } = require('../../windows/test/lib/run.js');
runTests(tests);
