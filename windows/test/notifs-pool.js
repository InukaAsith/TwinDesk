// Notifications as one pool across devices (docs/mesh.md): Notifs on simulated devices, each with its
// own Mesh, helper fake and toast class, joined by fake links (full, partial, ring, a legacy peer).
// Run with: node windows/test/notifs-pool.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const Notifs = require('../notifs.js');
const { Net, FakeHelper, fakeNotificationFor } = require('./support/fake-net.js');

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
let seq = 0;

// Devices ids (each a Notifs on its own Mesh), legacy devices, then the links.
async function world(ids, links, o = {}) {
  const net = new Net();
  const devs = {};
  for (const id of ids) {
    const dev = net.add(id, { name: 'PC-' + id });
    dev.helper = new FakeHelper();
    dev.settings = { notifs: { send: true, receive: !(o.receiveOff || []).includes(id), muted: [], hideText: false } };
    dev.notifs = new Notifs({
      bus: dev.bus,
      mesh: dev.mesh,
      helper: dev.helper,
      settings: dev.settings,
      save: () => {},
      selfIds: ['TwinDesk.test'],
      peerName: () => '',
      onChange: () => {},
      onClick: () => {},
      Notification: fakeNotificationFor(dev),
      selfName: 'PC-' + id,
    });
    devs[id] = dev;
  }
  for (const id of o.legacy || []) devs[id] = net.add(id, { name: 'OLD-' + id, legacy: true });
  for (const [a, b] of links) net.connect(a, b);
  await net.run();
  return { net, devs };
}

// A notification that starts on this device, as the helper reports it.
async function local(net, dev, ev = {}) {
  seq += 1;
  dev.helper.emit('event', 'notif', Object.assign({
    id: 'n' + seq, app: 'com.mail', appName: 'Mail', title: 'Hi', subtitle: '', body: 'Body text', at: Date.now(),
  }, ev));
  await net.run();
}

const full = (ids) => {
  const links = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) links.push([ids[i], ids[j]]);
  }
  return links;
};
const toasts = (dev) => dev.toasts.map((t) => t.opts);
const notifSends = (net) => net.sent('notif').length;

scenario('full mesh of three: a notification shows once on each other device, with the origin name', async () => {
  const { net, devs } = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  await local(net, devs.A);
  assert.deepStrictEqual(toasts(devs.A), []);
  for (const id of ['B', 'C']) {
    assert.strictEqual(toasts(devs[id]).length, 1, id);
    assert.strictEqual(toasts(devs[id])[0].title, 'Hi');
    assert.strictEqual(toasts(devs[id])[0].body, 'Mail · PC-A\nBody text');
  }
  assert.strictEqual(notifSends(net), 2, 'A sends to B and C; nothing relayed in a full mesh');
  assert.strictEqual(devs.B.notifs.pool.stats().relayed, 0);
});

scenario('a notification shown from another device is never sent back (echo suppression)', async () => {
  const { net, devs } = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  await local(net, devs.A);
  assert.strictEqual(toasts(devs.B).length, 1);
  // Windows reads the toast B just showed back from its notification database.
  await local(net, devs.B, { app: 'com.mail', appName: 'Mail', title: 'Hi', body: 'Body text' });
  assert.strictEqual(net.sent('notif', 'B').length, 0, 'the echo is not sent out');
  assert.strictEqual(devs.B.notifs.sent, 0);
  // A new notification from B itself still goes out to A and C.
  await local(net, devs.B, { title: 'Other', body: 'new' });
  assert.strictEqual(net.sent('notif', 'B').length, 2);
  assert.strictEqual(toasts(devs.A).length, 1, 'A shows B\'s new one, not its own echo');
});

scenario('five devices in a full mesh: each notification once on every other device', async () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const { net, devs } = await world(ids, full(ids));
  await local(net, devs.A);
  for (const id of ids.slice(1)) assert.strictEqual(toasts(devs[id]).length, 1, id);
  assert.strictEqual(toasts(devs.A).length, 0);
  assert.strictEqual(notifSends(net), 4);
  assert.strictEqual(devs.A.helper.watches.at(-1).on, true, 'the helper watches while a device accepts');
});

scenario('the helper watches only while a connected device accepts and we send', async () => {
  const ids = ['A', 'B', 'C'];
  const { net, devs } = await world(ids, full(ids));
  assert.strictEqual(devs.A.helper.watches.at(-1).on, true);
  devs.B.settings.notifs.receive = false;
  devs.B.notifs.applySettings();
  devs.C.settings.notifs.receive = false;
  devs.C.notifs.applySettings();
  await net.run();
  assert.strictEqual(devs.A.helper.watches.at(-1).on, false, 'nobody accepts any more');
  devs.C.settings.notifs.receive = true;
  devs.C.notifs.applySettings();
  await net.run();
  assert.strictEqual(devs.A.helper.watches.at(-1).on, true);
  devs.A.settings.notifs.send = false;
  devs.A.notifs.applySettings();
  assert.strictEqual(devs.A.helper.watches.at(-1).on, false, 'we do not send');
});

scenario('a device with receive off shows nothing and relays nothing', async () => {
  // Chain A-B-C-D with C off: the notification stops at C. Then a direct A-D link reaches D from A.
  const { net, devs } = await world(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']], { receiveOff: ['C'] });
  await local(net, devs.A);
  assert.strictEqual(toasts(devs.B).length, 1);
  assert.strictEqual(toasts(devs.C).length, 0);
  assert.strictEqual(toasts(devs.D).length, 0);
  assert.strictEqual(net.sent('notif', 'C').length, 0, 'C relays nothing');

  net.connect('A', 'D');
  await net.run();
  await local(net, devs.A, { title: 'second' });
  assert.strictEqual(toasts(devs.D).length, 1, 'D gets it from A, once');
  assert.strictEqual(toasts(devs.C).length, 0);
  assert.strictEqual(net.sent('notif', 'C').length, 0);
});

scenario('a device that sent notif.policy accept:false is not sent notifications', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']], { receiveOff: ['B'] });
  await local(net, devs.A);
  assert.strictEqual(toasts(devs.B).length, 0);
  assert.strictEqual(net.sent('notif', 'A', 'B').length, 0);
  assert.strictEqual(devs.A.notifs.sent, 0);
});

scenario('a partial mesh with a missing link relays; each device shows it once', async () => {
  // A-B, B-C, C-D, D-E and A-C: no B-D, no A-E.
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const { net, devs } = await world(ids, [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['A', 'C']]);
  await local(net, devs.A);
  for (const id of ids.slice(1)) {
    assert.strictEqual(toasts(devs[id]).length, 1, id);
    assert.strictEqual(toasts(devs[id])[0].body.split('\n')[0], 'Mail · PC-A', id);
  }
  assert.strictEqual(notifSends(net), 4, 'A-B, A-C, C-D, D-E');
});

scenario('a ring applies each notification once, without a storm', async () => {
  const ids = ['A', 'B', 'C', 'D'];
  const { net, devs } = await world(ids, [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']]);
  await local(net, devs.A);
  for (const id of ids.slice(1)) assert.strictEqual(toasts(devs[id]).length, 1, id);
  assert.ok(notifSends(net) <= 6, 'bounded: ' + notifSends(net));
});

scenario('muted apps are not sent; hidden text is not sent', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']]);
  devs.A.settings.notifs.muted = ['com.mail'];
  await local(net, devs.A);
  assert.strictEqual(notifSends(net), 0);
  assert.strictEqual(toasts(devs.B).length, 0);

  devs.A.settings.notifs.muted = [];
  devs.A.settings.notifs.hideText = true;
  await local(net, devs.A, { app: 'com.chat', appName: 'Chat', title: 'Hey', body: 'secret text' });
  assert.strictEqual(toasts(devs.B).length, 1);
  assert.strictEqual(toasts(devs.B)[0].body, 'Chat · PC-A', 'no body text on the other device');
});

scenario('a legacy one-to-one peer (no stamps) works both ways, and a mesh device relays its items', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B'], ['A', 'L']], { legacy: ['L'] });
  // The old app accepts our notifications and sends its own.
  devs.L.bus.send('A', { t: 'notif.policy', accept: true });
  await net.run();
  devs.L.bus.send('A', { t: 'notif', id: '1', app: 'com.old', appName: 'Old', title: 'Legacy', body: 'from old' });
  await net.run();
  assert.strictEqual(toasts(devs.A).length, 1, 'A shows the old app\'s notification once');
  assert.strictEqual(toasts(devs.A)[0].body.split('\n')[0], 'Old · OLD-L');
  assert.strictEqual(toasts(devs.B).length, 1, 'relayed by A once');
  assert.strictEqual(toasts(devs.B)[0].body.split('\n')[0], 'Old · PC-A', 'B does not know the old device: sender name');

  // Our notification reaches the old app as a plain message.
  await local(net, devs.A, { title: 'mine' });
  const toOld = devs.L.received.filter((r) => r.msg.t === 'notif').map((r) => r.msg);
  assert.deepStrictEqual(toOld.map((m) => m.title), ['mine']);
  for (const k of ['o', 's', 'd', 'h']) assert.ok(!(k in toOld[0]), 'plain: no ' + k);
});

scenario('one connected device: a notification goes both ways, once', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']]);
  await local(net, devs.A);
  await local(net, devs.B, { title: 'back' });
  assert.deepStrictEqual(toasts(devs.B).map((t) => t.title), ['Hi']);
  assert.deepStrictEqual(toasts(devs.A).map((t) => t.title), ['back']);
  assert.strictEqual(notifSends(net), 2);
});

async function main() {
  for (const s of scenarios) {
    try {
      await s.fn();
    } catch (e) {
      e.message = s.name + ': ' + e.message;
      throw e;
    }
  }
  console.log('notifs-pool: ' + scenarios.length + ' scenarios passed');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
