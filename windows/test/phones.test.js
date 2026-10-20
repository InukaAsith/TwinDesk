// Two phones at once: each gets a stack of its own (Phone, bridge, windows), Kvm's `local` routes by the
// partner it drives, and what one phone says about itself never lands on the other.
// Run with: node windows/test/phones.test.js  (NODE_PATH as in CI)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../../shared/protocol.js');
const { Mesh } = require('../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const { PhoneLink } = require('../phone-link.js');
const { Phone } = require('../phone.js');
const { PhoneSet } = require('../phones.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pairPhone, helloPhone, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  return { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub };
}

// A bridge that records what Kvm hands it; the real Phone class on the scoped link.
function fakeStack(log) {
  return (scoped) => {
    const phone = new Phone({ server: scoped, raw: scoped.raw, discovery: { list: () => [], get: () => null }, pairing: { list: () => [] } });
    const bridge = {
      state: 'ready', via: 'usb', view: { state: 'ready' }, ready: true,
      handle(m) { log.push({ id: scoped.id, m }); },
      drivable() { return this.ready; },
      on() {},
    };
    phone.bridge = bridge;
    const views = { focused: false, shutdown() {}, on() {} };
    return { phone, bridge, views };
  };
}

test('two phones: a stack each, routed by id, what each says about itself stays with it', async () => {
  const A = await hubNode('A');
  const clients = [];
  try {
    const pl = new PhoneLink(A.hub, A.server);
    const log = [];
    const set = new PhoneSet({ hub: A.hub, link: pl, raw: A.server, discovery: { list: () => [], get: () => null }, pairing: { list: () => [] }, make: fakeStack(log) });
    assert.strictEqual(set.all.length, 1, 'one stack waits before any phone is there');
    assert.ok(set.bridge, 'the single-phone API works with no phone');

    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await waitFor(() => set.byId.has(p1.id), 'phone one has its stack');
    assert.strictEqual(set.all.length, 1, 'the first phone took the waiting stack');
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p2.id), 'phone two has its stack');
    assert.strictEqual(set.all.length, 2);
    assert.notStrictEqual(set.byId.get(p1.id), set.byId.get(p2.id));

    p1.client.send({ t: T.PHONE_INFO, model: 'Pixel', maker: 'g', release: '15', sdk: 35, battery: 50, charging: false });
    p2.client.send({ t: T.PHONE_INFO, model: 'Galaxy', maker: 's', release: '15', sdk: 35, battery: 70, charging: true });
    await waitFor(() => set.byId.get(p1.id).phone.info && set.byId.get(p2.id).phone.info, 'both phones told about themselves');
    assert.strictEqual(set.byId.get(p1.id).phone.info.model, 'Pixel');
    assert.strictEqual(set.byId.get(p2.id).phone.info.model, 'Galaxy');

    // Kvm's local: by the partner
    assert.ok(set.drives(p1.id) && set.drives(p2.id));
    assert.ok(!set.drives('nobody'));
    set.handle({ t: T.K_MOVE, dx: 1, dy: 1 }, p2.id);
    set.handle({ t: T.K_MOVE, dx: 2, dy: 2 }, p1.id);
    assert.deepStrictEqual(log.map((x) => x.id), [p2.id, p1.id], 'each move reached the bridge of the phone it was for');
    set.byId.get(p2.id).bridge.ready = false;
    assert.strictEqual(set.drivable(p2.id), false, 'one phone down');
    assert.strictEqual(set.drivable(p1.id), true, 'the other one is fine');

    // the active phone follows the selection
    A.hub.select(p2.id);
    assert.strictEqual(set.active, set.byId.get(p2.id));
    assert.strictEqual(set.view.activeId, p2.id);
    assert.strictEqual(set.view.phones.length, 2);
    A.hub.select(p1.id);
    assert.strictEqual(set.active, set.byId.get(p1.id));

    // one phone leaves: the other stays connected and driven
    p2.client.close();
    await waitFor(() => !set.byId.get(p2.id).link.current, 'phone two is gone');
    assert.ok(set.drives(p1.id), 'phone one is still there');
    assert.ok(!set.drives(p2.id));
    assert.strictEqual(set.view.phones.length, 1);
  } finally {
    for (const c of clients) { try { c.close(); } catch (_) { /* already */ } }
    close(A);
  }
});

runTests(tests);
