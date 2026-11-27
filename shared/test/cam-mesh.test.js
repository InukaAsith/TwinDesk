// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/cam-mesh.js camLink on a real three-device mesh (Linux hub): the camera's link follows the
// selection, goes to a computer that opens this camera, refuses another while in use, comes back to the
// selection when free, and every computer hears whether the camera is shared.
// Run: node shared/test/cam-mesh.test.js
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
const { camLink } = require('../cam-mesh.js');

const T = P.T;
const linked = (a, b) => {
  const sa = a.hub.sessions.get(b.id);
  const sb = b.hub.sessions.get(a.id);
  return !!(sa && sa.connected && sb && sb.connected);
};

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
    A.hub.select(B.id);

    // What each computer hears from A.
    const heard = { B: [], C: [] };
    for (const k of ['B', 'C']) {
      for (const t of [T.CAM_POLICY, T.CAM_STATE]) N[k].hub.bus.on(t, (m, from) => from === A.id && heard[k].push(m));
    }

    // A's CamShare, faked: what it reads (sender, viewer, share) and what it hears on its link.
    const cam = { sender: null, viewer: null, share: true, opened: [], policies: 0 };
    const logs = [];
    const link = camLink(A.hub, () => cam, (l) => logs.push(l));
    cam.sendPolicy = () => { cam.policies++; link.send({ t: T.CAM_POLICY, share: cam.share }); };
    link.on(T.CAM_OPEN, () => cam.opened.push(link.id));
    link.shareWithAll();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(link.id, B.id, 'it starts with the selection');

    cam.sendPolicy();
    await waitFor(() => heard.B.some((m) => m.t === T.CAM_POLICY) && heard.C.some((m) => m.t === T.CAM_POLICY), 'both hear the policy');

    // C, not selected, opens A's camera: the link goes to C and CamShare hears it.
    C.hub.bus.send(A.id, { t: T.CAM_OPEN });
    await waitFor(() => cam.opened.length === 1, 'the open reached CamShare');
    assert.strictEqual(cam.opened[0], C.id, 'heard on the link, now with C');
    assert.strictEqual(link.id, C.id);
    assert.ok(logs.some((l) => /C opens this camera/.test(l)), logs.join('\n'));

    // In use with C: B's open is refused, and B is told why.
    cam.sender = { status: 'live' };
    B.hub.bus.send(A.id, { t: T.CAM_OPEN });
    await waitFor(() => heard.B.some((m) => m.t === T.CAM_STATE), 'B was told');
    const st = heard.B.find((m) => m.t === T.CAM_STATE);
    assert.strictEqual(st.status, 'failed');
    assert.ok(/in use with C/.test(st.error), st.error);
    assert.strictEqual(link.id, C.id, 'it stayed with C');
    assert.strictEqual(cam.opened.length, 1);

    // A selection change while in use: it stays.
    A.hub.select(C.id);
    A.hub.select(B.id);
    assert.strictEqual(link.id, C.id, 'a crossing doesn’t end the call');

    // Free again: back to the selection.
    cam.sender = null;
    link.settle();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(link.id, B.id, 'back with the selection');

    // The move's 'welcome' re-tells the policy; C, left, still hears it's shared (after the goodbye).
    const before = heard.C.filter((m) => m.t === T.CAM_POLICY).length;
    cam.sendPolicy();
    await waitFor(() => heard.C.filter((m) => m.t === T.CAM_POLICY).length > before, 'C hears it again');
    assert.strictEqual(heard.C.filter((m) => m.t === T.CAM_POLICY).pop().share, true, 'C still sees it shared');

    // A cam.open from the device it's already with goes straight to CamShare.
    B.hub.bus.send(A.id, { t: T.CAM_OPEN });
    await waitFor(() => cam.opened.length === 2, 'B opened');
    assert.strictEqual(cam.opened[1], B.id);
    console.log('passed: the camera link follows the computer using it');
  } finally {
    close(A, B, C);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
