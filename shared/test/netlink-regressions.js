'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NetLink } = require('../netlink.js');
const P = require('../protocol.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(t, overrides = {}) {
  const sent = [];
  let current = { deviceId: 'peer', transport: 'ble', os: P.OS.MAC, role: 'guest' };
  const net = new NetLink({
    os: P.OS.WIN, current: () => current, send: (m) => sent.push(m),
    host: { can: () => true, start: async () => {}, stop: async () => {} },
    join: { can: () => true, start: async () => {}, stop: async () => {} },
    ...overrides,
  });
  net.peerCaps = { host: true, join: true };
  t.after(() => net.ended());
  return { net, sent, disconnect: () => { current = null; } };
}

test('a network request without a session fails', async (t) => {
  const f = fixture(t);
  f.disconnect();
  assert.equal(await f.net.need('screen'), false);
});

test('simultaneous features start one host and advertise only when ready', async (t) => {
  const start = deferred();
  let starts = 0;
  const { net, sent } = fixture(t, { host: { can: () => true, start: () => { starts++; return start.promise; }, stop: async () => {} } });
  net.need('screen');
  net.need('files');
  net.onMessage({ t: P.T.NET_NEED, why: 'camera' });
  assert.equal(starts, 1);
  assert.equal(sent.filter((m) => m.t === P.T.NET_JOIN).length, 0);
  start.resolve();
  await turn();
  assert.equal(sent.filter((m) => m.t === P.T.NET_JOIN).length, 1);
});

test('disconnect settles requests and discards held file offers', async (t) => {
  const f = fixture(t);
  const raw = [];
  f.net.holdOut({ t: P.T.FILE_OFFER, id: 'old-file' }, (m) => raw.push(m));
  const waiting = f.net.need('screen');
  f.disconnect();
  f.net.ended();
  assert.equal(raw.length, 0);
  assert.equal(f.net.waiters.length, 0);
  assert.equal(await waiting, false);
});

test('a late hosting error cannot revive a cancelled request', async (t) => {
  const start = deferred();
  const { net } = fixture(t, { host: { can: () => true, start: () => start.promise, stop: async () => {} } });
  const waiting = net.need('screen');
  net.cancel();
  assert.equal(await waiting, false);
  start.reject(new Error('old host failed'));
  await turn();
  assert.equal(net.state, 'idle');
  assert.equal(net.noHost, false);
});

test('a late join cannot restore a disconnected session', async (t) => {
  const start = deferred();
  const f = fixture(t, { join: { can: () => true, start: () => start.promise, stop: async () => {} } });
  const joining = f.net._join('network', 'password');
  f.disconnect();
  f.net.ended();
  start.resolve();
  assert.equal(await joining, false);
  assert.equal(f.net.state, 'idle');
  assert.equal(f.sent.some((m) => m.t === P.T.NET_JOINED), false);
});

test('repeated credentials do not restart an in-progress join', async (t) => {
  const start = deferred();
  let joins = 0;
  const { net } = fixture(t, { join: { can: () => true, start: () => { joins++; return start.promise; }, stop: async () => {} } });
  net.onMessage({ t: P.T.NET_JOIN, ssid: 'network', pass: 'password' });
  net.onMessage({ t: P.T.NET_JOIN, ssid: 'network', pass: 'password' });
  assert.equal(joins, 1);
  net.ended();
  start.resolve();
  await turn();
});

test('a host requested only by the peer still times out', async (t) => {
  const { net } = fixture(t);
  net.onMessage({ t: P.T.NET_NEED, why: 'screen' });
  await turn();
  net._deadline(5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(net.state, 'failed');
});

test('joining a phone hotspot keeps its hotspot switched on', async (t) => {
  const { net, sent } = fixture(t);
  net.state = 'hotspot';
  assert.equal(await net.joinHotspot('phone', 'password'), true);
  assert.equal(net.state, 'joined');
  assert.equal(sent.some((m) => m.t === P.T.NET_HOTSPOT && !m.on), false);
});

test('the session moving to IP completes all waiting features', async (t) => {
  const { net } = fixture(t);
  const screen = net.need('screen');
  const files = net.need('files');
  net.o.current = () => ({ deviceId: 'peer', transport: 'ip', address: '192.168.137.2' });
  net._tick();
  assert.equal(await screen, true);
  assert.equal(await files, true);
  assert.equal(net.waiters.length, 0);
});

test('an old session callback cannot flush a new session queue', async (t) => {
  const f = fixture(t);
  const raw = [];
  f.net.holdOut({ t: P.T.FILE_OFFER, id: 'old' }, (m) => raw.push(m));
  f.net.ended();
  f.net.started();
  f.net.peerCaps = { host: true, join: true };
  f.net.holdOut({ t: P.T.FILE_OFFER, id: 'new' }, (m) => raw.push(m));
  await turn();
  assert.equal(raw.length, 0);
  assert.equal(f.net.held.length, 1);
  f.net.cancel();
  assert.deepEqual(raw.map((m) => m.id), ['new']);
});
