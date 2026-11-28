// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/screen-viewers.js on three real hubs (#256's test): A has B selected and Monitor 2 showing B; C shares
// its screen. Open for C gives C a Monitor 2 of its own, which gets what C says (screen.state), while the
// first stays with B; Open for B is the first one again. Before, Monitor 2 heard only the selected device.
// Run: node shared/test/screen-viewers.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');
const { Hub } = require('../../linux/mesh/hub.js');
const { LinkManager } = require('../../linux/mesh/links.js');
const { Server } = require('../../linux/mesh/server.js');
const { Pairing } = require('../../linux/mesh/hostpair.js');
const { waitFor, pair, memoryStorage, close } = require('../../linux/mesh/test/lib/mesh.js');
const { loadTestCert } = require('../../linux/mesh/test/lib/testcert.js');
const { screenViewers } = require('../screen-viewers.js');

const T = P.T;

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

// A Monitor 2 as far as this test goes: what reaches it on its link, and its window.
class FakeScreen {
  constructor(link) {
    this.link = link;
    this.got = [];
    this.win = null;
    link.on(T.SCREEN_STATE, (m) => this.got.push(m.t));
  }
  open() { this.win = { isDestroyed: () => false, isVisible: () => true }; }
}

(async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  const TRI = [['A', 'B'], ['A', 'C'], ['B', 'C']];
  const linked = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  try {
    for (const [x, y] of TRI) await pair(N[x], N[y]);
    await waitFor(() => TRI.every(([x, y]) => linked(N[x], N[y]) && linked(N[y], N[x])), 'triangle linked');
    A.hub.select(B.id);
    let first = null;
    const firstLink = A.hub.sticky(() => !!(first && first.win), { remember: ['screen.state'] });
    first = new FakeScreen(firstLink);
    const made = [];
    const viewers = screenViewers({ hub: A.hub, primary: () => first, primaryLink: firstLink, make: (l, id) => { const s = new FakeScreen(l); made.push(id); return s; } });

    viewers.open(B.id); // Monitor 2, B selected
    assert.strictEqual(firstLink.id, B.id);
    assert.ok(first.win);
    assert.strictEqual(viewers.of(C.id), null, 'nothing for C yet');

    // C shares while B is shown: Open for C gives it a Monitor 2 of its own.
    viewers.open(C.id);
    assert.deepStrictEqual(made, [C.id]);
    const forC = viewers.of(C.id);
    assert.ok(forC && forC !== first);
    // What reaches a link doesn't depend on its type (rtc.* are renamed by the session's role swap on the way).
    C.hub.bus.send(A.id, { t: T.SCREEN_STATE, on: true, mode: 'extend' });
    await waitFor(() => forC.got.length === 1, 'C’s Monitor 2 gets C’s state');
    assert.deepStrictEqual(forC.got, [T.SCREEN_STATE]);
    assert.deepStrictEqual(first.got, [], 'the first one, on B, doesn’t');
    assert.strictEqual(firstLink.id, B.id, 'and stays with B');

    // B's own still goes to the first; Open for B is the first one.
    B.hub.bus.send(A.id, { t: T.SCREEN_STATE, on: true, mode: 'mirror' });
    await waitFor(() => first.got.length === 1, 'B to the first');
    assert.strictEqual(viewers.of(B.id), first);
    viewers.open(B.id);
    assert.deepStrictEqual(made, [C.id], 'no second window for B');
    // The first one closed: Open for C now takes the first one (free), as before.
    first.win = null;
    viewers.open(C.id);
    assert.strictEqual(firstLink.id, C.id, 'free: the first one goes to C');
    console.log('screen-viewers: ok');
  } finally {
    close(A, B, C);
  }
})().catch((e) => { console.error(e); process.exit(1); });
