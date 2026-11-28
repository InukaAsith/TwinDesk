// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sound that plays with one device while another is selected (#245): three real hubs on real sockets (A, B,
// C linked to each other), the real per-pair switches (shared/pairsync-mesh.js and shared/consent.js, as
// mesh/main.js wires them, setFeature() re-applying the sound as ipc.js does) and the real sound engines, windows/sound.js and linux/sound.js, one per device in
// a SoundSet (shared/sound-mesh.js) as mesh/main.js makes them, with `electron`
// (and Linux's loopback) stubbed. A sends its sound to B; selecting C, whose pair has the sound off, must
// not stop it; turning B's own switch off still does.
// Run: node shared/test/mesh-sound-selection.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');
const { Hub } = require('../../linux/mesh/hub.js');
const { LinkManager } = require('../../linux/mesh/links.js');
const { Server } = require('../../linux/mesh/server.js');
const { Pairing } = require('../../linux/mesh/hostpair.js');
const { normalize } = require('../../linux/mesh/settings.js');
const { SoundSet } = require('../sound-mesh.js');
const { FEATURES, VALUES } = require('../../linux/pairsync.js');
const { pairSyncMesh } = require('../pairsync-mesh.js');
const { consent } = require('../consent.js');
const { waitFor, pair, memoryStorage, close } = require('../../linux/mesh/test/lib/mesh.js');
const { loadTestCert } = require('../../linux/mesh/test/lib/testcert.js');

const T = P.T;

// The Electron the sound engines use: a hidden window that only queues, and ipcMain.
class FakeWindow {
  constructor() {
    this.webContents = { send() {} };
  }

  loadFile() {}

  isDestroyed() { return false; }

  on() {}

  once() {}

  destroy() {}
}
const electron = {
  BrowserWindow: FakeWindow,
  ipcMain: new EventEmitter(),
  session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
  desktopCapturer: { getSources: async () => [] },
};
const loopback = { acquire: async () => 'twindesk-test', release() {}, setMute() {} };
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return electron;
  if (id === './loopback') return loopback;
  return load.call(this, id, ...args);
};
const SOUNDS = { windows: require('../../windows/sound.js'), linux: require('../../linux/sound.js') };
Module._load = load;

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
  return { name, id, port: server.port, server, links, pairing, hub, stops: [] };
}

const linked = (a, b) => {
  const sa = a.hub.sessions.get(b.id);
  const sb = b.hub.sessions.get(a.id);
  return !!(sa && sa.connected && sb && sb.connected);
};

async function run(platform) {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
  try {
    // A's sound and its two-way switches, there before any device connects (as in mesh/main.js).
    A.settings = normalize({ audio: { send: true, receive: false } });
    A.settings.pairSync = { [C.id]: { audio: { out: false, in: false }, values: {} } }; // C's pair: no sound
    // A Sound per device (shared/sound-mesh.js), as mesh/main.js makes them now.
    A.sound = new SoundSet({ Sound: SOUNDS[platform], hub: A.hub, settings: A.settings, onChange() {} });
    const toB = () => A.sound.byId.get(B.id);
    A.hub.consent = consent({ features: FEATURES, settings: () => A.settings, selectedId: () => A.hub.selectedId });
    const only = ['clipboard', 'notifs', 'apps', 'audio', 'cursor', 'terminal', 'files'];
    const features = Object.fromEntries(Object.entries(FEATURES).filter(([f]) => only.includes(f)));
    A.pairSync = pairSyncMesh({
      bus: A.hub.bus, hub: A.hub, features, values: VALUES, settings: () => A.settings, save() {},
      setFeature: (f, dir, on) => { const [sec, key] = features[f][dir]; A.settings[sec][key] = on; if (sec === 'audio') A.sound.apply(); },
      setValue: (k, v) => { const [sec, key] = VALUES[k].path; A.settings[sec][key] = v; },
      peerRole: (id) => { const x = A.hub.sessions.get(id); return x ? x.role : null; },
      peerOs: (id) => { const x = A.hub.sessions.get(id); return x ? x.peerOs : null; },
    });
    B.hub.bus.on(T.AUDIO_STOP, (m, from) => B.stops.push({ m, from }));

    for (const [x, y] of TRIANGLE) await pair(N[x], N[y]);
    await waitFor(() => TRIANGLE.every(([x, y]) => linked(N[x], N[y])), 'triangle linked');

    // B selected, B plays A's sound (its audio.policy accepts it).
    A.hub.select(B.id);
    assert.strictEqual(A.hub.selectedId, B.id);
    B.hub.bus.send(A.id, { t: T.AUDIO_POLICY, accept: true });
    await waitFor(() => toB() && !!toB().sending, 'A sends its sound to B');
    if (platform === 'linux') await waitFor(() => toB().sending.loop, 'the loopback source is up');

    // The pointer crosses to C: C's pair (sound off) is in the settings now, the sound stays with B.
    A.hub.select(C.id);
    assert.strictEqual(A.settings.audio.send, false, 'the Audio page shows C’s pair');
    assert.ok(toB().sending, 'A still sends its sound to B');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(B.stops.length, 0, 'B was not told to stop');

    // Back to B: its pair comes back, nothing restarts.
    const session = toB().sending.session;
    A.hub.select(B.id);
    assert.strictEqual(A.settings.audio.send, true, 'B’s pair is back');
    assert.strictEqual(toB().sending && toB().sending.session, session, 'the same sending session');

    // B's own switch off (B selected): the sound stops, as before.
    A.settings.audio.send = false;
    A.sound.apply();
    assert.strictEqual(toB().sending, null, 'turning B’s switch off stops it');
    await waitFor(() => B.stops.some((s) => s.from === A.id), 'B gets audio.stop'); // its dir as B reads it (P.swapRole)
    console.log(`passed: ${platform}/sound.js keeps playing with B while C (sound off) is selected`);
  } finally {
    close(A, B, C);
  }
}

(async () => {
  await run('windows');
  await run('linux');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
