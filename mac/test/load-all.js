// Loads EVERY non-renderer module of mac/ with `electron` stubbed, then builds the classes that can be
// built with fakes. Fails on any exception: an import of the wrong shape (a default import of a named
// export, a missing require) crashes here instead of on the first connection.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');

const MAC = path.resolve(__dirname, '..');

// electron: every property is a callable stub; the few values used at load time are real.
function makeStub() {
  const values = {
    getPath: () => os.tmpdir(),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    isSupported: () => false,
    getMediaAccessStatus: () => 'unknown',
  };
  const target = function stub() {};
  const proxy = new Proxy(target, {
    get(t, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return () => proxy; // a chain like app.whenReady().then(fn): never calls fn
      if (key in values) return values[key];
      return proxy;
    },
    apply() {
      return proxy;
    },
    construct() {
      return proxy;
    },
  });
  return proxy;
}

const electronStub = makeStub();
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};

// Renderer code (runs in a page, not with Node): not loaded here. A script of a page is one that an
// .html file of mac/ loads, plus the preloads and the ui-*.js files that the control page loads.
const RENDERER = /(-renderer\.js|^preload-.*\.js|^ui-.*\.js|^pcm-worklet\.js)$/;
const pageScripts = new Set();
for (const h of fs.readdirSync(MAC).filter((f) => f.endsWith('.html'))) {
  for (const m of fs.readFileSync(path.join(MAC, h), 'utf8').matchAll(/<script[^>]*src="([^"]+\.js)"/g)) pageScripts.add(m[1]);
}
const files = fs.readdirSync(MAC).filter((f) => f.endsWith('.js') && !RENDERER.test(f) && !pageScripts.has(f));
const loaded = {};
const failures = [];

for (const f of files) {
  try {
    loaded[f] = require(path.join(MAC, f));
  } catch (e) {
    failures.push(`require ${f}: ${e.stack || e}`);
  }
}

// ---- construction with fakes ----
const { EventEmitter } = require('events');
const { loadTestCert, memoryStorage } = require('./lib/mesh.js');
const { FakeHelper, fakeClipboard, fakeNotificationClass } = require('./lib/pooled.js');

const built = [];
function build(name, fn) {
  try {
    const v = fn();
    built.push(name);
    return v;
  } catch (e) {
    failures.push(`build ${name}: ${e.stack || e}`);
    return null;
  }
}

const P = require('../../shared/protocol.js');
const { Mesh, Pool, Roster, keepalive } = require('../../shared/mesh.js');
assert.ok(Mesh && Pool && Roster && keepalive, 'shared/mesh.js exports');

const cert = loadTestCert();
const storage = memoryStorage();
const identity = { macId: 'a0000000-0000-4000-8000-000000000001', macName: 'Load Test Mac', fp: cert.fp };
const device = { id: identity.macId, name: identity.macName };
const server = build('Server', () => new loaded['server.js'].Server({ keyPem: cert.keyPem, certPem: cert.certPem, port: 0, tick: false }));
const pairing = build('Pairing', () => new loaded['pairing.js'].Pairing(server, identity, { storage }));
const links = build('LinkManager', () => new loaded['links.js'].LinkManager({ device, storage, hostPairing: pairing }));
// A guest link is made by the manager (the path that crashed once on the first connection).
build('LinkManager.startPairing link', () => {
  links.startPairing({ address: '127.0.0.1', port: 9, macName: 'nobody' });
  links.cancelPair();
});
const mesh = build('Mesh', () => new Mesh({ selfId: identity.macId }));
const hub = build('Hub', () => new loaded['hub.js'].Hub({ device, links, mesh, server, pairing }));
build('Peer(facade)', () => new loaded['peer.js'].Peer(hub.facade, server));
build('Peer(phone)', () => new loaded['peer.js'].Peer(hub.phoneRoute(), server));
build('Link', () => new loaded['link.js'].Link({ device, store: { load: () => null, save() {}, clear() {} } }));
build('Session', () => new loaded['session.js'].Session('x', { server }));
build('Sessions', () => new loaded['session.js'].Sessions({ links, server }));

const settings = {
  clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20 },
  notifs: { send: true, receive: true, hideText: false, muted: [] },
  keys: { swapCtrlCmd: true, hotkey: 'AltRight' },
};
const getSettings = () => settings;
if (hub && mesh) {
  build('Clip', () => new loaded['clipboard.js'].Clip({ bus: hub.bus, mesh, getSettings, clipboard: fakeClipboard(), helper: new FakeHelper() }));
  build('Notifs', () => new loaded['notifs.js'].Notifs({
    bus: hub.bus, mesh, getSettings, helper: new FakeHelper(), selfName: 'Load Test Mac',
    Notification: fakeNotificationClass([]),
  }));
}

// The helper-backed services (the same constructors services.js calls), with a fake helper.
const helper = new FakeHelper();
if (hub && server) {
  const peer = new loaded['peer.js'].Peer(hub.facade, server);
  const displays = build('Displays', () => new loaded['displays.js'].Displays(helper, getSettings));
  const audioHub = build('AudioHub', () => new loaded['audiohub.js'].AudioHub(helper, getSettings));
  const stream = build('Stream', () => new loaded['stream.js'].Stream(peer, displays, getSettings, audioHub));
  build('Terminal', () => new loaded['terminal.js'].Terminal(peer, getSettings));
  build('Wake', () => new loaded['wake.js'].Wake({ server: peer, getSettings, saveSettings() {} }));
  build('Apps', () => new loaded['apps.js'].Apps({ server: peer, helper, displays, stream, getSettings }));
  build('Audio', () => new loaded['audio.js'].Audio({ server: peer, hub: audioHub, stream, getSettings }));
  build('PcView', () => new loaded['pcview.js'].PcView({ server: peer, getSettings, saveSettings() {} }));
  build('PcApps', () => new loaded['pcapps.js'].PcApps({ server: peer, getSettings }));
  build('FileSend', () => new loaded['filesend.js'].FileSend(peer, getSettings));
  build('Drop', () => new loaded['drop.js'].Drop({ server: peer, helper, displays, getSettings }));
  build('AppSend', () => new loaded['appsend.js'].AppSend({ server: peer, helper, getSettings }));
  build('Smb', () => new loaded['smb.js'].Smb({ server: peer, helper, getSettings, saveSettings() {} }));
  build('SshClient', () => new loaded['ssh-client.js'].SshClient(peer, getSettings));
  const input = build('Input', () => new loaded['input.js'].Input(peer, helper, displays, { enabled: () => true, swapKeys: () => false }));
  build('PairSync', () => new loaded['pairsync.js'].PairSync({ server: peer, getSettings, saveSettings() {}, apply() {} }));
  // The phone's features: they follow the phone's route, not the selected device.
  const phonePeer = new loaded['peer.js'].Peer(hub.phoneRoute(), server);
  const fakeAdb = { available: false, devices: async () => [] };
  const phone = build('Phone', () => new loaded['phone.js'].Phone({ server: phonePeer, raw: server, discovery: null, pairing }));
  const bridge = build('PhoneBridge', () => new loaded['phone-bridge.js'].PhoneBridge({ server: phonePeer, phone: phone || { on() {} }, getSettings, clipboard: null }));
  build('PhoneViews', () => new loaded['phoneview.js'].PhoneViews({ bridge, phone, getSettings, server: phonePeer, fileSend: null }));
  build('PhoneDrive', () => new loaded['phonedrive.js'].PhoneDrive({ adb: fakeAdb, bridge, phone }));
  const wired = build('Wired', () => new loaded['wired.js'].Wired({ adb: fakeAdb, raw: server, peer: phonePeer, getId: () => identity.macId, hasPhone: () => false }));
  if (wired) clearInterval(wired.timer); // its poll timer would keep this check running
  build('Kvm', () => new loaded['kvm.js'].Kvm({ server: peer, helper, getSettings, clipboard: new loaded['clipboard.js'].Clip({ bus: hub.bus, mesh, getSettings, clipboard: fakeClipboard(), helper }), input, drop: { dragIn: {}, on() {} }, fileSend: new EventEmitter() }));
}

if (server) server.close();
void EventEmitter;
void P;

if (failures.length) {
  console.log(`FAILED: ${failures.length} problem(s)`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log(`passed: ${files.length} modules required with electron stubbed, ${built.length} classes built with fakes (${built.join(', ')})`);
process.exit(0);
