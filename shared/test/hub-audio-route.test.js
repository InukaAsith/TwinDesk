// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// hub.audioRoute + setAudioSticky: three-device selection must not close an active sound target.
// Run: node shared/test/hub-audio-route.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { Mesh } = require('../mesh.js');
const { Hub } = require('../../linux/mesh/hub.js');
const { LinkManager } = require('../../linux/mesh/links.js');
const { Server } = require('../../linux/mesh/server.js');
const { Pairing } = require('../../linux/mesh/hostpair.js');
const { waitFor, pair, memoryStorage, close } = require('../../linux/mesh/test/lib/mesh.js');

const linked = (a, b) => {
  const sa = a.hub.sessions.get(b.id);
  const sb = b.hub.sessions.get(a.id);
  return !!(sa && sa.connected && sb && sb.connected);
};
const { loadTestCert } = require('../../linux/mesh/test/lib/testcert.js');

async function node(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  hub.start();
  return { name, id, port: server.port, server, links, pairing, hub };
}

async function main() {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
  try {
    for (const [x, y] of TRIANGLE) await pair(N[x], N[y]);
    await waitFor(() => TRIANGLE.every(([x, y]) => linked(N[x], N[y])), 'triangle linked');

    const route = A.hub.audioRoute();
    const closed = [];
    route.on('closed', () => closed.push(1));
    A.hub.select(B.id);
    route.refresh();
    A.hub.setAudioSticky('sound', B.id);
    route.refresh();
    assert.strictEqual(route.targetId, B.id);
    A.hub.select(C.id);
    route.refresh();
    assert.strictEqual(route.targetId, B.id);
    assert.strictEqual(closed.length, 0);
    A.hub.setAudioSticky('sound', null);
    route.refresh();
    assert.strictEqual(route.targetId, C.id);
    assert.strictEqual(closed.length, 1);
    console.log('passed: audio route sticky across three devices');
  } finally {
    close(A, B, C);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
