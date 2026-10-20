// Helpers for the Mac integration tests: real Server + Pairing + LinkManager + Hub nodes on loopback,
// the real pairing protocol, and a raw client that talks like the Android app.
// The Windows helpers are reused where they are the same (run.js); the node is the Mac's own.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const P = require('../../../shared/protocol.js');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../../server.js');
const { Pairing } = require('../../pairing.js');
const { LinkManager } = require('../../links.js');
const { Hub } = require('../../hub.js');

const HOST = '127.0.0.1';

let cert = null;
// A throwaway self-signed certificate (PEM), made once per test process in a temp folder that is
// removed when the process exits. No key material is kept in the repository.
function loadTestCert() {
  if (cert) return cert;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-mac-test-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=Test'], { env, stdio: 'ignore' });
  const certPem = fs.readFileSync(crt, 'utf8');
  const fp = P.normFingerprint(new crypto.X509Certificate(certPem).fingerprint256);
  cert = { keyPem: fs.readFileSync(key, 'utf8'), certPem, fp };
  return cert;
}

// Files in memory, as JSON (a copy each time, like the disk).
function memoryStorage() {
  const files = new Map();
  return {
    read(name, fallback) {
      return files.has(name) ? JSON.parse(files.get(name)) : fallback;
    },
    write(name, obj) {
      files.set(name, JSON.stringify(obj));
    },
    remove(name) {
      files.delete(name);
    },
    files,
  };
}

// A node: a Mac on a free port with its server, pairing (host side), links (guest side), mesh and hub.
// opts: deviceId, now (fake clock for the server), tick (false: no liveness timer), inboundWaitMs.
async function node(name, { deviceId, now, tick, inboundWaitMs, storage } = {}) {
  const c = loadTestCert();
  const id = deviceId || crypto.randomUUID();
  const server = new Server({ keyPem: c.keyPem, certPem: c.certPem, port: 0, now, tick });
  await new Promise((resolve) => server.once('listening', resolve));
  const store = storage || memoryStorage();
  const identity = { macId: id, macName: name, fp: c.fp };
  const pairing = new Pairing(server, identity, { storage: store });
  const device = { id, name };
  const links = new LinkManager({ device, storage: store, hostPairing: pairing, inboundWaitMs });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device, links, mesh, server, pairing });
  const n = { name, id, fp: c.fp, server, pairing, links, mesh, hub, storage: store, port: server.port, events: [] };
  links.on('closed', (link) => n.events.push(['link-closed', link.pairing && link.pairing.macId]));
  server.on('closed', (ctx) => ctx.authed && n.events.push(['client-closed', ctx.deviceId]));
  return n;
}

function close(...nodes) {
  for (const n of nodes) {
    n.links.close();
    n.server.close();
  }
}

async function waitFor(fn, what = 'condition', ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (e) {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The real pairing protocol: `dialer` pairs with `host` (dialer is the guest, host the host).
// Both show the same 6-digit code; the host allows, the dialer confirms.
async function pair(dialer, host) {
  assert.ok(dialer.links.startPairing({ address: HOST, port: host.port, macName: host.name }), 'startPairing refused');
  await waitFor(() => dialer.links.pairState() && dialer.links.pairState().phase === 'code' && host.pairing.pending && host.pairing.pending.code, 'the pairing codes');
  const shown = dialer.links.pairState().code;
  const asked = host.pairing.pending.code;
  assert.strictEqual(shown, asked, 'the 6-digit codes must be equal');
  assert.match(shown, /^\d{6}$/);
  host.pairing.respond(true);
  dialer.links.confirmCode();
  await waitFor(() => host.pairing.list().some((x) => x.id === dialer.id) && dialer.links.get(host.id) && dialer.links.get(host.id).authed, 'the pairing to finish and connect');
}

// Both directions of a pair are up through their sessions.
function linked(a, b) {
  const sa = a.hub.sessions.get(b.id);
  const sb = b.hub.sessions.get(a.id);
  return !!(sa && sb && sa.connected && sb.connected);
}

// Physical sockets between a and b: each one is dialled by exactly one side (a guest link there).
function socketCount(a, b) {
  const la = a.links.get(b.id);
  const lb = b.links.get(a.id);
  return (la && la.authed ? 1 : 0) + (lb && lb.authed ? 1 : 0);
}

// A raw WebSocket client: keeps every message, answers pings like the apps do.
class RawClient {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      this.inbox.push(m);
      if (m.t === P.T.PING) this.send({ t: P.T.PONG, ts: m.ts });
    });
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async until(pred, ms = 8000) {
    let found = null;
    await waitFor(() => (found = this.inbox.find(pred)), 'a message', ms);
    return found;
  }

  count(t) {
    return this.inbox.filter((m) => m.t === t).length;
  }

  close() {
    this.ws.terminate();
  }
}

function rawConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${HOST}:${port}`, { rejectUnauthorized: false });
    ws.once('open', () => resolve(new RawClient(ws)));
    ws.once('error', reject);
  });
}

// Connect as an already paired device (any os); resolves with the RawClient and the reply.
async function hello(port, { id, name, os = P.OS.WIN, token, mesh = 1 }) {
  const c = await rawConnect(port);
  c.send({ t: P.T.HELLO, v: P.PROTOCOL_VERSION, id, name, os, token, mesh });
  const reply = await c.until((m) => m.t === P.T.WELCOME || m.t === P.T.ERROR);
  return { client: c, reply };
}

// A phone pairs with `host` (a phone dials, whatever the other side is): resolves {client, token, id}.
async function pairPhone(host, { id = crypto.randomUUID(), name = 'Phone' } = {}) {
  const c = await rawConnect(host.port);
  const nw = P.randomHex(16);
  c.send({ t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id, name, os: P.OS.ANDROID, commit: P.commitOf(nw) });
  const nonce = await c.until((m) => m.t === P.T.PAIR_NONCE);
  c.send({ t: P.T.PAIR_REVEAL, nonce: nw });
  const code = P.sasCode(host.fp, nw, nonce.nonce);
  await waitFor(() => host.pairing.pending && host.pairing.pending.code === code, 'the phone code');
  host.pairing.respond(true);
  c.send({ t: P.T.PAIR_CONFIRM });
  const ok = await c.until((m) => m.t === P.T.PAIR_OK);
  return { client: c, token: ok.token, id };
}

async function helloPhone(c, { id, name = 'Phone', token }) {
  c.send({ t: P.T.HELLO, v: P.PROTOCOL_VERSION, id, name, os: P.OS.ANDROID, token, mesh: 1 });
  return c.until((m) => m.t === P.T.WELCOME || m.t === P.T.ERROR);
}

module.exports = {
  HOST, node, close, waitFor, pair, linked, socketCount, memoryStorage, loadTestCert,
  RawClient, rawConnect, hello, pairPhone, helloPhone,
};
