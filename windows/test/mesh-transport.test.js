// The mesh with the new transports: a session through Bluetooth (blepipe.js) keeps its own,
// longer silence limit on the server, and a Session reports its transport and tells its features
// when it moves between Bluetooth and the network (session.js, the hub's 'transport' event).
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Session } = require('../session.js');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair } = require('./lib/mesh.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a session on Bluetooth is not closed at the network silence limit, only at the Bluetooth one', async () => {
  const clock = { t: 1e12 };
  const A = await node('A', { now: () => clock.t, tick: false });
  const B = await node('B');
  try {
    await pair(B, A); // B dialled A: A's server holds B as a client
    await waitFor(() => A.server.clients.has(B.id), 'B as a client of A');
    const ctx = A.server.clients.get(B.id);
    const ws = ctx.ws;
    assert.strictEqual(ws.readyState, ws.OPEN);
    // This socket is a Bluetooth pipe (the server marks such sockets 'ble'); the fake clock runs on.
    ws.transport = 'ble';
    ws.lastRx = ctx.lastRx = clock.t;
    ws.lastTx = ctx.lastTx = clock.t;
    clock.t += P.TIMEOUT_MS + 500; // past the network limit, nothing received
    A.server.liveness(clock.t);
    assert.strictEqual(ws.readyState, ws.OPEN, 'a Bluetooth session survives the network silence limit');
    clock.t += P.BLE_TIMEOUT_MS - P.TIMEOUT_MS; // now past the Bluetooth limit as well
    A.server.liveness(clock.t);
    assert.notStrictEqual(ws.readyState, ws.OPEN, 'and is closed at the Bluetooth limit');
  } finally {
    close(A, B);
  }
});

test('a Session reports its transport and tells its features when it moves to Bluetooth and back', () => {
  const s = new Session('device-1');
  const link = new EventEmitter();
  Object.assign(link, { authed: true, transport: 'ip', pairing: { macName: 'Mac', address: '10.0.0.5' }, onAny: null });
  link.onState = (fn) => link.on('state', fn);
  let changes = 0;
  s.onState(() => changes++);
  s.setLink(link);
  assert.strictEqual(s.transport, 'ip');
  link.transport = 'ble';
  link.emit('transport');
  assert.strictEqual(s.transport, 'ble', 'the session is on Bluetooth');
  assert.ok(changes >= 1, 'the features hear that the transport changed');
  link.transport = 'ip';
  link.emit('transport');
  assert.strictEqual(s.transport, 'ip', 'and back on the network');
  link.authed = false;
  assert.strictEqual(s.transport, 'ip', 'a session that is down reports the network');
});

runTests(tests);
