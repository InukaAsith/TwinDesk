// TwinDesk Drive's extra folders in Multi-device (shared/drive-host.js createMesh, phase 3 of the
// 2026-11-28 plan): A shares "Photos" with B only. B is told (drive.folders), C isn't; the folder's link
// opens once B lists it too, its files reach B's own Photos folder and not B's main folder, its requests
// carry &f=, and C (which never listed it, as an older TwinDesk) gets no message with f.
// Run: node shared/test/drive-folders.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Drive } = require('../drive.js');
const { DriveLink } = require('../drive-link.js');
const { createMesh } = require('../drive-host.js');
const P = require('../protocol.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drivefolders-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=td', '-keyout', path.join(base, 'k.pem'), '-out', path.join(base, 'c.pem')], { stdio: 'ignore' });
} catch {
  console.log('drive-folders: skipped (no openssl)');
  process.exit(0);
}
const key = fs.readFileSync(path.join(base, 'k.pem'));
const cert = fs.readFileSync(path.join(base, 'c.pem'));
const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
const clone = (m) => JSON.parse(JSON.stringify(m));
const later = Date.now() + 60000;

const write = (dir, rel, text) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(Date.now() - 10000);
  fs.utimesSync(f, t, t);
};
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
const wait = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

(async () => {
  // This computer (A): the mesh host, as the app has it, on a fake hub.
  const aDir = path.join(base, 'A', 'Drive');
  const busH = new Map();
  const peerH = { welcome: [], closed: [], transport: [] };
  const tokens = { B: crypto.randomBytes(16).toString('hex'), C: crypto.randomBytes(16).toString('hex'), phone: crypto.randomBytes(16).toString('hex') };
  const connected = new Set();
  const guests = {}; // id -> the computer's DriveLink
  const toPhone = [];
  const told = {}; const fsent = {}; const fguests = {};
  let request = null;
  const mesh = {
    on: (t, fn) => { if (!busH.has(t)) busH.set(t, []); busH.get(t).push(fn); },
    onPeer: (ev, fn) => peerH[ev].push(fn),
    send: (id, m) => {
      if (id === 'phone') toPhone.push(m);
      else if (m.t === 'drive.folders') told[id] = clone(m);
      else if (m.f) { fsent[id] = (fsent[id] || 0) + 1; setImmediate(() => fguests[id] && fguests[id].onMessage(clone(m))); }
      else setImmediate(() => guests[id] && guests[id].onMessage(clone(m)));
      return true;
    },
    session: (id) => (connected.has(id) ? { host: true, token: tokens[id], address: '127.0.0.1', transport: 'ip' } : null),
    peerName: (id) => id,
    isComputer: (id) => id !== 'phone',
    connectedIds: () => [...connected],
    setRequest: (fn) => { request = fn; },
  };
  const settings = { drive: { on: false, folder: aDir } };
  const A = createMesh({ settings, save: () => {}, me: 'A', meName: 'A', userData: path.join(base, 'A'), trash: async (p) => fs.rmSync(p), mesh });
  assert.strictEqual(request, null, 'off: nothing hooked');

  const server = https.createServer({ key, cert }, (req, res) => {
    if (!(request && request(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // The other computers: guests of A, each with its own token.
  const engines = {};
  async function computer(id) {
    const dir = path.join(base, id, 'Drive');
    const d = new Drive({ me: id, meName: id, folder: () => dir, indexFile: path.join(base, id, 'i.json'), watch: false, now: () => later, trash: async (a) => fs.rmSync(a) });
    d.dir = dir;
    engines[id] = d;
    await d.start();
    guests[id] = new DriveLink({
      drive: d,
      send: (m) => setImmediate(() => { for (const fn of busH.get(m.t) || []) fn(clone(m), id); }),
      session: () => ({ host: false, token: tokens[id], address: '127.0.0.1', port, fp, transport: 'ip' }),
      peerName: () => 'A',
    });
    return d;
  }
  const up = (id) => { connected.add(id); for (const fn of peerH.welcome) fn(id); if (guests[id]) guests[id].start(); };
  const down = (id) => { connected.delete(id); for (const fn of peerH.closed) fn(id); if (guests[id]) guests[id].stop(); };

  const B = await computer('B');
  const C = await computer('C');
  up('B'); up('C');
  await A.setOn(true);
  const pDir = path.join(base, 'A', 'Photos');
  write(pDir, 'cat.jpg', 'meow');
  const fid = await A.addFolder({ name: 'Photos', path: pDir, devices: ['B'] });
  assert.ok(/^[0-9a-f]{16}$/.test(fid));
  assert.ok(await wait(() => told.B && told.B.list.length === 1), 'B is told');
  assert.deepStrictEqual(told.B.list, [{ f: fid, name: 'Photos' }]);
  assert.deepStrictEqual(told.C.list, [], 'C is not');
  assert.strictEqual(fsent.B || 0, 0, 'nothing with f until B lists it');

  // B takes it: its own engine for the folder, and says it has it.
  const bp = path.join(base, 'B', 'Photos');
  const bd = new Drive({ me: 'B', meName: 'B', folder: () => bp, indexFile: path.join(base, 'B', 'ip.json'), watch: false, now: () => later, trash: async (a) => fs.rmSync(a) });
  fs.mkdirSync(bp, { recursive: true });
  await bd.start();
  fguests.B = new DriveLink({
    drive: bd, folder: fid,
    send: (m) => setImmediate(() => { for (const fn of busH.get(m.t) || []) fn(clone(m), 'B'); }),
    session: () => ({ host: false, token: tokens.B, address: '127.0.0.1', port, fp, transport: 'ip' }),
    peerName: () => 'A',
  });
  for (const fn of busH.get('drive.folders')) fn({ t: 'drive.folders', list: [{ f: fid, name: 'Photos' }] }, 'B');
  fguests.B.start();
  assert.ok(await wait(() => read(bp, 'cat.jpg') === 'meow'), 'B gets A\'s photo in its Photos folder');
  assert.strictEqual(read(B.dir, 'cat.jpg'), null, 'not in B\'s main folder');
  write(bp, 'dog.jpg', 'woof');
  await bd.scan();
  assert.ok(await wait(() => read(pDir, 'dog.jpg') === 'woof'), 'B\'s photo comes back to A (a PUT with &f=)');
  assert.strictEqual(fsent.C || 0, 0, 'C never gets an f message');

  // C offers its own folder: A shows it, Add takes its id and name.
  for (const fn of busH.get('drive.folders')) fn({ t: 'drive.folders', list: [{ f: 'abcdef0123456789', name: 'Work' }] }, 'C');
  let v = A.view();
  assert.deepStrictEqual(v.offers, [{ f: 'abcdef0123456789', name: 'Work', from: ['C'] }]);
  assert.strictEqual(v.folders[0].name, 'Photos');
  assert.ok(v.folders[0].connected, 'Photos is syncing with B');
  const wid = await A.addFolder({ id: 'abcdef0123456789', path: path.join(base, 'A', 'Work') });
  assert.strictEqual(wid, 'abcdef0123456789');
  v = A.view();
  assert.strictEqual(v.offers.length, 0);
  assert.strictEqual(v.folders[1].name, 'Work');
  assert.ok(await wait(() => told.C && told.C.list.some((x) => x.f === wid)), 'A tells C it has Work now (devices: all)');

  // Photos no longer shared with B: its link closes; removing Work stops it here.
  A.setFolderDevices(fid, []);
  assert.ok(await wait(() => !A.view().folders[0].connected), 'B\'s Photos link closed');
  await A.removeFolder(wid);
  assert.strictEqual(A.view().folders.length, 1);

  await A.setOn(false);
  assert.strictEqual(A.view().state, 'off', 'Drive off: its own folder stops');
  assert.notStrictEqual(A.view().folders[0].state, 'off', 'the shared folders run on without Drive');
  await A.stop();
  fguests.B.destroy(); await bd.stop();
  for (const id of ['B', 'C']) { guests[id].destroy(); await engines[id].stop(); }
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('drive-folders: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
