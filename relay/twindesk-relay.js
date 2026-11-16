#!/usr/bin/env node
// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Relay: run it on a machine your computer and your phone can both reach (a small cloud
// server, a home server with a forwarded port), then add its address in TwinDesk on the computer
// (General › Your own relay). A phone away from the computer's network then connects through it.
//
// It pairs connections and copies bytes, nothing more. What goes through is TwinDesk's own TLS
// session (the computer's pinned certificate and the pairing's token), so this relay can't read
// it, change it or tell which devices they are; it never writes anything to disk.
//
//   node twindesk-relay.js [--port 47100] [--key <secret>] [--host 0.0.0.0]
//   (or RELAY_PORT, RELAY_KEY, RELAY_HOST in the environment)
// --key: only devices given the same key may use it (set it in TwinDesk with the address).
// Node 16 or later; no packages. Wire: shared/relay.js.
'use strict';

const net = require('net');
const crypto = require('crypto');

const arg = (name, env, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : process.env[env] || d;
};
const PORT = Number(arg('port', 'RELAY_PORT', 47100));
const HOST = arg('host', 'RELAY_HOST', '0.0.0.0');
const KEY = String(arg('key', 'RELAY_KEY', '')).slice(0, 128);
const MAX_HOSTS = 1000, MAX_WAITING = 64, JOIN_MS = 15000, IDLE_MS = 180000, MAX_CONNS = 4000;

const hosts = new Map(); // id → control socket
const waiting = new Map(); // id → Map(n → joiner socket)
let conns = 0;
let seq = 0;

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const keyOk = (k) => !KEY || same(k, KEY);
const ID = /^[0-9a-f]{32}$/;

function line(sock, cb) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => sock.destroy(), 10000);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(10);
    if (i < 0) { if (buf.length > 512) sock.destroy(); return; }
    clearTimeout(timer);
    sock.removeListener('data', onData);
    cb(buf.slice(0, i).toString('utf8').trim(), buf.slice(i + 1));
  };
  sock.on('data', onData);
}

function host(sock, id) {
  const was = hosts.get(id);
  if (was && was !== sock) was.destroy(); // the computer reconnected
  if (!hosts.has(id) && hosts.size >= MAX_HOSTS) return sock.end('full\n');
  hosts.set(id, sock);
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  sock.write('ok\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    if (buf.length > 4096) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      if (buf.slice(0, i).trim() === 'ping') sock.write('pong\n');
      buf = buf.slice(i + 1);
    }
  });
  sock.on('close', () => { if (hosts.get(id) === sock) hosts.delete(id); });
}

function join(sock, id, rest) {
  const ctl = hosts.get(id);
  if (!ctl) return sock.end('no\n');
  const list = waiting.get(id) || new Map();
  if (list.size >= MAX_WAITING) return sock.end('busy\n');
  const n = String(++seq % 1e9);
  sock.pause();
  if (rest.length) sock.unshift(rest);
  list.set(n, sock);
  waiting.set(id, list);
  const drop = () => { list.delete(n); if (!list.size) waiting.delete(id); };
  const timer = setTimeout(() => { drop(); sock.end('no\n'); }, JOIN_MS);
  sock.once('close', () => { clearTimeout(timer); drop(); });
  sock._relayTimer = timer;
  ctl.write(`call ${n}\n`);
}

function take(sock, id, n, rest) {
  const list = waiting.get(id);
  const other = list && list.get(n);
  if (!other) return sock.end('no\n');
  list.delete(n);
  if (!list.size) waiting.delete(id);
  clearTimeout(other._relayTimer);
  sock.write('ok\n');
  other.write('ok\n');
  if (rest.length) other.write(rest);
  sock.pipe(other);
  other.pipe(sock);
  other.resume();
  const end = () => { sock.destroy(); other.destroy(); };
  sock.on('close', end);
  other.on('close', end);
  sock.setTimeout(0);
  other.setTimeout(0);
}

const server = net.createServer((sock) => {
  if (conns >= MAX_CONNS) return sock.destroy();
  conns++;
  sock.on('close', () => { conns--; });
  sock.on('error', () => sock.destroy());
  sock.setNoDelay(true);
  sock.setTimeout(20000, () => sock.destroy());
  line(sock, (l, rest) => {
    const p = l.split(' ');
    if (p[0] !== 'TDR1' || !ID.test(p[2] || '')) return sock.destroy();
    if (!keyOk(p[p[1] === 'take' ? 4 : 3] === '-' ? '' : p[p[1] === 'take' ? 4 : 3] || '')) return sock.end('key\n');
    if (p[1] === 'host') return host(sock, p[2]);
    if (p[1] === 'join') return join(sock, p[2], rest);
    if (p[1] === 'take' && /^\d{1,9}$/.test(p[3] || '')) return take(sock, p[2], p[3], rest);
    sock.destroy();
  });
});
server.on('error', (e) => { console.error(`TwinDesk Relay: ${e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => console.log(`TwinDesk Relay on ${HOST}:${PORT}${KEY ? ' (with a key)' : ''}`));
