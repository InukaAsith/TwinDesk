// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/mesh/audioset.js (docs/mesh-graph.md, step 2 on the Mac): an Audio per connected device on a route
// that follows only it (the real Route and Peer), each its own consumer of the capture; this Mac's sound
// to several devices at once, none of them selected; a new selection applies every device's switches.
// The Audio is a stand-in that decides as ../../audio.js does (want = send && they accept && a client).
// Run with: node mac/mesh/test/audioset.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Route } = require('../../../shared/hub-route.js');
const { Peer } = require('../peer.js');
const { AudioSet } = require('../audioset.js');
const { consent } = require('../../../shared/consent.js');

class FakeAudio extends EventEmitter {
  constructor({ server, hub, getSettings, meshHub, capName }) {
    super();
    Object.assign(this, { server, hub, getSettings, meshHub, capName });
    this.peerAccepts = false;
    this.sending = null;
    this.offers = [];
    this.applied = 0;
    server.on('client', () => { this.peerAccepts = false; this.server.sendToClient({ t: 'audio.policy', accept: this._on('receive') }); this.evaluate(); });
    server.on('closed', () => { if (!server.current) this.sending = null; });
    server.on('t:audio.policy', (m) => { this.peerAccepts = m.accept === true; this.evaluate(); });
    server.on('t:audio.offer', (m) => this.offers.push(m));
  }
  _on(key) {
    const c = this.server.current;
    const pair = this.meshHub.consent; // each device's own pair, as audio.js reads it
    return pair && c ? !!pair.get(c.deviceId, 'audio', key === 'send' ? 'out' : 'in') : !!this.getSettings().audio[key];
  }
  evaluate() {
    const want = !!(this._on('send') && this.peerAccepts && this.server.current);
    if (want && !this.sending) { this.sending = { status: 'live' }; this.hub.acquire(this.capName); }
    else if (!want && this.sending) { this.sending = null; this.hub.release(this.capName); }
  }
  applySettings() { this.applied++; this.evaluate(); }
  get view() { return { peerAccepts: this.peerAccepts, sending: this.sending, receiving: null, error: '' }; }
}

// The Mac hub as AudioSet and Route see it: sessions, routes, the selection, peerAdded, messages in.
function fakeHub(ids) {
  const hub = new EventEmitter();
  hub.device = { id: 'mac', name: 'MacBook' };
  hub.selectedId = null;
  hub.routes = [];
  hub.sent = [];
  hub.list = ids.map((id) => ({
    id, connected: true, hostUp: false, linkUp: false, role: 'guest', transport: 'ip', peerOs: 'win', status: { rtt: 1 }, lastRx: 0, link: null, ctx: null,
    displayName: () => id.toUpperCase(),
    send(m) { hub.sent.push([id, m]); return true; },
  }));
  hub.sessions = { list: () => hub.list, get: (id) => hub.list.find((s) => s.id === id) || null, fxShared: null };
  hub._connectedIds = () => hub.list.filter((s) => s.connected).map((s) => s.id);
  hub.route = (pick) => { const r = new Route(hub, pick); hub.routes.push(r); return r; };
  hub.from = (id, m) => { for (const r of hub.routes) if (r.targetId === id) r.deliver(m); };
  return hub;
}

const capture = () => { const c = { users: new Set(), error: '' }; c.acquire = (n) => c.users.add(n); c.release = (n) => c.users.delete(n); return c; };
const stream = { audio: { on: false } };

// An Audio per device, told 'client' on its own route; each hears only its device.
{
  const hub = fakeHub(['ryzen', 'amx']);
  const set = new AudioSet({ Audio: FakeAudio, Peer, hub, audioHub: capture(), stream, getSettings: () => ({ audio: { send: true, receive: true } }) });
  const r = set.byId.get('ryzen'), a = set.byId.get('amx');
  assert.strictEqual(r.server.current.deviceId, 'ryzen');
  assert.strictEqual(a.server.current.deviceId, 'amx');
  assert.ok(hub.sent.some(([id, m]) => id === 'ryzen' && m.t === 'audio.policy'));
  assert.ok(hub.sent.some(([id, m]) => id === 'amx' && m.t === 'audio.policy'));
  hub.from('ryzen', { t: 'audio.offer', dir: 'w2m', session: 1 });
  assert.strictEqual(r.offers.length, 1);
  assert.strictEqual(a.offers.length, 0);
  assert.strictEqual(r.capName, 'audio:ryzen');
}

// Sound to several devices at once, none selected, each its own consumer of the capture; a device whose
// switch is off doesn't get it.
{
  const hub = fakeHub(['ryzen', 'amx', 'nitro']);
  hub.selectedId = 'nitro';
  const settings = { audio: { send: false, receive: true }, pairSync: { ryzen: { audio: { out: true } }, amx: { audio: { out: true } } } };
  const cap = capture();
  hub.consent = consent({ features: { audio: { out: ['audio', 'send'], in: ['audio', 'receive'] } }, settings: () => settings, selectedId: () => hub.selectedId }); // as mesh/main.js
  const set = new AudioSet({ Audio: FakeAudio, Peer, hub, audioHub: cap, stream, getSettings: () => settings });
  for (const id of ['ryzen', 'amx', 'nitro']) hub.from(id, { t: 'audio.policy', accept: true });
  assert.deepStrictEqual([...cap.users].sort(), ['audio:amx', 'audio:ryzen']);
  assert.deepStrictEqual(set.view.edges.map((e) => [e.id, e.sending]), [['ryzen', true], ['amx', true], ['nitro', false]]);
  assert.deepStrictEqual(set.devices().filter((d) => d.sound.view().sending).map((d) => d.id), ['ryzen', 'amx']);
}

// A new selection applies every device's switches (settings.audio is the selected one's); another change doesn't.
{
  const hub = fakeHub(['a', 'b']);
  const set = new AudioSet({ Audio: FakeAudio, Peer, hub, audioHub: capture(), stream, getSettings: () => ({ audio: { send: true, receive: true } }) });
  hub.emit('change');
  assert.deepStrictEqual([...set.byId.values()].map((x) => x.applied), [0, 0]);
  hub.selectedId = 'b';
  hub.emit('change');
  assert.deepStrictEqual([...set.byId.values()].map((x) => x.applied), [1, 1]);
}

// A device that comes later gets its Audio, on its own route, at once.
{
  const hub = fakeHub(['a']);
  const set = new AudioSet({ Audio: FakeAudio, Peer, hub, audioHub: capture(), stream, getSettings: () => ({ audio: { send: true, receive: true } }) });
  hub.list.push({ ...hub.list[0], id: 'late', displayName: () => 'LATE', send(m) { hub.sent.push(['late', m]); return true; } });
  hub.emit('peerAdded', 'late');
  const late = set.byId.get('late');
  assert.strictEqual(late.server.current.deviceId, 'late');
  hub.from('late', { t: 'audio.policy', accept: true });
  assert.ok(late.sending);
  hub.emit('peerAdded', 'late');
  assert.strictEqual(set.byId.get('late'), late, 'one Audio per device');
}

console.log('audioset: all passed');
