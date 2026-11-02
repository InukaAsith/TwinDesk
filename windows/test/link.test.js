'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const https = require('node:https');
const net = require('node:net');
const { WebSocketServer } = require('ws');
const { loadTestCert } = require('../mesh/test/lib/testcert.js');
const Link = require('../link.js');
const Peer = require('../peer.js');
const P = require('../../shared/protocol.js');

function fixture(t, seen = { address: '127.0.0.1', port: 47800 }) {
  const saved = [];
  const pairing = { macId: 'peer', macName: 'Mac', address: 'ble:peer', port: 47800, os: P.OS.MAC, fp: 'aa', token: 'test-token' };
  const link = new Link({ device: { id: 'self', name: 'PC' }, store: { load: () => pairing, save: (p) => saved.push({ ...p }), clear() {} }, resolveAddress: () => seen });
  t.after(() => { link.stopped = { why: 'test' }; clearTimeout(link.timers.reconnect); link._closeSocket(); });
  return { link, saved };
}

test('a discovered network is preferred over a saved Bluetooth address', (t) => {
  const { link } = fixture(t);
  let target;
  link._open = (...args) => { target = args; };
  link.ble = { get: () => ({}) , open: async () => { throw new Error('should not open Bluetooth'); } };
  link.start();
  assert.deepEqual(target, ['127.0.0.1', 47800, 'ip']);
});
test('a failed pairing attempt does not block reconnecting the saved peer', async t => {
  const { link } = fixture(t); let mode;
  link.pairState = { phase: 'failed' }; link._connect = m => { mode = m; };
  link._resume(); await waitFor(() => mode === 'session');
});
test('Connect again can recover from a failed pairing attempt', t => {
  const { link } = fixture(t); let mode;
  link.pairState = { phase: 'failed' }; link._connect = m => { mode = m; };
  link.connect(); assert.equal(mode, 'session');
});

test('fallback pongs cannot replace the active connection latency', (t) => {
  const { link } = fixture(t);
  link.ws = { close() {}, readyState: 1 };
  link.status.rtt = 20;
  link._onMessage(JSON.stringify({ t: P.T.PONG, ts: Date.now() - 300000 }), {});
  assert.equal(link.status.rtt, 20);
});

test('a resumed network connection updates its saved endpoint and clears old latency', (t) => {
  const { link, saved } = fixture(t);
  link.ws = { readyState: 1, close() {}, terminate() {} };
  link.pending = { address: '192.168.49.2', port: 47800, transport: 'ip', readyState: 1, close() {}, terminate() {} };
  link.status.rtt = 300000;
  link._onPending(JSON.stringify({ t: P.T.WELCOME, resumed: true }));
  assert.equal(link.pairing.address, '192.168.49.2');
  assert.equal(saved.at(-1).address, '192.168.49.2');
  assert.equal(link.status.rtt, null);
});

test('the peer reports the active network address after a transport change', (t) => {
  const { link } = fixture(t);
  const peer = new Peer(link);
  t.after(() => peer.fx.reset());
  link.authed = true;
  link.transport = 'ip';
  link.ws = { address: '192.168.49.2', readyState: 1, close() {} };
  assert.equal(peer.current.address, '192.168.49.2');
});

const waitFor = async (condition) => {
  const until = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('connection timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('real TLS connection, pinned resume, and fallback preserve the session', async (t) => {
  const cert = loadTestCert();
  const server = https.createServer(cert);
  const wss = new WebSocketServer({ server });
  const hellos = [];
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t !== P.T.HELLO) return;
    hellos.push(m);
    ws.send(JSON.stringify({ t: P.T.WELCOME, v: P.PROTOCOL_VERSION, macId: 'peer', macName: 'Mac', os: P.OS.MAC, ...(m.resume ? { resumed: true } : { resume: 'resume-secret' }) }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  const seen = { address: '127.0.0.1', port: server.address().port };
  const { link } = fixture(t, seen);
  link.pairing.fp = cert.fp;
  link.start();
  await waitFor(() => link.authed);
  assert.equal(hellos[0].token, 'test-token');
  const original = link.ws;
  link.pairing.address = 'ble:peer';
  link.transport = original.transport = 'ble';
  link._tryResume();
  await waitFor(() => link.transport === 'ip');
  assert.equal(hellos.at(-1).resume, 'resume-secret');
  assert.equal(link.pairing.address, seen.address);
  assert.equal(link.alt, original);
  link.ws.terminate();
  await waitFor(() => link.ws === original);
  assert.equal(link.authed, true);
  assert.equal(link.transport, 'ble');
});

test('a discovered address still has to pass certificate pinning', async (t) => {
  const cert = loadTestCert();
  const server = https.createServer(cert);
  const wss = new WebSocketServer({ server });
  let messages = 0;
  wss.on('connection', (ws) => ws.on('message', () => messages++));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  const { link } = fixture(t, { address: '127.0.0.1', port: server.address().port });
  link.start();
  await waitFor(() => link.status.state === 'identity_changed');
  assert.equal(messages, 0);
});
test('a failing advertised network falls back to Bluetooth and can later resume on IP', async (t) => {
  const cert = loadTestCert(), server = https.createServer(cert), wss = new WebSocketServer({ server });
  const failing = net.createServer(socket => socket.destroy());
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.t === P.T.HELLO) ws.send(JSON.stringify({ t: P.T.WELCOME, v: P.PROTOCOL_VERSION, macId: 'peer', macName: 'Mac', os: P.OS.MAC, ...(m.resume ? { resumed: true } : { resume: 'resume-secret' }) }));
  }));
  await Promise.all([new Promise(r => server.listen(0, '127.0.0.1', r)), new Promise(r => failing.listen(0, '127.0.0.1', r))]);
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); failing.close(); });
  const seen = { address: '127.0.0.1', port: failing.address().port }, { link } = fixture(t, seen);
  link.pairing.fp = cert.fp;
  let pipes = 0;
  link.ble = { get: () => ({}), open: async () => { pipes++; return server.address().port; } };
  link.start(); await waitFor(() => link.authed);
  assert.equal(link.transport, 'ble'); assert.equal(pipes, 1);
  seen.port = server.address().port; link.networkRetryAt = 0;
  link._tryResume(); await waitFor(() => link.transport === 'ip');
  assert.equal(link.authed, true); assert.ok(link.alt);
});
