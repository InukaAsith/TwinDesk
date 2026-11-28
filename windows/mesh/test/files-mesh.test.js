// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files from a device that isn't selected (shared/files-mesh.js) on real hubs and sockets: A has C
// selected; B (the computer driving A, say) sends A a file. Before, A's FileRecv heard only C and
// B's file was dropped; now B's own receiver takes it and its answers go back to B, not to C.
// Run with: node windows/mesh/test/files-mesh.test.js
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
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-mesh-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => dir } };
  if (id === 'child_process') return { spawn: () => ({ unref() {}, on() {} }) }; // no Explorer opening the folder
  return load.call(this, id, ...args);
};
const FileRecv = require('../../filerecv.js');
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

test('a file from a device that is not selected arrives, and the answers go to it', async () => {
  const A = await hubNode('A');
  const B = await hubNode('B');
  const C = await hubNode('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => up(A, B) && up(B, A) && up(A, C) && up(C, A), 'B and C linked to A');
    const into = path.join(dir, 'received');
    fs.mkdirSync(into);
    const settings = { files: { acceptFromMac: true, receivedFolder: into } };
    const batches = [];
    const files = new FilesSet({
      hub: A.hub,
      make: (link) => ({ fileRecv: new FileRecv({ link, helper: {}, settings, onChange() {} }), dragRecv: { onRelease() {}, onHome() {}, dragging: false, view: () => ({ state: '' }) } }),
    });
    files.fileRecv.onBatch = (b) => batches.push(b);
    assert.ok(A.hub.select(C.id));
    assert.strictEqual(A.hub.selectedId, C.id, 'A has C selected');

    const atB = heard(B, A, [T.FILE_ACCEPT, T.FILE_DONE, T.FILES_DONE, T.FILE_REFUSE]);
    const atC = heard(C, A, [T.FILE_ACCEPT, T.FILE_DONE, T.FILES_DONE, T.FILE_REFUSE]);
    const data = crypto.randomBytes(5000);
    const toA = B.hub.sessions.get(A.id);
    toA.send({ t: T.FILE_OFFER, id: 'f1', name: 'note.bin', rel: 'note.bin', size: data.length, drop: 'send', batch: 'b1', count: 1, bytes: data.length });
    await waitFor(() => atB.some((m) => m.t === T.FILE_ACCEPT), 'B hears A take it');
    toA.send({ t: T.FILE_CHUNK, id: 'f1', seq: 0, data: data.toString('base64') });
    toA.send({ t: T.FILE_END, id: 'f1', sha256: crypto.createHash('sha256').update(data).digest('hex') });
    await waitFor(() => atB.some((m) => m.t === T.FILES_DONE), 'B hears the batch done');
    assert.deepStrictEqual(atB.find((m) => m.t === T.FILES_DONE).files, 1);
    assert.ok(fs.readFileSync(path.join(into, 'note.bin')).equals(data), 'the same bytes, in the received folder');
    assert.deepStrictEqual(atC, [], 'nothing went to the selected device');
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].from, B.id, 'the batch says it came from B');
    assert.strictEqual(files.byId.size, 2, 'a receiver for B and one for C');
  } finally {
    close(A, B, C);
  }
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true })); // runTests exits the process: no .finally after it
runTests(tests);
