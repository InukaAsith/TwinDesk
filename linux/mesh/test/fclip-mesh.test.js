// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files with the shortcuts in Multi-device (shared/fclip-mesh.js) on real hubs and
// sockets: B copies a file; A, with C selected, pastes it: A asks B (not C), B sends it to A through
// its sender for A, and A's receivers for B take it into the folder in front.
// Run with: node linux/mesh/test/fclip-mesh.test.js
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
const { meshFileClip } = require('../../../shared/fclip-mesh.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-mesh-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => dir }, clipboard: { readText: () => '' }, globalShortcut: { register: () => true, unregister() {} }, powerSaveBlocker: { start: () => 1, stop() {} } };
  return load.call(this, id, ...args);
};
const FileRecv = require('../../filerecv.js');
const FileDrop = require('../../filedrop.js');
const MeshFileClip = meshFileClip(require('../../fclip.js'));
const fm = require('../../fm.js');
Module._load = load;
require('../../fm.js').showItems = () => {}; // no file manager window popping up on this desktop for a test's folder

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function hubNode(name) {
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
  return { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub };
}

const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };

// A computer's files as main.js makes them: receivers per device, the Send files sender, the shortcuts.
function files(n, settings) {
  const helper = { request: async () => ({}), send() {}, on() {} };
  const set = new FilesSet({ hub: n.hub, make: (link) => ({ fileRecv: new FileRecv({ link, helper, settings, onChange() {} }), dragRecv: { onRelease() {}, onHome() {}, dragging: false, view: () => ({ state: '' }) } }) });
  const fileDrop = new FileDrop({ link: n.hub.facade, settings, onProgress() {} });
  const popups = [];
  const clip = new MeshFileClip({
    hub: n.hub, files: set, helper, fileDrop, settings, peerName: () => 'the other computer', popup: (kind, text) => popups.push(text), onChange() {},
    makeSender: (id) => new FileDrop({ link: n.hub.scoped(id), settings, onProgress() {} }),
  });
  set.fileRecv.onBatch = (b) => { if (b.kind === 'paste') clip.pasted(b); };
  return { set, clip, popups };
}

test('a copy made on a device that is not selected is pasted from it', async () => {
  const A = await hubNode('A');
  const B = await hubNode('B');
  const C = await hubNode('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => up(A, B) && up(B, A) && up(A, C) && up(C, A), 'B and C linked to A');
    const settings = { files: { acceptFromMac: true, shortcuts: true, receivedFolder: path.join(dir, 'received') } };
    const a = files(A, settings);
    const b = files(B, settings);
    files(C, settings);
    assert.ok(A.hub.select(C.id), 'A has C selected');

    const src = path.join(dir, 'report.bin');
    const data = crypto.randomBytes(20000);
    fs.writeFileSync(src, data);
    b.clip._selection = async () => [src];
    await b.clip.copy();
    await waitFor(() => a.clip.incoming, 'A hears B’s copy');
    assert.strictEqual(a.clip.incoming.from, B.id, 'the copy is B’s');

    const into = path.join(dir, 'front');
    fs.mkdirSync(into);
    fm.front = async () => ({ folder: into });
    const toC = [];
    C.hub.bus.on(T.FCLIP_PASTE, (m) => toC.push(m));
    await a.clip.paste();
    await waitFor(() => fs.existsSync(path.join(into, 'report.bin')) && !a.clip.pasting, 'the file pasted into the folder in front');
    assert.ok(fs.readFileSync(path.join(into, 'report.bin')).equals(data), 'the same bytes');
    assert.deepStrictEqual(toC, [], 'C, the selected device, wasn’t asked');
    assert.ok(b.clip.senders.has(A.id), 'B sent it through its sender for A');

    // B leaves: there's nothing to paste from it any more.
    B.links.close();
    B.server.close();
    await waitFor(() => !up(A, B), 'B gone');
    await waitFor(() => a.clip.incoming === null, 'B’s copy forgotten');
  } finally {
    close(A, B, C);
  }
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true })); // runTests exits the process: no .finally after it
runTests(tests);
