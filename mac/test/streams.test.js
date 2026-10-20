// Share screen to several devices on the Mac: a Stream per connected device on a peer bound to it,
// a choice of its own per device, the active one answers for the single-stream API.
// Run with: node mac/test/streams.test.js  (NODE_PATH as in CI)
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { StreamSet } = require('../streams.js');
const { node, close, waitFor, pairPhone, helloPhone } = require('./lib/mesh.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MODEL = [
  { id: '1', name: 'Built-in', x: 0, y: 0, w: 3024, h: 1964, scale: 2, primary: true },
  { id: '2', name: 'Left', x: -1920, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
  { id: '9', name: 'TwinDesk', x: 3024, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
];

function fakeStream(log) {
  return (peer) => {
    const st = new EventEmitter();
    Object.assign(st, { choice: null, view: { status: 'off' }, audio: { on: false }, got: [] });
    st.restart = (r) => log.push([peer.id, r]);
    st.stop = () => {};
    peer.on(`t:${T.SCREEN_POLICY}`, (m) => st.got.push(m));
    return st;
  };
}

test('a stream per device, choices of their own, the single-stream API follows the selection', async () => {
  const A = await node('A');
  const clients = [];
  try {
    const log = [];
    const set = new StreamSet({ hub: A.hub, server: A.server, displays: { model: () => MODEL }, make: fakeStream(log) });
    assert.strictEqual(set.all.length, 1);
    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await waitFor(() => set.byId.has(p1.id), 'device one has a stream');
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p2.id), 'device two has a stream');
    assert.strictEqual(set.all.length, 2);
    assert.strictEqual(set.first, set.byId.get(p1.id));

    p2.client.send({ t: T.SCREEN_POLICY, accept: true });
    await waitFor(() => set.byId.get(p2.id).got.length === 1, 'stream two heard its device');
    assert.strictEqual(set.byId.get(p1.id).got.length, 0, 'stream one did not');

    assert.strictEqual(set.view.displays.length, 3);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'mirror', displayId: '2' }).ok, true);
    assert.deepStrictEqual(set.byId.get(p1.id).choice, { mode: 'mirror', displayId: 2 });
    assert.strictEqual(set.setTarget(p2.id, { mode: 'virtual' }).ok, true);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'virtual' }).ok, false, 'one virtual display');
    assert.strictEqual(set.setTarget(p1.id, { mode: 'mirror', displayId: '77' }).ok, false, 'unknown display');
    assert.strictEqual(set.setTarget(p1.id, { mode: 'none' }).ok, true);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'default' }).ok, true);
    assert.strictEqual(set.byId.get(p1.id).choice, null);
    assert.ok(log.some(([id, r]) => id === p2.id && r === 'target choice'), 'a choice restarts that stream');

    A.hub.select(p2.id);
    assert.strictEqual(set.active, set.byId.get(p2.id));
    assert.strictEqual(set.view.deviceId, p2.id);
    assert.strictEqual(set.view.targets.length, 2);

    p2.client.close();
    await waitFor(() => !A.hub.sessions.get(p2.id).connected, 'device two gone');
    assert.ok(!set.table[p2.id]);
  } finally {
    for (const c of clients) { try { c.close(); } catch (_) { /* already */ } }
    close(A);
  }
});

require('../../windows/test/lib/run.js').runTests(tests);
