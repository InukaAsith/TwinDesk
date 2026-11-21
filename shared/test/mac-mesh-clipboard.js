// Mesh clipboard on the Mac: a read that started before an incoming clip must not publish, and
// a copy made here while a clip arrives is still sent. Run: node shared/test/mac-mesh-clipboard.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');

function picture() {
  const bitmap = Buffer.alloc(16 * 16 * 4, 8);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 4, height: 4 }),
    resize() { return this; },
    toBitmap: () => bitmap,
    toDataURL: () => 'data:image/png;base64,xx',
  };
}

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { clipboard: {}, nativeImage: { createFromBuffer: () => picture() } };
  return load.call(this, id, ...args);
};
const { Clip } = require('../../mac/mesh/clipboard.js');
test.after(() => { Module._load = load; });

function setup() {
  const published = [];
  const mesh = new Mesh({ selfId: 'mac' });
  mesh.addPeer({ id: 'peer', name: 'Phone', mesh: true, send: (msg) => { published.push(msg); return true; } });
  const peers = { welcome: [], closed: [] };
  let ids = ['peer'];
  const bus = {
    on() {},
    onPeer(event, fn) { (peers[event] ??= []).push(fn); },
    send() { return true; },
    connectedIds() { return ids.slice(); },
    selectedId() { return ids[0] || null; },
    peer(event, id) { for (const fn of peers[event]) fn(id); },
    setIds(next) { ids = next.slice(); },
  };
  const clipboard = {
    text: '',
    writes: [],
    readText() { return clipboard.text; },
    writeText(value) { clipboard.text = String(value); clipboard.writes.push(clipboard.text); },
  };
  const helper = Object.assign(new EventEmitter(), {
    running: true,
    send() {},
    request: async () => ({ concealed: false }),
  });
  const settings = { clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20 } };
  const clip = new Clip({ bus, mesh, getSettings: () => settings, clipboard, helper });
  const texts = () => published.filter((m) => m.t === P.T.CLIP).map((m) => m.text);
  return { clip, clipboard, helper, bus, mesh, texts, settings };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('repeat and no echo', async () => {
  const { clip, clipboard, texts } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('instant');
  await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
  assert.equal(clipboard.text, 'B');
  assert.equal(clip.lastSync.sent, null, 'an incoming clip clears what was sent');
  assert.equal(clip.lastSync.received, 'B');
  await clip.sendIfChanged('instant');
  assert.deepEqual(texts(), ['A'], 'the text just received is not sent back');
  clipboard.text = 'A';
  await clip.sendIfChanged('instant');
  assert.deepEqual(texts(), ['A', 'A'], 'the same text copied again after an incoming clip is sent again');
});

test('stale read after incoming text', async () => {
  const { clip, clipboard, texts } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('instant');
  const reads = [];
  clip._readText = () => new Promise((resolve) => reads.push(resolve));
  const pending = clip.sendIfChanged('instant');
  await tick();
  assert.equal(reads.length, 1);
  const incoming = clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
  await tick();
  assert.equal(reads.length, 2);
  reads[1]('A');
  await incoming;
  assert.equal(clipboard.text, 'B');
  assert.equal(clip.lastSync.sent, null);
  assert.equal(clip.lastSync.received, 'B');
  reads[0]('A');
  await pending;
  assert.deepEqual(texts(), ['A'], 'a stale read of A does not publish after B clears the sent marker');
  clip._readText = async () => clipboard.text;
  clipboard.text = 'A';
  await clip.sendIfChanged('instant');
  assert.deepEqual(texts(), ['A', 'A'], 'fencing the stale read still lets the next copy of A through');
});

test('stale read awaiting helper after incoming text', async () => {
  const { clip, clipboard, helper, texts } = setup();
  clipboard.text = 'A';
  let release;
  let entered;
  const atHelper = new Promise((resolve) => { entered = resolve; });
  helper.request = () => new Promise((resolve) => { release = resolve; entered(); });
  const pending = clip.sendIfChanged('request');
  await atHelper;
  await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
  release({ concealed: false });
  await pending;
  assert.deepEqual(texts(), [], 'a read that already passed the sent check does not publish after B arrives');
  assert.equal(clipboard.text, 'B');
  assert.equal(clip.lastSync.sent, null);
  clipboard.text = 'A';
  helper.request = async () => ({ concealed: false });
  await clip.sendIfChanged('request');
  assert.deepEqual(texts(), ['A'], 'the next copy of A still sends');
});

test('a device coming back during a read or a receive loses neither', async () => {
  const { clip, clipboard, bus, texts } = setup();
  clipboard.text = 'A';
  const reads = [];
  clip._readText = () => new Promise((resolve) => reads.push(resolve));
  const pending = clip.sendIfChanged('instant');
  bus.peer('closed', 'peer');
  bus.peer('welcome', 'peer');
  reads[0]('A');
  await pending;
  assert.deepEqual(texts(), ['A'], 'the copy read while the device reconnected is sent');
  const incoming = clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
  bus.peer('closed', 'peer');
  bus.peer('welcome', 'peer');
  reads[1]('A');
  await incoming;
  assert.equal(clipboard.text, 'B', 'the clip that arrived before the device reconnected is applied');
  assert.equal(clip.lastSync.received, 'B');
  clip._readText = async () => clipboard.text;
  await clip.sendIfChanged('instant');
  assert.deepEqual(texts(), ['A'], 'the text just received is not sent back after the session change');
});

test('stale read after incoming picture', async () => {
  const { clip, clipboard, texts, settings } = setup();
  settings.clipboard.images = true;
  clipboard.text = 'old';
  clipboard.readImage = async () => picture();
  await clip.sendIfChanged('instant');
  assert.deepEqual(texts(), ['old']);
  const reads = [];
  clip._readText = () => new Promise((resolve) => reads.push(resolve));
  const pending = clip.sendIfChanged('instant');
  await tick();
  assert.equal(reads.length, 1, 'the text read is in flight');
  let releaseWrite;
  clipboard.writeImage = () => new Promise((resolve) => { releaseWrite = resolve; });
  const png = Buffer.alloc(32, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  clip.images.header({ t: P.T.CLIP_IMAGE, id: 'pic', w: 2, h: 2, png: png.toString('base64') }, 'peer');
  assert.equal(typeof releaseWrite, 'function', 'the incoming picture reached the clipboard write');
  releaseWrite();
  await tick();
  assert.equal(clip.lastSync.sent, null, 'the incoming picture cleared what was sent');
  reads[0]('old');
  await pending;
  assert.deepEqual(texts(), ['old'], 'a pending text read does not send old after an incoming picture replaced it');
});

function incomingPicture(clip) {
  const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(24), 'hex');
  clip.images.header({ t: P.T.CLIP_IMAGE, id: 'pic', w: 4, h: 4, png: png.toString('base64') }, 'peer');
}

test('finishing an earlier picture preserves newer incoming text', async () => {
  const { clip, clipboard, settings } = setup();
  settings.clipboard.images = true;
  clipboard.writeImage = async () => {};
  let finishPicture, finishText;
  clipboard.readImage = () => new Promise(resolve => { finishPicture = resolve; });
  clip._readText = () => new Promise(resolve => { finishText = resolve; });
  incomingPicture(clip);
  await tick();
  const incoming = clip._onClip({ t: P.T.CLIP, text: 'after-pic' }, 'peer');
  finishPicture(picture());
  await tick();
  finishText('');
  await incoming;
  assert.equal(clipboard.text, 'after-pic');
  assert.equal(clip.lastSync.received, 'after-pic');
  assert.equal(clip.history[0].text, 'after-pic');
});

test('one watcher event during picture readback still sends the local copy', async () => {
  const { clip, clipboard, helper, texts, settings } = setup();
  settings.clipboard.images = true;
  clipboard.writeImage = async () => {};
  let finishPicture;
  clipboard.readImage = () => new Promise(resolve => { finishPicture = resolve; });
  incomingPicture(clip);
  await tick();
  clipboard.text = 'user-after-pic';
  helper.emit('event', 'clipboard', {});
  await tick();
  finishPicture({ isEmpty: () => true });
  await tick();
  assert.deepEqual(texts(), ['user-after-pic']);
  assert.equal(clip.receiving, 0);
});

test('an older outgoing helper read cannot overwrite a newer local copy', async () => {
  const { clip, clipboard, helper, texts } = setup();
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  clipboard.text = 'old';
  const pending = clip.sendIfChanged('request');
  await tick();
  clipboard.text = 'new';
  await clip.sendIfChanged('instant');
  release({ concealed: false });
  await pending;
  assert.deepEqual(texts(), ['new']);
});

test('an incoming clip does not read a Universal Clipboard item', async () => {
  const { clip, clipboard } = setup();
  let reads = 0;
  clip._readText = async () => { reads += 1; return clipboard.text; };
  clip.onLocalCopy({ remote: true });
  await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
  assert.equal(reads, 0, 'reading it would fetch it from the other Apple device');
  assert.equal(clipboard.text, 'B');
});

test('a request just before or during a receive does not lose a copy being read', async () => {
  for (const when of ['before', 'during']) {
    const { clip, clipboard, texts } = setup();
    clipboard.text = 'important';
    const reads = [];
    clip._readText = () => new Promise((resolve, reject) => reads.push({ resolve, reject }));
    const pending = clip.sendIfChanged('instant');
    const early = when === 'before' ? clip.sendIfChanged('request') : null;
    const incoming = clip._onClip({ t: P.T.CLIP, text: 'remote' }, 'peer');
    if (when === 'during') await clip.sendIfChanged('request');
    const failing = reads.pop();
    for (const r of reads.splice(0)) r.resolve('important');
    await Promise.all([pending, early]);
    failing.reject(new Error('read failed')); // the receive ends with nothing written
    await assert.rejects(incoming, /read failed/);
    assert.equal(reads.length, 1, 'the held-back call runs again');
    reads[0].resolve('important');
    await tick();
    assert.deepEqual(texts(), ['important'], when);
  }
});

test('a queued paste fences an older outgoing read', async () => {
  const { clip, clipboard, helper, settings, texts } = setup();
  settings.clipboard.queueLatest = true;
  const socket = {};
  clip.away.currentSocket = () => socket;
  clipboard.text = 'old';
  let finish;
  helper.request = () => new Promise(resolve => { finish = resolve; });
  const outgoing = clip.sendIfChanged('request');
  await tick();

  await clip.away.receive({ items: [{ text: 'queued', at: 42 }] }, 'peer');
  finish({ concealed: false });
  await outgoing;
  assert.equal(clipboard.text, 'queued');
  assert.equal(clip.lastSync.received, 'queued');
  assert.deepEqual(texts(), []);
});

function queueSetup() {
  const s = setup();
  s.settings.clipboard.queueLatest = true;
  s.socket = {};
  s.clip.away.currentSocket = () => s.socket;
  s.paste = () => s.clip.away.receive({ items: [{ text: 'queued', at: 42 }] }, 'peer');
  return s;
}

test('a copy made during a queued paste is still sent', async () => {
  const { clip, clipboard, helper, texts, paste } = queueSetup();
  let release;
  clipboard.writeText = (value) => {
    clipboard.text = value;
    return new Promise((resolve) => { release = resolve; });
  };
  const pasting = paste();
  await tick();
  assert.equal(clip.receiving, 1);
  clipboard.text = 'user-copy';
  helper.emit('event', 'clipboard', {});
  release();
  await pasting;
  await tick();
  assert.deepEqual(texts(), ['user-copy']);
  assert.equal(clip.receiving, 0);
});

test('a queued paste whose socket changed during the read leaves the clipboard alone', async () => {
  const s = queueSetup();
  const { clip, clipboard, paste } = s;
  let release;
  clipboard.readText = () => new Promise((resolve) => { release = resolve; });
  const pasting = paste();
  await tick();
  clipboard.text = 'mine';
  s.socket = {};
  release('');
  await pasting;
  assert.equal(clipboard.text, 'mine');
  assert.equal(clip.lastSync.received, null);
  assert.equal(clip.receiving, 0);
});

test('a phone echo does not overwrite a local copy waiting on the helper', async () => {
  const { clip, clipboard, helper, texts } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('request');
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  clipboard.text = 'B';
  const outgoing = clip.sendIfChanged('request');
  await tick();
  await clip._onClip({ text: 'A' }, 'peer');
  release({});
  await outgoing;
  assert.deepEqual(texts(), ['A', 'B']);
  assert.equal(clipboard.text, 'B');
  assert.notEqual(clip.lastSync.received, 'A');
  assert.equal(clip.receiving, 0);
  assert.equal(clip.readsInFlight, 0);
});

test('an idle phone echo records the receive without writing', async () => {
  const { clip, clipboard } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('request');
  clipboard.writeText = () => assert.fail('unchanged clipboard was written');
  await clip._onClip({ text: 'A' }, 'peer');
  assert.equal(clip.lastSync.received, 'A');
});

test('a phone echo does not cancel a receive holding back a local read', async () => {
  const { clip, clipboard } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('request');
  let release;
  clip._readText = () => new Promise(resolve => { release = resolve; });
  const incoming = clip._onClip({ text: 'remote' }, 'peer');
  await clip.sendIfChanged('request');
  assert.equal(clip.pending, 'request');
  clip._readText = async () => clipboard.text;
  await clip._onClip({ text: 'A' }, 'peer');
  release('A');
  await incoming;
  await tick();
  assert.equal(clipboard.text, 'remote');
  assert.equal(clip.lastSync.received, 'remote');
  assert.equal(clip.receiving, 0);
});

test('outgoing reads release their count after an early return or rejection', async () => {
  const { clip, clipboard } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('request');
  await clip.sendIfChanged('request');
  assert.equal(clip.readsInFlight, 0, 'unchanged text');
  clip._readText = async () => { throw new Error('read failed'); };
  await assert.rejects(clip.sendIfChanged('request'), /read failed/);
  assert.equal(clip.readsInFlight, 0, 'failed read');
});

test('a mesh device copying the text last sent is a copy, also during a read', async () => {
  const { clip, clipboard, helper, texts } = setup();
  clipboard.text = 'A';
  await clip.sendIfChanged('request');
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  clipboard.text = 'B';
  const outgoing = clip.sendIfChanged('request');
  await tick();
  await clip._onClip({ t: P.T.CLIP, text: 'A', o: 'other', s: 1, d: ['mac'], h: 0, ts: Date.now() + 1000 }, 'peer');
  release({});
  await outgoing;
  assert.equal(clipboard.text, 'A');
  assert.equal(clip.lastSync.received, 'A');
  assert.deepEqual(texts(), ['A']);
  assert.equal(clip.readsInFlight, 0);
});

test('a live mesh clip that overtakes a queued paste wins', async () => {
  const { clip, clipboard } = setup();
  let release;
  clip._readText = () => new Promise(resolve => { release = resolve; });
  const pending = clip.away.applyLatest('queued', () => true);
  await tick();
  clip._readText = async () => clipboard.text;
  await clip._onClip({ t: P.T.CLIP, text: 'live' }, 'peer');
  release('');
  await pending;
  assert.deepEqual(clipboard.writes, ['live']);
  assert.equal(clip.lastSync.received, 'live');
});
