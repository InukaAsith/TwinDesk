// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/sound-mesh.js (docs/mesh-graph.md, step 2): a Sound per connected device on a link scoped to it;
// each hears only its device and sends only to it; several devices take our sound at once; the graph's
// limit; a new selection re-applies every edge (and nothing else does); view() is the selected device's.
// Run: node shared/test/sound-mesh.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SoundSet } = require('../sound-mesh.js');
const { MeshShadow } = require('../mesh-shadow.js');
const { consent } = require('../consent.js');

// A hub as SoundSet sees it: sessions, the selection, scoped(id) as hub.js has it, peerAdded/change.
function fakeHub(devices) {
  const hub = new EventEmitter();
  const bus = new Map(); // type -> [fn(m, from)]
  const peer = new Map(); // 'welcome' | 'closed' -> [fn(id, info)]
  const add = (m, k, fn) => { if (!m.has(k)) m.set(k, []); m.get(k).push(fn); };
  hub.sent = []; // [id, msg]
  hub.device = { id: 'self', name: 'nitro5' };
  hub.selectedId = null;
  hub.list = devices.map((d) => ({
    id: d.id, peerOs: d.os || 'win', connected: true, hosting: false, role: 'guest', transport: 'ip',
    status: { state: 'connected', rtt: 1 }, lastRx: 0, link: null, ctx: null,
    displayName: () => d.name || d.id,
    send(m) { if (!this.connected) return false; hub.sent.push([d.id, m]); return true; },
  }));
  hub.sessions = { list: () => hub.list, get: (id) => hub.list.find((s) => s.id === id) || null };
  hub._connectedIds = () => hub.list.filter((s) => s.connected).map((s) => s.id);
  hub.scoped = (id) => {
    const sess = () => hub.sessions.get(link.id);
    const link = {
      id,
      on(type, fn) {
        if (type === 'welcome' || type === 'closed') add(peer, type, (pid, info) => pid === link.id && fn(info));
        else add(bus, type, (m, from) => from === link.id && fn(m));
      },
      send(obj) { const s = sess(); return !!s && s.connected && s.send(obj) === true; },
      get status() { const s = sess(); return s ? s.status : { state: 'not_paired' }; },
      get hosting() { return false; },
      get server() { return null; },
    };
    return link;
  };
  hub.from = (id, m) => { for (const fn of bus.get(m.t) || []) fn(m, id); };
  hub.peerEvent = (type, id) => { for (const fn of peer.get(type) || []) fn(id, {}); };
  return hub;
}

// The parts of windows/sound.js and linux/sound.js that decide: welcome resets what the other side said,
// a policy only on a change, want = connected && send && they accept, our policy told on apply.
class FakeSound {
  constructor({ link, settings, meshHub }) {
    Object.assign(this, { link, settings, meshHub });
    this.macAccepts = false;
    this.sending = false;
    this.applied = 0;
    this.welcomed = 0;
    this.heard = [];
    link.on('welcome', () => { this.welcomed++; this.macAccepts = false; this.apply(); });
    link.on('closed', () => { this.macAccepts = false; this.sending = false; });
    link.on('audio.policy', (m) => {
      if ((m.accept === true) === this.macAccepts) return;
      this.macAccepts = m.accept === true;
      this.apply();
    });
    link.on('audio.offer', (m) => this.heard.push(m));
  }

  _on(key) {
    const c = this.link.current;
    const pair = this.meshHub.consent; // each device's own pair, as sound.js reads it
    return pair && c ? !!pair.get(c.deviceId, 'audio', key === 'send' ? 'out' : 'in') : !!this.settings.audio[key];
  }

  apply() {
    this.applied++;
    const connected = this.link.status.state === 'connected';
    if (connected) this.link.send({ t: 'audio.policy', accept: this._on('receive') });
    this.sending = connected && this._on('send') && this.macAccepts;
  }

  view() {
    return { receiving: false, sending: this.sending, error: '', macAccepts: this.macAccepts };
  }
}

const settingsWith = (audio, pairSync = {}) => ({ audio: { send: true, receive: true, ...audio }, pairSync });

// A Sound per connected device, told 'welcome' when made; each hears only its own device.
{
  const hub = fakeHub([{ id: 'ryzen', name: 'Ryzen9' }, { id: 'amx', name: 'AMX' }]);
  const set = new SoundSet({ Sound: FakeSound, hub, settings: settingsWith({}), onChange: () => {} });
  const r = set.byId.get('ryzen'), a = set.byId.get('amx');
  assert.ok(r && a && r !== a);
  assert.strictEqual(r.welcomed, 1);
  assert.strictEqual(a.welcomed, 1);
  assert.strictEqual(r.link.current.deviceId, 'ryzen');
  assert.strictEqual(r.link.current.name, 'Ryzen9');
  hub.from('ryzen', { t: 'audio.offer', session: 1 });
  assert.strictEqual(r.heard.length, 1);
  assert.strictEqual(a.heard.length, 0, 'AMX’s Sound doesn’t hear Ryzen9');
  // Our policy went to each device, from its own Sound.
  assert.ok(hub.sent.some(([id, m]) => id === 'ryzen' && m.t === 'audio.policy'));
  assert.ok(hub.sent.some(([id, m]) => id === 'amx' && m.t === 'audio.policy'));
}

// Several devices take our sound at once, none of them selected; a device whose switch is off doesn't.
{
  const hub = fakeHub([{ id: 'ryzen' }, { id: 'amx' }, { id: 'mac', os: 'mac' }]);
  hub.selectedId = 'mac';
  const settings = settingsWith({ send: false }, { ryzen: { audio: { out: true, in: true } }, amx: { audio: { out: true, in: true } } });
  hub.consent = consent({ features: { audio: { out: ['audio', 'send'], in: ['audio', 'receive'] } }, settings: () => settings, selectedId: () => hub.selectedId }); // as mesh/main.js
  const set = new SoundSet({ Sound: FakeSound, hub, settings, onChange: () => {} });
  for (const id of ['ryzen', 'amx', 'mac']) hub.from(id, { t: 'audio.policy', accept: true });
  assert.strictEqual(set.byId.get('ryzen').sending, true);
  assert.strictEqual(set.byId.get('amx').sending, true);
  assert.strictEqual(set.byId.get('mac').sending, false, 'the Mac’s switch (settings.audio: it is selected) is off');
  // The shadow reads it as it is.
  const lines = [];
  const sh = new MeshShadow({ hub, kvm: () => null, sound: () => set, mic: () => null, settings: () => settings, log: (l) => lines.push(l), os: 'linux' });
  sh.tick();
  assert.ok(lines.some((l) => l.includes('[graph] sound: would amx, ryzen (mac: Send is off for it) | does amx, ryzen, sending')), lines.join('\n'));
}

// The graph's limit: 8 devices take it, 6 get it (the id decides, the same everywhere).
{
  const ids = Array.from({ length: 8 }, (_, i) => 'd' + i);
  const hub = fakeHub(ids.map((id) => ({ id })));
  const set = new SoundSet({ Sound: FakeSound, hub, settings: settingsWith({}), onChange: () => {} });
  for (const id of ids) hub.from(id, { t: 'audio.policy', accept: true });
  assert.deepStrictEqual(ids.filter((id) => set.byId.get(id).sending), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);
}

// A new selection re-applies every edge (settings.audio is that device's pair now); another change doesn't.
{
  const hub = fakeHub([{ id: 'a' }, { id: 'b' }]);
  const set = new SoundSet({ Sound: FakeSound, hub, settings: settingsWith({}), onChange: () => {} });
  const before = [...set.byId.values()].map((s) => s.applied);
  hub.emit('change');
  assert.deepStrictEqual([...set.byId.values()].map((s) => s.applied), before, 'no selection change: nothing applied');
  hub.selectedId = 'b';
  hub.emit('change');
  assert.deepStrictEqual([...set.byId.values()].map((s) => s.applied), before.map((n) => n + 1));
}

// A device that comes later gets its Sound then, welcomed; one that leaves stops, and comes back welcomed.
{
  const hub = fakeHub([{ id: 'a' }]);
  const set = new SoundSet({ Sound: FakeSound, hub, settings: settingsWith({}), onChange: () => {} });
  hub.list.push({ ...hub.list[0], id: 'late', displayName: () => 'Late', send(m) { hub.sent.push(['late', m]); return true; } });
  hub.emit('peerAdded', 'late');
  const late = set.byId.get('late');
  assert.strictEqual(late.welcomed, 1);
  hub.from('late', { t: 'audio.policy', accept: true });
  assert.strictEqual(late.sending, true);
  hub.peerEvent('closed', 'late');
  assert.strictEqual(late.sending, false);
  hub.peerEvent('welcome', 'late');
  assert.strictEqual(late.welcomed, 2, 'the scoped link’s own welcome, on a reconnect');
  hub.emit('peerAdded', 'late');
  assert.strictEqual(set.byId.get('late'), late, 'the same Sound, not a second one');
}

// view(): the selected device's state (the Audio page shows one device), and every device in edges.
{
  const hub = fakeHub([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  hub.selectedId = 'b';
  const set = new SoundSet({ Sound: FakeSound, hub, settings: settingsWith({}), onChange: () => {} });
  hub.from('a', { t: 'audio.policy', accept: true });
  const v = set.view();
  assert.strictEqual(v.sending, false, 'B, the selected one, doesn’t take it');
  assert.deepStrictEqual(v.edges.map((e) => [e.id, e.sending, e.accepts]), [['a', true, true], ['b', false, false]]);
}

console.log('sound-mesh: all passed');
