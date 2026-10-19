// Clipboard as one pool across devices (docs/mesh.md): Clip on simulated devices, each with its own
// Mesh and fake clipboard, joined by fake links (full meshes, partial meshes, rings, a legacy peer).
// Run with: node windows/test/clip-pool.js  (NODE_PATH and ELECTRON_OVERRIDE_DIST_PATH as in CI)
'use strict';

const assert = require('assert');
const Clip = require('../clip.js');
const { Net, fakeClipboard } = require('./support/fake-net.js');

const made = [];
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// Devices ids (each a Clip on its own Mesh), legacy devices (old one-to-one apps), then the links.
async function world(ids, links, o = {}) {
  const net = new Net();
  const devs = {};
  for (const id of ids) {
    const dev = net.add(id, { name: 'PC-' + id });
    dev.clipboard = fakeClipboard();
    dev.settings = {
      enabled: true,
      send: true,
      receive: !(o.receiveOff || []).includes(id),
      mode: o.instant ? 'instant' : 'switch',
      historySize: 20,
      maxKB: 256,
      skipConcealed: true,
    };
    dev.clip = new Clip({
      bus: dev.bus, mesh: dev.mesh, getSettings: () => dev.settings, onChange: () => {}, clipboard: dev.clipboard,
    });
    made.push(dev.clip);
    devs[id] = dev;
  }
  for (const id of o.legacy || []) devs[id] = net.add(id, { name: 'OLD-' + id, legacy: true });
  for (const [a, b] of links) net.connect(a, b);
  await net.run();
  return { net, devs };
}

// A copy on one device: the clipboard changes, then the device sends it the way its mode does.
async function copy(net, dev, text) {
  dev.clipboard.text = text;
  if (dev.settings.mode === 'instant') await dev.clip.pollOnce();
  else await dev.clip.sendIfChanged('copy');
  await net.run();
}

// Instant mode: every device polls several times; nothing must be sent by polls alone.
async function pollAll(devs, ids, rounds = 3) {
  for (let r = 0; r < rounds; r++) {
    for (const id of ids) await devs[id].clip.pollOnce();
  }
}

const full = (ids) => {
  const links = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) links.push([ids[i], ids[j]]);
  }
  return links;
};
const writes = (dev) => dev.clipboard.writes;
const clipSends = (net) => net.sent('clip').length;

scenario('full mesh of three: a copy reaches each device once and never comes back', async () => {
  const { net, devs } = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  await copy(net, devs.A, 'hello');
  assert.deepStrictEqual(writes(devs.A), []);
  assert.deepStrictEqual(writes(devs.B), ['hello']);
  assert.deepStrictEqual(writes(devs.C), ['hello']);
  assert.strictEqual(clipSends(net), 2, 'A sends to B and C; nothing is relayed in a full mesh');
  assert.strictEqual(devs.B.clip.pool.stats().relayed, 0);
  assert.deepStrictEqual(devs.B.clip.view.history.map((h) => [h.dir, h.from]), [['in', 'PC-A']]);
  assert.strictEqual(devs.A.clip.view.history[0].dir, 'out');
});

scenario('instant mode on five devices: polls on every device do not ping-pong', async () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const { net, devs } = await world(ids, full(ids), { instant: true });
  await copy(net, devs.A, 'one');
  await pollAll(devs, ids);
  await net.run();
  assert.strictEqual(clipSends(net), 4, 'one copy costs n-1 sends');
  assert.deepStrictEqual(writes(devs.A), []);
  for (const id of ['B', 'C', 'D', 'E']) assert.deepStrictEqual(writes(devs[id]), ['one']);

  await copy(net, devs.C, 'two');
  await pollAll(devs, ids);
  await net.run();
  assert.strictEqual(clipSends(net), 8, 'the second copy costs n-1 more');
  assert.deepStrictEqual(writes(devs.A), ['two']);
  assert.deepStrictEqual(writes(devs.B), ['one', 'two']);
});

scenario('partial mesh with a missing link: relayed, each device once', async () => {
  // A-B, B-C, C-D, D-E and A-C: no B-D, no A-E. The copy from A reaches D through C and E through D.
  const links = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['A', 'C']];
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const { net, devs } = await world(ids, links);
  await copy(net, devs.A, 'x');
  assert.deepStrictEqual(writes(devs.A), []);
  for (const id of ['B', 'C', 'D', 'E']) assert.deepStrictEqual(writes(devs[id]), ['x'], id);
  assert.strictEqual(clipSends(net), 4, 'A-B, A-C, C-D, D-E');
  assert.ok(devs.C.clip.pool.stats().relayed > 0, 'C relays to D');
});

scenario('a ring (a cycle) applies each copy once and does not storm', async () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const links = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'A']];
  const { net, devs } = await world(ids, links);
  await copy(net, devs.A, 'r');
  for (const id of ['B', 'C', 'D', 'E']) assert.deepStrictEqual(writes(devs[id]), ['r'], id);
  assert.ok(devs.D.clip.pool.stats().droppedDup >= 1, 'D gets it from C and from E: the second is dropped');
  assert.strictEqual(clipSends(net), 6, 'every link carries it at most once in each direction');
});

scenario('a device with receive off gets nothing and relays nothing', async () => {
  // Chain A-B-C-D with C off: the copy stops at C. Then a direct A-D link reaches D from A.
  const { net, devs } = await world(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']], { receiveOff: ['C'] });
  await copy(net, devs.A, 'x');
  assert.deepStrictEqual(writes(devs.B), ['x']);
  assert.deepStrictEqual(writes(devs.C), []);
  assert.deepStrictEqual(writes(devs.D), []);
  assert.strictEqual(net.sent('clip', 'C').length, 0, 'C relays nothing');

  net.connect('A', 'D');
  await net.run();
  await copy(net, devs.A, 'y');
  assert.deepStrictEqual(writes(devs.D), ['y'], 'D gets it from A, once');
  assert.deepStrictEqual(writes(devs.C), []);
  assert.strictEqual(net.sent('clip', 'C').length, 0);
});

scenario('a device that sent clip.policy accept:false is not sent items', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']], { receiveOff: ['B'] });
  await copy(net, devs.A, 'to b?');
  assert.deepStrictEqual(writes(devs.B), []);
  assert.strictEqual(net.sent('clip', 'A', 'B').length, 0);
  assert.match(devs.A.clip.view.lastSkip, /doesn't accept/);
  // B's own copy still goes to A: its receive switch never stopped its sending (one-to-one rule).
  await copy(net, devs.B, 'from b');
  assert.deepStrictEqual(writes(devs.A), ['from b']);
});

scenario('two copies at once on different devices: both propagate, each device applies each once', async () => {
  const { net, devs } = await world(['A', 'B', 'C'], full(['A', 'B', 'C']));
  devs.A.clipboard.text = 'x';
  await devs.A.clip.sendIfChanged('copy');
  devs.B.clipboard.text = 'y';
  await devs.B.clip.sendIfChanged('copy');
  await net.run();
  // Arrival order: A gets y, B gets x, C gets x then y. Each device ends with the last item it applied.
  assert.deepStrictEqual(writes(devs.A), ['y']);
  assert.deepStrictEqual(writes(devs.B), ['x']);
  assert.deepStrictEqual(writes(devs.C), ['x', 'y']);
  assert.strictEqual(devs.A.clipboard.text, 'y');
  assert.strictEqual(devs.B.clipboard.text, 'x');
  assert.strictEqual(devs.C.clipboard.text, 'y');
});

scenario('copies one after another: the last writer wins on every device', async () => {
  const ids = ['A', 'B', 'C'];
  const { net, devs } = await world(ids, full(ids));
  await copy(net, devs.A, 'x');
  await copy(net, devs.B, 'y');
  for (const id of ids) assert.strictEqual(devs[id].clipboard.text, 'y', id);
  assert.deepStrictEqual(writes(devs.C), ['x', 'y']);
});

scenario('a legacy one-to-one peer (no stamps) works, and a mesh device relays its items', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B'], ['A', 'L']], { legacy: ['L'] });
  // The old app sends a plain clip: A applies it, B gets it relayed (stamped by A) once.
  devs.L.bus.send('A', { t: 'clip', text: 'from old' });
  await net.run();
  assert.deepStrictEqual(writes(devs.A), ['from old']);
  assert.deepStrictEqual(writes(devs.B), ['from old']);
  // B has no entry for the old device, so the origin name falls back to the sender's (A).
  assert.deepStrictEqual(devs.B.clip.view.history.map((h) => h.from), ['PC-A']);
  assert.deepStrictEqual(devs.A.clip.view.history.map((h) => h.from), ['OLD-L']);

  // A's copy reaches the old app as a plain message: no pool fields.
  await copy(net, devs.A, 'mine');
  const toOld = devs.L.received.filter((r) => r.msg.t === 'clip').map((r) => r.msg);
  assert.deepStrictEqual(toOld.map((m) => m.text), ['mine']);
  for (const k of ['o', 's', 'd', 'h']) assert.ok(!(k in toOld[0]), 'plain: no ' + k);
  assert.deepStrictEqual(writes(devs.B), ['from old', 'mine']);
});

scenario('clip.request goes to the selected device only; its answer is a pool copy', async () => {
  const ids = ['A', 'B', 'C'];
  const { net, devs } = await world(ids, full(ids));
  devs.B.clipboard.text = 'on B'; // copied on B, not sent yet
  devs.A.selected = 'B';
  devs.A.clip.request();
  await net.run();
  assert.strictEqual(net.sent('clip.request').length, 1);
  assert.strictEqual(net.sent('clip.request', 'A', 'B').length, 1);
  // B answers with its copy to the pool: A (the requester) and C each get it once.
  assert.deepStrictEqual(writes(devs.A), ['on B']);
  assert.deepStrictEqual(writes(devs.C), ['on B']);
  assert.strictEqual(net.sent('clip', 'B').length, 2);

  // Asking again without a change: nothing is sent.
  devs.A.clip.request();
  await net.run();
  assert.strictEqual(net.sent('clip', 'B').length, 2);
});

scenario('our clip.policy goes to a newly connected device only', async () => {
  const ids = ['A', 'B', 'C'];
  const { net } = await world(ids, [['A', 'B']]);
  net.log.length = 0;
  net.connect('A', 'C');
  await net.run();
  assert.deepStrictEqual(net.sent('clip.policy', 'A').map((e) => e.to), ['C']);
});

scenario('one connected device behaves as the one-to-one code did', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']], { instant: true });
  await copy(net, devs.A, 'solo');
  assert.deepStrictEqual(writes(devs.B), ['solo']);
  assert.strictEqual(clipSends(net), 1);
  await pollAll(devs, ['A', 'B'], 2);
  await net.run();
  assert.strictEqual(clipSends(net), 1, 'polls send nothing new');
  assert.deepStrictEqual(devs.A.clip.view.history.map((h) => h.dir), ['out']);
  assert.deepStrictEqual(devs.B.clip.view.history.map((h) => h.dir), ['in']);
});

scenario('the size limit and concealed items are not sent', async () => {
  const { net, devs } = await world(['A', 'B'], [['A', 'B']]);
  devs.A.settings.maxKB = 1;
  devs.A.clipboard.text = 'x'.repeat(2048);
  await devs.A.clip.sendIfChanged('copy');
  await net.run();
  assert.strictEqual(clipSends(net), 0);
  assert.match(devs.A.clip.view.lastSkip, /over 1 KB/);

  devs.A.settings.maxKB = 256;
  devs.A.clipboard.concealed = true;
  devs.A.clipboard.text = 'a password';
  await devs.A.clip.sendIfChanged('copy');
  await net.run();
  assert.strictEqual(clipSends(net), 0);
  assert.match(devs.A.clip.view.lastSkip, /password/);
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
  for (const c of made) c.destroy();
  console.log('clip-pool: ' + scenarios.length + ' scenarios passed');
}

main().catch((e) => {
  for (const c of made) c.destroy();
  console.error(e);
  process.exitCode = 1;
});
