// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BleHost } = require('../blepipe.js');
const P = require('../protocol.js');

const platforms = ['mac', 'windows', 'linux'];
// As in fx2-welcome.js, use ws from whichever desktop has its dependencies installed.
process.env.NODE_PATH = [process.env.NODE_PATH, ...platforms.map((p) => path.join(__dirname, '../..', p, 'node_modules'))].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

const ip = (address, internal = false) => ({ family: 'IPv4', internal, address });
const welcome = { t: P.T.WELCOME, v: P.PROTOCOL_VERSION };
const who = { deviceId: 'phone', os: P.OS.ANDROID, name: 'Phone' };

function fixture(mode) {
  const { Server } = require(`../../${mode}/server.js`);
  const server = Object.create(Server.prototype);
  EventEmitter.call(server);
  Object.assign(server, { port: 47920, sockets: new Set(), _now: Date.now, authSeq: 0 });
  if (mode.endsWith('/mesh')) server.clients = new Map();
  else server.current = null;
  new BleHost({ server, helper: new EventEmitter(), info: () => ({ port: server.port }) });
  return server;
}

function socket(server, transport = 'ble') {
  const messages = [];
  const address = transport === 'ble' ? '127.0.0.1' : '192.168.1.21';
  const ws = { transport, address, OPEN: 1, readyState: 1,
    send: (raw) => messages.push(JSON.parse(raw)), close() { this.readyState = 3; } };
  const ctx = { ws, transport, address, authed: false, alt: null, connectedAt: Date.now() };
  ws.ctx = ctx;
  server.sockets.add(ctx);
  return { ctx, ws, messages, offers: () => messages.filter((m) => m.t === P.T.NET_LAN) };
}

function receive(server, ws, m) {
  server._onMessage(ws.ctx, Buffer.from(JSON.stringify(m)), false, ws);
}

const modes = platforms.flatMap((p) => [p, `${p}/mesh`]);

test('offers up to four LAN addresses after BLE welcome and refreshes only on change', (t) => {
  let now = 1_000_000;
  let interfaces;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(os, 'networkInterfaces', () => interfaces);
  for (const mode of modes) {
    interfaces = { eth: [ip('10.2.1.9'), ip('10.2.1.9'), ip('172.31.4.5'), ip('192.168.2.3'),
      ip('169.254.12.5'), ip('169.254.13.5')] };
    const server = fixture(mode);
    if (server.clients) {
      const primary = socket(server, 'ip');
      server.authenticate(primary.ctx, { deviceId: 'pc', os: P.OS.WIN, name: 'PC' }, welcome);
      server.setPrimary('pc');
    }
    const ble = socket(server);
    server.authenticate(ble.ctx, who, welcome);
    assert.deepEqual(ble.messages.map((m) => m.t), [P.T.WELCOME, P.T.NET_LAN], mode);
    assert.deepEqual(ble.offers(), [{ t: P.T.NET_LAN, addresses: ['10.2.1.9', '172.31.4.5', '192.168.2.3', '169.254.12.5'], port: server.port }], mode);

    const pong = () => receive(server, ble.ws, { t: P.T.PONG, ts: now });
    now += 5000;
    pong();
    assert.equal(ble.offers().length, 1, mode);
    interfaces = { eth: [ip('10.2.1.10')] };
    now += 4999;
    pong();
    assert.equal(ble.offers().length, 1, mode);
    now++;
    pong();
    assert.deepEqual(ble.offers().at(-1).addresses, ['10.2.1.10'], mode);
    interfaces = {};
    now += 5000;
    pong();
    assert.deepEqual(ble.offers().at(-1).addresses, [], mode);
  }
});

test('withholds invalid addresses and offers outside the current authenticated BLE socket', (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(os, 'networkInterfaces', () => ({ eth: [ip('127.1.2.3'), ip('0.0.0.0'), ip('224.1.2.3'),
    ip('255.255.255.255'), ip('10.1.2.256'), ip('10.001.2.3'), ip('8.8.8.8'), ip('100.64.1.1'), ip('172.32.1.1'),
    ip('169.254.0.4'), ip('169.254.255.4'), ip('192.168.2.1', true), { family: 'IPv6', address: 'fd00::1' }, ip('10.1.2.3')] }));
  for (const mode of modes) {
    const server = fixture(mode);
    const ble = socket(server);
    server.emit('client', ble.ctx);
    assert.deepEqual(ble.messages, [], mode);
    server.authenticate(ble.ctx, who, welcome);
    assert.deepEqual(ble.offers().at(-1).addresses, ['10.1.2.3'], mode);

    const lan = socket(server, 'ip');
    receive(server, lan.ws, { t: P.T.HELLO, id: who.deviceId, resume: ble.ctx.resumeKey });
    assert.equal(lan.messages[0].resumed, true, mode);
    now += 5000;
    receive(server, lan.ws, { t: P.T.PONG, ts: now });
    receive(server, ble.ws, { t: P.T.PONG, ts: now });
    assert.equal(ble.offers().length, 1, mode);
    assert.equal(lan.offers().length, 0, mode);

    lan.ws.close();
    server._onSocketClose(lan.ws);
    receive(server, ble.ws, { t: P.T.PONG, ts: now });
    assert.equal(ble.offers().length, 2, mode);
    const ask = { t: P.T.NET_LAN, ask: true };
    receive(server, ble.ws, ask);
    assert.equal(ble.offers().length, 2, mode);
    now += 5000;
    receive(server, lan.ws, ask);
    assert.equal(ble.offers().length, 2, mode);
    receive(server, ble.ws, ask);
    assert.equal(ble.offers().length, 3, mode);

    const replacement = socket(server, 'ip');
    server.authenticate(replacement.ctx, who, welcome);
    now += 5000;
    server.emit('rtt', ble.ctx);
    receive(server, replacement.ws, { t: P.T.PONG, ts: now });
    assert.equal(ble.offers().length, 3, mode);
    assert.equal(replacement.offers().length, 0, mode);
  }
});
