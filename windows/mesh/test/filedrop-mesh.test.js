// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sending in Multi-device (shared/filedrop-mesh.js) on real hubs and sockets: A sends B files, and the
// pointer crosses to C mid-send (C selected). Before, the facade's 'closed' aborted the send ("B
// disconnected") and kept the rest as cut off; now B's own FileDrop goes on and every file arrives.
// Run with: node windows/mesh/test/filedrop-mesh.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const P = require('../../../shared/protocol.js');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const { FilesSet } = require('../../../shared/files-mesh.js');
const { FileDropSet } = require('../../../shared/filedrop-mesh.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-mesh-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => dir }, powerSaveBlocker: { start: () => 1, stop() {} } };
  if (id === 'child_process') return { spawn: () => ({ unref() {}, on() {} }) }; // no Explorer opening the folder
  return load.call(this, id, ...args);
};
const FileRecv = require('../../filerecv.js');
const FileDrop = require('../../filedrop.js');
Module._load = load;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  return { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub };
}

const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
// What a device hears from another on its bus.
const heard = (n, from, types) => {
  const got = [];
  for (const t of types) n.hub.bus.on(t, (m, id) => id === from.id && got.push(m));
  return got;
};

test('a send goes on when the pointer crosses to another device mid-send', async () => {
  const A = await hubNode('A');
  const B = await hubNode('B');
  const C = await hubNode('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => up(A, B) && up(B, A) && up(A, C) && up(C, A), 'B and C linked to A');
    const into = path.join(dir, 'received');
    fs.mkdirSync(into);
    const settings = { files: { acceptFromMac: true, receivedFolder: into, outboxHours: 24 } };
    const atB = [];
    new FilesSet({
      hub: B.hub,
      make: (link) => ({ fileRecv: Object.assign(new FileRecv({ link, helper: {}, settings, onChange() {} }), {}), dragRecv: { onRelease() {}, onHome() {}, dragging: false, view: () => ({ state: '' }) } }),
    }).fileRecv.onBatch = (b) => atB.push(b);
    const drops = new FileDropSet({ hub: A.hub, FileDrop, settings, make: (link, id, outbox) => new FileDrop({ link, settings, outbox, onProgress() {} }) });
    const progress = [];
    drops.onBatchProgress = (b) => progress.push(b.to);

    const src = path.join(dir, 'photos');
    fs.mkdirSync(src);
    const data = [];
    for (let i = 0; i < 6; i++) { data.push(crypto.randomBytes(300000)); fs.writeFileSync(path.join(src, `p${i}.bin`), data[i]); }
    assert.ok(A.hub.select(B.id));
    const sent = drops.sendBatch([src], 'send');
    assert.ok(sent && sent.files === 6, 'six files on their way to B');
    assert.ok(A.hub.select(C.id), 'the pointer crosses to C: C selected');
    await waitFor(() => atB.length === 1, 'B has the batch', 20000);
    assert.strictEqual(atB[0].files, 6, 'every file arrived');
    for (let i = 0; i < 6; i++) assert.ok(fs.readFileSync(path.join(into, 'photos', `p${i}.bin`)).equals(data[i]));
    assert.deepStrictEqual(drops.outbox.view, [], 'nothing kept as cut off');
    await waitFor(() => drops.last && drops.last.ok, 'the result: sent (B’s files.done, just after its batch)');
    assert.ok(progress.every((to) => to === B.id), 'its progress says it goes to B');
    // Send files now goes to the selected device, C, through C's own FileDrop.
    assert.strictEqual(drops.selected, drops.byId.get(C.id));
  } finally {
    close(A, B, C);
  }
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true })); // runTests exits the process: no .finally after it
runTests(tests);
