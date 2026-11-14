// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM, System-wide (docs/full-kvm.md): the machine node, Linux and Windows alike. The service
// starts it while nobody is signed in (Linux: linux/fullkvm/service.js, as the unprivileged `twindesk`
// account, at seat0's login screen; Windows: the TwinDeskFullKvmNode service, as LOCAL SERVICE) and
// stops it when someone signs in (their app takes the port and the mesh back). It is the mesh core of mesh/main.js without
// windows: discovery, the links to the paired devices, our server, the shared layout and kvm.js, with
// the mouse and keyboard through the service's helper (its socket is ours while we run). It is this
// computer as the others know it: System-wide copied the person's certificate, device id, pairings
// and layout to the machine folder. Here nobody can compare a pairing code: new pairings are refused.
// No clipboard, files, screens or sound: only the mouse and keyboard.
//   TWINDESK_MACHINE_DIR=/var/lib/twindesk TWINDESK_KVM_SOCK=/run/twindesk/kvm.sock \
//   ELECTRON_RUN_AS_NODE=1 <electron> shared/fullkvm/headless.js
'use strict';

const Module = require('module');
const stub = require('./electron-stub.js');
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? stub : load.call(this, request, ...rest);
};

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const P = require('../protocol.js');
// This platform's app (linux/ or windows/): the same mesh modules on both.
const OS = path.join(__dirname, '..', '..', process.platform === 'win32' ? 'windows' : 'linux');
const mod = (m) => require(path.join(OS, m));
const store = mod('store');
const { Discovery } = mod('discovery');
const { LinkManager } = mod('mesh/links');
const { Mesh } = require('../mesh.js');
const { Hub } = mod('mesh/hub');
const { Server } = mod('mesh/server');
const { Pairing: HostPairing } = mod('mesh/hostpair');
const identity = mod('identity');
const Kvm = mod('mesh/kvm');
const LayoutSync = mod('mesh/layout-sync');
const { load: loadSettings, save: storeSettings } = mod('mesh/settings');
const { SvcLink } = require('./svc-link.js');

const log = (...a) => console.log('[machine]', ...a);
const SOCK = process.env.TWINDESK_KVM_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\TwinDesk.kvm' : '/run/twindesk/kvm.sock');

function loadDevice() {
  let d = store.read('device.json', null);
  if (!d || typeof d.id !== 'string') { d = { id: crypto.randomUUID() }; store.write('device.json', d); }
  return { id: d.id, name: os.hostname() };
}

// The service's helper, as kvm.js knows a helper (send, request, sendMove, events).
class ServiceHelper extends SvcLink {
  get running() { return this.ready; }
}

// Linux's helper is told the monitors (the uinput backend can't ask); Windows' asks Windows.
function sendScreens(helper) {
  if (process.platform === 'win32') return;
  const list = stub.displays().map((d, i) => [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height, i === 0 ? 1 : 0].join(',')).join(';');
  helper.send('screens', { list });
}

async function main() {
  const settings = loadSettings(store);
  const save = () => storeSettings(store, settings);
  const device = loadDevice();
  log(`${device.name} (${device.id}) at the login screen`);

  const discovery = new Discovery(device);
  discovery.start();
  const links = new LinkManager({ device, resolveAddress: (id) => discovery.get(id) });
  const mesh = new Mesh({ selfId: device.id });
  const hub = new Hub({ device, links, mesh });

  const id = await identity.load(); // the person's certificate: the same computer to the others
  discovery.self.fp = id.fp;
  const server = new Server(id);
  // The person's TwinDesk may still hold the port for a moment (it is on its way out): again until ours.
  server.on('listenError', (e) => {
    log('the port:', e.code || e.message, '- again in 2 s');
    setTimeout(() => server.https.listen(server.port, '0.0.0.0'), 2000);
  });
  server.on('listening', () => log('listening on', server.port));
  discovery.self.port = server.port;
  const pairing = new HostPairing(server, { id: device.id, name: device.name, fp: id.fp });
  pairing.on('request', () => { log('a pairing request at the login screen: refused'); pairing.respond(false); });
  hub.attachHost(server, pairing);
  hub.start(); // dial the computers we are a guest of (mesh/main.js: link.start())

  const helper = new ServiceHelper(SOCK);
  helper.on('ready', () => { log('the mouse and keyboard are ours'); sendScreens(helper); });
  helper.start();

  const layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: device.id,
    storage: { get: () => settings.layout, set: (l) => { settings.layout = l; save(); } },
    knownIds: () => hub.peers({ indirect: true }).map((p) => p.id),
    canDrive: (pid) => { const s = hub.sessions.get(pid); return !!s && s.connected; },
    endsChain: (pid) => { const s = hub.sessions.get(pid); return !!s && P.isPhoneOs(s.peerOs); },
    online: (pid) => { const p = hub.peers({ indirect: true }).find((x) => x.id === pid); return !!p && (p.state === 'connected' || p.state === 'via'); },
    myDisplays: () => require('../screen-mesh.js').fromElectron(stub.screen),
    displaysStorage: { get: () => settings.layoutDisplays || null, set: (m) => { settings.layoutDisplays = m; save(); } },
    legacyEdges: () => settings.kvm.edges,
    onChange: () => { if (kvm) kvm.layoutChanged(); },
  });
  // No files, drags or clipboard here: whatever kvm.js asks of them is a no-op.
  const none = new Proxy({ view: () => ({}), dragging: false }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : () => null) });
  const kvm = new Kvm({ hub, layoutSync, helper, clip: none, fileDrop: none, fileRecv: none, dragRecv: none, settings, save, onChange: () => {} });
  kvm.onWhere = (mode) => log('mouse and keyboard:', mode);
  hub.on('change', () => {
    const on = hub.peers().filter((p) => p.state === 'connected').map((p) => p.name || p.id);
    const key = on.join(', ');
    if (key !== main.last) { main.last = key; log('connected:', key || 'nobody'); }
  });

  const quit = () => {
    log('someone signed in: handing over');
    try { kvm.home && kvm.home(); } catch (_) { /* going */ }
    helper.stop();
    try { server.close && server.close(); } catch (_) { /* going */ }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}

main().catch((e) => { console.error('[machine]', e && e.stack || e); process.exit(1); });
