'use strict';
// A computer on two networks at once (a cable and Wi-Fi): discovery keeps both, the address does not
// flicker between them, and the link dials the chosen one first and the other when it can't be reached.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const P = require('../../shared/protocol.js');

// This PC: Ethernet 192.168.50.1/24 and Wi-Fi 192.168.1.10/24.
const NICS = {
  Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.50.1', netmask: '255.255.255.0' }],
  'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.10', netmask: '255.255.255.0' }],
};
os.networkInterfaces = () => NICS;
const { Discovery, orderRoutes } = require('../discovery.js');
const Link = require('../link.js');

const beacon = (id = 'peer') => Buffer.from(JSON.stringify({ t: P.T.BEACON, v: P.PROTOCOL_VERSION, id, name: 'Peer', port: 47800, fp: '', os: P.OS.WIN }));

function discovery() {
  const d = new Discovery({ id: 'self', name: 'PC' });
  let changes = 0;
  d.on('change', () => changes++);
  return { d, changes: () => changes };
}

test('both networks are kept and the address stays on the cable', () => {
  const { d, changes } = discovery();
  d._onMessage(beacon(), { address: '192.168.1.20', port: P.DISCOVERY_PORT });
  d._onMessage(beacon(), { address: '192.168.50.2', port: P.DISCOVERY_PORT });
  const after = changes();
  for (let i = 0; i < 6; i++) d._onMessage(beacon(), { address: i % 2 ? '192.168.1.20' : '192.168.50.2', port: P.DISCOVERY_PORT });
  assert.equal(changes(), after, 'beacons from both networks no longer change the list');
  const dev = d.get('peer');
  assert.equal(dev.address, '192.168.50.2');
  assert.deepEqual(dev.routes.map((r) => [r.address, r.via, r.local]), [['192.168.50.2', 'Ethernet', '192.168.50.1'], ['192.168.1.20', 'Wi-Fi', '192.168.1.10']]);
  assert.deepEqual(d.list()[0].routes.map((r) => r.address), ['192.168.50.2', '192.168.1.20']);
});

test('a network that goes quiet is dropped, the device stays on the other', () => {
  const { d } = discovery();
  d._onMessage(beacon(), { address: '192.168.50.2', port: P.DISCOVERY_PORT });
  d._onMessage(beacon(), { address: '192.168.1.20', port: P.DISCOVERY_PORT });
  d.found.get('peer').routes.get('192.168.50.2').lastSeen -= P.DEVICE_STALE_MS + 1; // the cable came out
  d._prune();
  assert.equal(d.get('peer').address, '192.168.1.20');
  assert.equal(d.get('peer').routes.length, 1);
  d.found.get('peer').routes.get('192.168.1.20').lastSeen -= P.DEVICE_STALE_MS + 1;
  d._prune();
  assert.equal(d.get('peer'), null);
});

test('the chosen route goes first, the others by rank', () => {
  const routes = [{ address: '192.168.1.20', via: 'Wi-Fi' }, { address: '10.0.0.5', via: 'Tailscale' }, { address: '192.168.50.2', via: 'Ethernet' }];
  assert.deepEqual(orderRoutes(routes, '').map((r) => r.address), ['192.168.50.2', '192.168.1.20', '10.0.0.5']);
  assert.deepEqual(orderRoutes(routes, '192.168.1.20').map((r) => r.address), ['192.168.1.20', '192.168.50.2', '10.0.0.5']);
});

function link(t, pairing, seen) {
  const saved = [];
  const l = new Link({ device: { id: 'self', name: 'PC' }, store: { load: () => pairing, save: (p) => saved.push({ ...p }), clear() {} }, resolveAddress: () => seen });
  t.after(() => { l.stopped = { why: 'test' }; clearTimeout(l.timers.reconnect); l._closeSocket(); });
  return { l, saved };
}
const pairing = (route) => ({ macId: 'peer', macName: 'Peer', address: '192.168.1.20', port: 47800, os: P.OS.WIN, fp: 'aa', token: 't', ...(route ? { route } : {}) });
const seenBoth = { address: '192.168.50.2', port: 47800, routes: [{ address: '192.168.50.2', via: 'Ethernet' }, { address: '192.168.1.20', via: 'Wi-Fi' }] };

test('the chosen route is dialled first; unreachable, the other network at once, and it says so', (t) => {
  const { l } = link(t, pairing('192.168.1.20'), seenBoth);
  const dialled = [];
  l._socket = (address, port, transport) => {
    const handlers = {};
    const ws = { address, port, transport, readyState: 0, on: (e, fn) => { handlers[e] = fn; }, terminate() {}, close() {}, handlers };
    dialled.push(ws);
    return ws;
  };
  l.start();
  assert.deepEqual(dialled.map((w) => w.address), ['192.168.1.20']);
  l.lastError = 'ETIMEDOUT';
  dialled[0].handlers.close();
  assert.deepEqual(dialled.map((w) => w.address), ['192.168.1.20', '192.168.50.2'], 'the other network, without the reconnect delay');
  const p = l.snapshot().paired;
  assert.equal(p.route, '192.168.1.20');
  assert.equal(p.routeMissed, '192.168.1.20', 'the chosen route is shown as not reached');
});

test('automatic dials the best network first', (t) => {
  const { l } = link(t, pairing(''), seenBoth);
  let first;
  l._open = (address) => { first = first || address; };
  l.start();
  assert.equal(first, '192.168.50.2');
});

test('picking a route saves it; automatic clears it', (t) => {
  const { l, saved } = link(t, pairing(''), seenBoth);
  l.stopped = { why: 'test' }; // no dialling here
  l.setRoute('192.168.1.20');
  assert.equal(saved.at(-1).route, '192.168.1.20');
  l.setRoute('');
  assert.equal('route' in saved.at(-1), false);
  l.setRoute('not an address');
  assert.equal(saved.length, 2, 'only IPv4 addresses are kept');
});

test('a session on another network moves back to the chosen route once it is seen', (t) => {
  const { l } = link(t, pairing('192.168.1.20'), seenBoth);
  l.authed = true;
  l.transport = 'ip';
  l.resumeKey = 'k';
  l.ws = { address: '192.168.50.2', transport: 'ip', readyState: 1, close() {}, terminate() { this.gone = true; } };
  let dialled;
  l._socket = (address) => { dialled = address; return { address, transport: 'ip', port: 47800, readyState: 0, on() {}, terminate() {}, send() {} }; };
  l._tryResume();
  assert.equal(dialled, '192.168.1.20');
  const old = l.ws;
  l._onPending(JSON.stringify({ t: P.T.WELCOME, resumed: true }));
  assert.equal(l.ws.address, '192.168.1.20');
  assert.equal(old.gone, true, 'one network at a time: the other socket closes');
  assert.equal(l.alt, null);
});
