// Fake network for the pool tests (clip-pool.js, notifs-pool.js): devices with their own Mesh and a
// bus with the same shape the app gives Clip and Notifs, joined by direct links. Messages go into one
// FIFO queue and are delivered by run(); a delivery to a device runs its handlers, then the event
// loop is flushed so async handlers finish before the next message. A legacy device is an old
// one-to-one app: no Mesh, it only records what it gets.
'use strict';

const { EventEmitter } = require('events');
const { Mesh } = require('../../../shared/mesh.js');

const clone = (m) => JSON.parse(JSON.stringify(m));
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Net {
  constructor() {
    this.devices = new Map();
    this.adj = new Map(); // id -> Set of directly linked ids
    this.queue = [];
    this.log = []; // every message accepted by a link: {from, to, t, msg}
  }

  add(id, opts = {}) {
    const dev = {
      id,
      name: opts.name || id,
      legacy: !!opts.legacy,
      mesh: opts.legacy ? null : new Mesh({ selfId: id }),
      handlers: new Map(),
      peerHandlers: new Map(),
      selected: null,
      received: [], // legacy devices only: {from, msg}
    };
    dev.bus = this._bus(dev);
    this.devices.set(id, dev);
    this.adj.set(id, new Set());
    return dev;
  }

  _bus(dev) {
    const net = this;
    return {
      on(type, fn) {
        if (!dev.handlers.has(type)) dev.handlers.set(type, []);
        dev.handlers.get(type).push(fn);
      },
      onPeer(event, fn) {
        if (!dev.peerHandlers.has(event)) dev.peerHandlers.set(event, []);
        dev.peerHandlers.get(event).push(fn);
      },
      send: (to, msg) => net._send(dev.id, to, msg),
      selectedId: () => dev.selected,
      connectedIds: () => Array.from(net.adj.get(dev.id)),
    };
  }

  linked(a, b) {
    return this.adj.get(a).has(b);
  }

  _send(from, to, msg) {
    if (!this.linked(from, to)) return false;
    this.log.push({ from, to, t: msg.t, msg: clone(msg) });
    this.queue.push({ from, to, msg: clone(msg) });
    return true;
  }

  // Both sides learn about the link (mesh entries), then both get 'welcome' (like the app does).
  connect(a, b) {
    const da = this.devices.get(a);
    const db = this.devices.get(b);
    this.adj.get(a).add(b);
    this.adj.get(b).add(a);
    for (const [x, y] of [[da, db], [db, da]]) {
      if (x.mesh) {
        x.mesh.addPeer({ id: y.id, name: y.name, os: 'win', mesh: !y.legacy, send: (msg) => this._send(x.id, y.id, msg) });
      }
    }
    for (const [x, y] of [[da, db], [db, da]]) this._emitPeer(x, 'welcome', y.id);
    return this;
  }

  disconnect(a, b) {
    const da = this.devices.get(a);
    const db = this.devices.get(b);
    this.adj.get(a).delete(b);
    this.adj.get(b).delete(a);
    for (const [x, y] of [[da, db], [db, da]]) {
      if (x.mesh) x.mesh.removePeer(y.id);
      this._emitPeer(x, 'closed', y.id);
    }
    return this;
  }

  _emitPeer(dev, event, peerId) {
    if (dev.legacy) return;
    for (const fn of dev.peerHandlers.get(event) || []) fn(peerId, {});
  }

  // Deliver everything queued, including what the handlers queue meanwhile.
  async run() {
    while (this.queue.length) {
      const item = this.queue.shift();
      if (!this.linked(item.from, item.to)) continue; // the link went down: the message is lost
      const dev = this.devices.get(item.to);
      if (dev.legacy) {
        dev.received.push({ from: item.from, msg: item.msg });
      } else {
        for (const fn of dev.handlers.get(item.msg.t) || []) fn(item.msg, item.from);
      }
      await flush();
    }
    await flush();
  }

  // Messages of one type sent from a device (optionally to one device).
  sent(t, from, to) {
    return this.log.filter((e) => e.t === t && (from === undefined || e.from === from) && (to === undefined || e.to === to));
  }
}

// Clipboard fake: readText/writeText as Electron's, writes records what the app wrote here.
function fakeClipboard() {
  return {
    text: '',
    writes: [],
    concealed: false,
    readText() { return this.text; },
    writeText(t) { this.text = t; this.writes.push(t); },
    readBuffer(format) {
      if (this.concealed && format === 'ExcludeClipboardContentFromMonitorProcessing') return Buffer.alloc(1);
      return Buffer.alloc(0);
    },
    has() { return false; },
  };
}

// Helper fake: an event emitter with the request() the notifications use; records the watch flag.
class FakeHelper extends EventEmitter {
  constructor() {
    super();
    this.running = true;
    this.watches = [];
  }

  request(name, args) {
    if (name === 'notifWatch') this.watches.push(args);
    return Promise.resolve({ readable: true });
  }
}

// Notification class for one device: shown toasts are recorded in dev.toasts.
function fakeNotificationFor(dev) {
  dev.toasts = [];
  return class FakeNotification {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
    }

    static isSupported() { return true; }

    on(ev, fn) { this.handlers[ev] = fn; }

    show() { dev.toasts.push(this); }
  };
}

module.exports = { Net, fakeClipboard, FakeHelper, fakeNotificationFor, flush };
