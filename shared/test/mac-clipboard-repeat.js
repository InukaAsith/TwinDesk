'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol');
let text = '', read = async () => text;
const writeText = async value => { text = value; };
const picture = {
  isEmpty: () => false, getSize: () => ({ width: 4, height: 4 }),
  resize() { return this; }, toBitmap: () => Buffer.alloc(64, 8), toDataURL: () => '',
};
const clipboard = {
  readText: () => read(),
  writeText,
  readImage: async () => picture,
  writeImage: async () => { text = ''; },
};
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { clipboard, nativeImage: { createFromBuffer: () => picture } };
  return load.call(this, id, ...args);
};
const { Clipboard } = require('../../mac/clipboard');
test.after(() => { Module._load = load; });
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  text = '';
  read = async () => text;
  clipboard.writeText = writeText;
  const sent = [], server = Object.assign(new EventEmitter(), { current: { name: 'peer' }, sendToClient: m => sent.push(m) });
  const helper = Object.assign(new EventEmitter(), { request: async () => ({}), send() {} });
  const settings = { clipboard: { enabled: true, send: true, receive: true, maxKB: 1024, historySize: 10, images: true, mode: 'instant' }, files: {} };
  const c = new Clipboard(server, helper, () => settings);
  const copies = () => sent.filter(m => m.t === P.T.CLIP).map(m => m.text);
  return { c, server, helper, settings, copies };
}

test('repeat, reconnect and stale read after incoming text', async () => {
  const { c, server, helper, copies } = setup();
  text = 'A'; await c.sendIfChanged('request');
  await c._onClip({ text: 'B' }); await c.sendIfChanged('request');
  server.emit('client', server.current); await c.sendIfChanged('request');
  text = 'A'; await c.sendIfChanged('request');
  assert.deepEqual(copies(), ['A', 'A'], 'repeat after remote copy; no echo after reconnect');

  let release, entered;
  const atHelper = new Promise(resolve => { entered = resolve; });
  helper.request = () => new Promise(resolve => { release = resolve; entered(); });
  text = 'old'; const pending = c.sendIfChanged('request'); await atHelper;
  await c._onClip({ text: 'new' }); release({}); await pending;
  assert.deepEqual(copies(), ['A', 'A'], 'stale read does not overwrite incoming copy');
  assert.equal(text, 'new');

  let finishRead, readStarted;
  const atRead = new Promise(resolve => { readStarted = resolve; });
  read = () => new Promise(resolve => { finishRead = resolve; readStarted(); });
  const incoming = c._onClip({ text: 'newer' }); await atRead;
  c.applySettings(); finishRead('new'); await incoming;
  assert.equal(text, 'newer', 'settings refresh does not cancel receive');
  assert.equal(c.lastReceived, 'newer');
});

test('pending text does not echo after a picture replaces it', async () => {
  const { c, helper, copies } = setup();
  text = 'old';
  await c.sendIfChanged('request');
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  const pending = c.sendIfChanged('request');
  await tick();

  const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(24), 'hex');
  c.images.header({ t: P.T.CLIP_IMAGE, id: 'pic', w: 4, h: 4, png: png.toString('base64') });
  await tick();
  assert.equal(c.lastSent, null);
  release({});
  await pending;
  assert.deepEqual(copies(), ['old']);
});

test('one watcher event during a receive still sends the local copy', async () => {
  for (const outcome of ['written', 'unchanged', 'failed']) {
    const { c, helper, copies } = setup();
    text = 'old';
    await c.sendIfChanged('request');
    let release;
    if (outcome === 'written') {
      clipboard.writeText = value => {
        text = value;
        return new Promise(resolve => { release = resolve; });
      };
    } else if (outcome === 'failed') {
      clipboard.writeText = () => new Promise((_, reject) => { release = reject; });
    } else {
      read = () => new Promise(resolve => { release = resolve; });
    }
    const incoming = c._onClip({ text: outcome === 'unchanged' ? 'old' : 'remote' });
    await tick();
    text = 'user-copy';
    helper.emit('event', 'clipboard', {});
    read = async () => text;
    if (outcome === 'failed') {
      release(new Error('write failed'));
      await assert.rejects(incoming, /write failed/);
    } else {
      release('old');
      await incoming;
    }
    await tick();
    assert.deepEqual(copies(), ['old', 'user-copy'], outcome);
    assert.equal(c.receiving, 0);
  }
});

test('a request just before or during a receive does not lose a copy being read', async () => {
  for (const when of ['before', 'during']) {
    const { c, helper, copies } = setup();
    const waiting = [];
    helper.request = () => new Promise(resolve => waiting.push(resolve));
    text = 'important';
    const pending = c.sendIfChanged('instant');
    await tick();
    const early = when === 'before' ? c.sendIfChanged('request') : null;
    await tick();
    let fail;
    read = () => new Promise((_, reject) => { fail = reject; });
    const incoming = c._onClip({ text: 'remote' });
    await tick();
    if (when === 'during') await c.sendIfChanged('request');
    for (const resolve of waiting.splice(0)) resolve({});
    await Promise.all([pending, early]);
    read = async () => text;
    fail(new Error('read failed')); // the receive ends with nothing written
    await assert.rejects(incoming, /read failed/);
    await tick();
    for (const resolve of waiting.splice(0)) resolve({});
    await tick();
    assert.deepEqual(copies(), ['important'], when);
  }
});

test('a switch during a receive sends the clipboard once the receive is over', async () => {
  const { c, settings, copies } = setup();
  settings.clipboard.mode = 'switch';
  text = 'mine';
  let fail;
  read = () => new Promise((_, reject) => { fail = reject; });
  const incoming = c._onClip({ text: 'remote' });
  await tick();
  await c.sendIfChanged('switch');
  assert.deepEqual(copies(), []);
  read = async () => text;
  fail(new Error('read failed'));
  await assert.rejects(incoming, /read failed/);
  await tick();
  assert.deepEqual(copies(), ['mine']);
});

test('a copy held back during a receive is not sent once the mode is no longer instant', async () => {
  const { c, helper, settings, copies } = setup();
  let fail;
  read = () => new Promise((_, reject) => { fail = reject; });
  const incoming = c._onClip({ text: 'remote' });
  await tick();
  text = 'user-copy';
  helper.emit('event', 'clipboard', {});
  settings.clipboard.mode = 'switch';
  read = async () => text;
  fail(new Error('read failed'));
  await assert.rejects(incoming, /read failed/);
  await tick();
  assert.deepEqual(copies(), []);
  assert.equal(c.pending, null);
});

test('a phone echo does not overwrite a local copy waiting on the helper', async () => {
  const { c, helper, copies } = setup();
  text = 'A';
  await c.sendIfChanged('request');
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  text = 'B';
  const outgoing = c.sendIfChanged('request');
  await tick();
  await c._onClip({ text: 'A' });
  release({});
  await outgoing;
  assert.deepEqual(copies(), ['A', 'B']);
  assert.equal(text, 'B');
  assert.notEqual(c.lastReceived, 'A');
  assert.equal(c.receiving, 0);
  assert.equal(c.readsInFlight, 0);
});

test('an idle phone echo records the receive without writing', async () => {
  const { c } = setup();
  text = 'A';
  await c.sendIfChanged('request');
  clipboard.writeText = () => assert.fail('unchanged clipboard was written');
  await c._onClip({ text: 'A' });
  assert.equal(c.lastReceived, 'A');
});

test('a phone echo does not cancel a receive holding back a local read', async () => {
  const { c } = setup();
  text = 'A';
  await c.sendIfChanged('request');
  let release;
  read = () => new Promise(resolve => { release = resolve; });
  const incoming = c._onClip({ text: 'remote' });
  await c.sendIfChanged('request');
  assert.equal(c.pending, 'request');
  read = async () => text;
  await c._onClip({ text: 'A' });
  release('A');
  await incoming;
  await tick();
  assert.equal(text, 'remote');
  assert.equal(c.lastReceived, 'remote');
  assert.equal(c.receiving, 0);
});

test('outgoing reads release their count after an early return or rejection', async () => {
  const { c } = setup();
  text = 'A';
  await c.sendIfChanged('request');
  await c.sendIfChanged('request');
  assert.equal(c.readsInFlight, 0, 'unchanged text');
  read = async () => { throw new Error('read failed'); };
  await assert.rejects(c.sendIfChanged('request'), /read failed/);
  assert.equal(c.readsInFlight, 0, 'failed read');
});

// Queued and live pastes share the same receive fence.
function queueSetup() {
  const s = setup();
  const ws = { readyState: 1 };
  const ctx = { name: 'peer', ws, released: false };
  s.settings.clipboard.queue = true;
  s.settings.clipboard.queueLatest = true;
  Object.assign(s.server, { current: ctx, send: () => true, outbound: () => ws });
  s.c.paired = () => 'pair';
  const paste = () => s.c._onQueue({ t: P.T.CLIP_QUEUE, items: [{ text: 'queued', at: 1 }] }, ctx, ws);
  return { ...s, ws, paste };
}

test('a queued paste fences an older outgoing read', async () => {
  const { c, helper, copies, paste } = queueSetup();
  text = 'old';
  let release;
  helper.request = () => new Promise(resolve => { release = resolve; });
  const outgoing = c.sendIfChanged('request');
  await tick();
  await paste();
  release({});
  await outgoing;
  helper.request = async () => ({});
  await c.sendIfChanged('request');
  assert.equal(text, 'queued');
  assert.deepEqual(copies(), [], 'neither the older text nor the pasted one is sent');
  assert.equal(c.receiving, 0);
});

test('a copy made during a queued paste is still sent', async () => {
  const { c, helper, copies, paste } = queueSetup();
  let release;
  clipboard.writeText = value => {
    text = value;
    return new Promise(resolve => { release = resolve; });
  };
  const pasting = paste();
  await tick();
  assert.equal(c.receiving, 1);
  text = 'user-copy';
  helper.emit('event', 'clipboard', {});
  release();
  await pasting;
  await tick();
  assert.deepEqual(copies(), ['user-copy']);
  assert.equal(c.receiving, 0);
});

test('a queued paste whose socket closed during the read leaves the clipboard alone', async () => {
  const { c, ws, paste } = queueSetup();
  let release;
  read = () => new Promise(resolve => { release = resolve; });
  const pasting = paste();
  await tick();
  text = 'mine';
  ws.readyState = 3;
  release('');
  await pasting;
  assert.equal(text, 'mine');
  assert.equal(c.lastReceived, null);
  assert.equal(c.receiving, 0);
});

test('a live clip that overtakes a queued paste wins', async () => {
  const { c, copies, paste } = queueSetup();
  let release;
  read = () => new Promise(resolve => { release = resolve; });
  const pasting = paste();
  await tick();
  read = async () => text;
  await c._onClip({ text: 'live' });
  release('');
  await pasting;
  assert.equal(text, 'live');
  assert.equal(c.lastReceived, 'live');
  assert.deepEqual(copies(), []);
  assert.equal(c.receiving, 0);
});

test('a queued paste that overtakes a live clip wins', async () => {
  const { c, paste } = queueSetup();
  let release;
  read = () => new Promise(resolve => { release = resolve; });
  const incoming = c._onClip({ text: 'live' });
  await tick();
  read = async () => text;
  await paste();
  release('');
  await incoming;
  assert.equal(text, 'queued');
  assert.equal(c.lastReceived, 'queued');
});

test('a live picture that overtakes a queued paste wins', async () => {
  const { c, paste } = queueSetup();
  text = 'before';
  let release;
  read = () => new Promise(resolve => { release = resolve; });
  const pending = paste();
  await tick();
  const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(24), 'hex');
  c.images.header({ t: P.T.CLIP_IMAGE, id: 'pic', w: 4, h: 4, png: png.toString('base64') });
  await tick();
  release('before');
  await pending;
  assert.equal(text, '', 'the picture remains on the clipboard');
});
