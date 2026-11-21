// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const code = fs.readFileSync(path.join(__dirname, '../phoneview-renderer.js'), 'utf8');

function fixture(kind = 'app') {
  const events = new Map(), handlers = new Map(), decoders = [], sent = [], painted = [];
  const controls = new Map();
  const canvas = {
    width: 100, height: 200, style: {}, focus() {}, addEventListener() {},
    getContext: () => ({ drawImage: (frame) => painted.push(frame.id) }),
  };
  const element = () => ({ hidden: true, style: {}, classList: { add() {}, toggle() {} },
    setAttribute() {}, addEventListener() {} });
  const nodes = { screen: canvas, stage: { clientWidth: 400, clientHeight: 800 }, status: element(), title: element() };
  let recording = false;
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.chunks = (this.chunks || []).concat(chunk); }
    close() { this.state = 'closed'; }
  }
  const api = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    send: m => sent.push(JSON.parse(JSON.stringify(m))),
  };
  const rail = {
    controls: ['shot', 'rec'].map(k => {
      const el = {
        onclick() { controls.set(`${k}:after`, painted.slice()); },
        addEventListener: (_event, fn) => controls.set(k, fn),
      };
      return { k, el };
    }),
    mount() {}, recording: () => recording,
  };
  const window = { phoneview: api,
    PlayerI18n: { translate() {}, text() {}, literal() {}, t: key => key, onChange() {} },
    addEventListener: (name, fn) => events.set(name, fn),
    MirrorRail: () => rail,
  };
  vm.runInNewContext(code, {
    window, document: { body: element(), getElementById: key => nodes[key] || null, querySelector: () => element(), addEventListener() {} },
    location: { search: '?kind=' + kind }, URLSearchParams, devicePixelRatio: 2, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data); } },
    ResizeObserver: class { observe() {} }, performance: { now: () => 5000 }, console,
    setTimeout, clearTimeout,
  });
  const recv = (name, value) => { for (const fn of handlers.get(name) || []) fn(value); };
  const config = () => recv('video', { config: true, data: Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0x1f]) });
  const frame = id => ({ id, displayWidth: 300, displayHeight: 600, closed: 0, close() { this.closed++; } });
  return { recv, config, frame, canvas, decoders, sent, painted, events, controls, rail,
    record(on) { recording = on; }, output(f) { decoders.at(-1).callbacks.output(f); } };
}

test('minimized app retains one latest frame, restores static content and keeps recording current', () => {
  const f = fixture();
  f.config();
  const decoder = f.decoders[0];
  const visible = f.frame(1);
  f.output(visible);
  f.recv('opts', { minimized: true });
  f.recv('status', { appFrame: 'capture-7' });
  const first = f.frame(2), latest = f.frame(3);
  f.output(first);
  f.recv('video', { key: true, pts: 123, data: Uint8Array.of(1) });
  f.recv('video', { key: false, pts: 124, data: Uint8Array.of(2) });
  f.output(latest);
  assert.deepEqual(f.painted, [1]);
  assert.equal(visible.closed, 1);
  assert.equal(first.closed, 1, 'replaced decoded frame is released');
  assert.equal(latest.closed, 0);
  assert.deepEqual(decoder.chunks.map(chunk => chunk.timestamp), [123, 124], 'decode input continues in order while painting pauses');
  assert.deepEqual(f.sent, [{ t: 'appFrame', capture: 'capture-7' }], 'decoded frame readiness still reaches panel ownership');

  f.recv('opts', { minimized: false });
  assert.deepEqual(f.painted, [1, 3], 'static content repaints without another encoded frame');
  assert.equal(latest.closed, 1);

  f.recv('opts', { minimized: true });
  const screenshot = f.frame(4);
  f.output(screenshot);
  f.rail.controls.find(c => c.k === 'shot').el.onclick();
  assert.equal(screenshot.closed, 1);
  assert.equal(f.painted.at(-1), 4, 'screenshot paints held frame before onclick handler reads canvas');
  assert.equal(f.controls.get('shot:after').at(-1), 4, 'onclick sees the freshly painted frame');
  f.record(true);
  const recording = f.frame(5);
  f.output(recording);
  assert.equal(f.painted.at(-1), 5);
  assert.equal(recording.closed, 1, 'recording consumes continuously updated canvas');
});

test('closed or replaced capture releases held frames and camera or screen windows keep painting', () => {
  const f = fixture();
  f.config();
  const old = f.decoders[0];
  f.recv('opts', { minimized: true });
  const held = f.frame(1);
  f.output(held);
  f.config();
  assert.equal(held.closed, 1, 'new decoder releases old captured content');
  const late = f.frame(2);
  old.callbacks.output(late);
  assert.equal(late.closed, 1);
  assert.deepEqual(f.painted, []);
  const current = f.frame(3);
  f.output(current);
  f.recv('status', { closed: 'stopped' });
  f.recv('opts', { minimized: false });
  assert.equal(current.closed, 1);
  assert.deepEqual(f.painted, [], 'restore cannot paint retired content');
  const afterClose = f.frame(4);
  f.output(afterClose);
  assert.equal(afterClose.closed, 1);
  f.config();
  f.recv('opts', { minimized: true });
  const onUnload = f.frame(5);
  f.output(onUnload);
  f.events.get('beforeunload')();
  assert.equal(onUnload.closed, 1);

  for (const kind of ['screen', 'camera']) {
    const independent = fixture(kind);
    independent.config();
    independent.recv('opts', { minimized: true });
    const frame = independent.frame(1);
    independent.output(frame);
    assert.deepEqual(independent.painted, [1]);
    assert.equal(frame.closed, 1);
  }
});
