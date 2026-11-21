// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing: directions, switch/instant mode, concealed filter, size limit, clip.policy
// both ways, and the in-memory Recent list. Text here; pictures, screenshots put on the clipboard
// among them (Clipboard › Pictures, up to 10 MB), through shared/clipimage.js.
//
// Events: 'change' — this.view changed.
'use strict';

const { clipboard } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { ClipImages, trimPictures, itemView } = require('../shared/clipimage.js');
const { ClipQueue } = require('../shared/clipqueue.js');
const { keysLabel } = require('../shared/cursorlock.js');

// Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
const readText = async () => String((await clipboard.readText()) || '');
const PREVIEW = 300; // characters kept per history item for the UI

class Clipboard extends EventEmitter {
  constructor(server, helper, getSettings, paired = () => null) {
    super();
    this.server = server;
    this.helper = helper;
    this.getSettings = getSettings;
    this.lastSent = null;
    this.lastReceived = null;
    this.readSequence = 0;
    this.readsInFlight = 0;
    this.receiveSequence = 0;
    this.lastAppliedText = 0;
    this.receiving = 0;
    this.pending = null; // a sendIfChanged held back while a clip is received: its why
    this.concealed = false; // last helper report for the current item
    this.remote = false; // … and whether it came from another Apple device (Universal Clipboard, #211)
    this.peerAccepts = true; // the PC's last clip.policy
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size} or a picture (clipimage.js)
    this.lastSkip = '';
    this.queue = new ClipQueue();
    this.paired = paired;
    this.queueOwner = null;
    this.queueEpoch = 0;
    const ws = () => this.server.current && this.server.current.ws;
    this.images = new ClipImages({
      cfg: () => this.cfg,
      send: (m) => this.server.sendToClient(m),
      backlog: () => (ws() ? ws().bufferedAmount : 0),
      connected: () => !!this.server.current,
      ble: () => !!(this.server.current && this.server.current.transport === 'ble'),
      peerName: () => (this.server.current && this.server.current.name) || 'the other device',
      onReceiveStart: () => { ++this.receiving; ++this.receiveSequence; },
      onReceiveEnd: (written) => {
        if (written) ++this.readSequence;
        this._endReceive();
      },
      remember: (dir, item) => this._remember(dir, item),
      popup: (kind, text, presentation) => this.emit('popup', kind, presentation || text),
      onChange: () => this.emit('change'),
      pasteKeys: '⌘V',
    });

    server.on('client', (ctx) => {
      const pair = this.paired(ctx);
      if (pair !== this.queueOwner?.pair) this.queue.clear();
      this.queueOwner = pair ? { ctx, pair } : null;
      ++this.queueEpoch;
      this.peerAccepts = true;
      this.images.reset();
      this.sendPolicy();
      this._watch();
    });
    server.on('closed', () => {
      ++this.queueEpoch;
      this.checkQueuePair();
      this.images.reset();
      this._watch();
    });
    server.on(`t:${P.T.CLIP}`, (msg) => this._onClip(msg));
    server.on(`t:${P.T.CLIP_QUEUE}`, (msg, ctx, ws) => this._onQueue(msg, ctx, ws));
    server.on(`t:${P.T.CLIP_IMAGE}`, (msg) => this.images.header(msg));
    server.on(`t:${P.T.CLIP_IMAGE_PART}`, (msg) => this.images.part(msg));
    server.on(`t:${P.T.CLIP_POLICY}`, (msg, ctx, ws) => {
      this.peerAccepts = msg.accept !== false;
      this.images.policy(msg);
      if (msg.queue === true && msg.accept !== false) this._flushQueue(ctx, ws);
      this.emit('change');
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.sendIfChanged('request'));
    helper.on('event', (name, ev) => {
      if (name !== 'clipboard') return;
      ++this.queueEpoch;
      this.concealed = !!ev.concealed;
      this.remote = !!ev.remote;
      if (!this.server.current && !ev.initial && !ev.remote) return this._queueNow(); // nobody to send it to: queued
      // Instant mode sends new copies only, not what was already on the clipboard when it began.
      if (this.cfg.mode === 'instant' && !ev.initial) this.sendIfChanged('instant');
    });
    helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // Call after settings.clipboard changed (and once at start).
  applySettings() {
    const c = this.cfg;
    ++this.queueEpoch;
    if (!this._queueEnabled()) this.queue.clear();
    this._watch(true);
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this.sendPolicy();
    this.emit('change');
  }

  // The helper watches the clipboard (4 checks a second) only while a session could take a copy:
  // with nobody connected nothing would be sent (sendIfChanged), so nothing wakes the Mac for it.
  _watch(force = false) {
    const c = this.cfg;
    const on = !!(c.enabled && c.send && (this.server.current || (c.queue !== false && this.queueOwner))); // away: for the queue (shared/clipqueue.js)
    if (!force && on === this.watching) return;
    this.watching = on;
    this.helper.send('clipboardWatch', { on });
  }

  sendPolicy() {
    const c = this.cfg;
    this.server.sendToClient({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive), images: this.images.accept, queue: true }); // queue: clip.queue understood here
  }

  _remember(dir, item, at = Date.now()) {
    // What went out last is no longer on the other side once something came in, and the other way
    // round: copying it again must send it again (#223).
    if (dir === 'in') this.lastSent = null; else this.lastReceived = null;
    const n = this.cfg.historySize;
    if (!n) return;
    if (typeof item === 'string') {
      this.history = this.history.filter((h) => h.text !== item || h.dir !== dir);
      item = { text: item, size: Buffer.byteLength(item, 'utf8') };
    }
    this.history.unshift({ dir, at, ...item });
    if (this.history.length > n) this.history.length = n;
    trimPictures(this.history);
  }

  async _onClip(msg) {
    // The phone bridge can report our last send back while a newer local copy is being read.
    if (msg.text === this.lastSent && (this.readsInFlight || this.pending)) return;
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(msg.text)) return;
    ++this.queueEpoch;

    const sequence = ++this.receiveSequence;
    ++this.receiving;
    try {
      // A Universal Clipboard item isn't read to compare: reading it fetches it from the other device.
      const write = this.remote || (await readText()) !== msg.text;
      if (sequence !== this.receiveSequence) return; // a newer clip or picture came in meanwhile
      if (write) await clipboard.writeText(msg.text);
      // A newer clip may have been applied while this one was written.
      if (sequence < this.lastAppliedText) return;
      this.lastAppliedText = sequence;
      ++this.readSequence;
      this.images.text();
      this.lastReceived = msg.text;
      this._remember('in', msg.text);
      this.emit('change');
    } finally {
      this._endReceive();
    }
  }

  _endReceive() {
    if (--this.receiving || !this.pending) return;
    const why = this.pending;
    this.pending = null;
    if (why === 'instant' && this.cfg.mode !== 'instant') return;
    this.sendIfChanged(why).catch((e) => console.error('[clip] clipboard not sent:', e.message));
  }

  // Send our clipboard if allowed and changed since it was last sent or received: its text, else
  // its picture (Clipboard › Pictures).
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.server.current) return;
    if (!this.peerAccepts) return this._skip(`${this.server.current ? this.server.current.name : 'the other computer'} doesn’t take the clipboard`);
    // A Universal Clipboard copy from another Apple device: not read the moment it lands (that
    // fetches it from there, with macOS's "Pasting from …" dialog, #211); it goes on the switch.
    if (why === 'instant' && this.remote) return;
    // While a clip is being put on the clipboard nothing is read: the call runs again after it.
    const defer = () => {
      if (!this.receiving) return false;
      if (why !== 'instant' || !this.pending) this.pending = why;
      return true;
    };
    if (defer()) return;
    const sequence = ++this.readSequence;
    const valid = () => sequence === this.readSequence && this.server.current && this.cfg.enabled && this.cfg.send && this.peerAccepts && !defer();
    ++this.readsInFlight;
    try {
      return await this._readAndSend(why, valid);
    } finally {
      --this.readsInFlight;
    }
  }

  // The read itself, counted by sendIfChanged while it runs.
  async _readAndSend(why, valid) {
    const c = this.cfg;
    const text = await readText();
    if (!valid()) return;
    if (require('../shared/otp.js').isQuiet(text)) return; // a code copied by itself (Notifications): kept here only
    // Files copied in Finder: the clipboard also holds their names and icon, which aren't the copy.
    // Files go with the Files tab's shortcuts (fclip.js).
    const src = await this.helper.request('fileSource').catch(() => ({}));
    if (!valid()) return;
    if (src.files && src.files.length) {
      this.lastSent = text;
      const f = this.getSettings().files;
      return this._skip(f.shortcuts ? `files aren’t sent by ⌘C: copy them with ${keysLabel(f.copyKeys, 'mac')}, paste with ${keysLabel(f.pasteKeys, 'mac')}`
        : 'files aren’t sent by ⌘C: turn on the shortcuts in Files');
    }
    if (!text) return this._picture(why);
    if (text === this.lastSent || text === this.lastReceived) return;
    if (c.skipConcealed) {
      // The watcher's flag may be stale for a request; ask the helper about the current item.
      const info = why === 'instant' ? { concealed: this.concealed } : await this.helper.request('clipboardInfo').catch(() => ({}));
      if (!valid()) return;
      if (info.concealed) {
        this.lastSent = text; // don't retry this item
        return this._skip('skipped a password (concealed item)');
      }
    }
    if (Buffer.byteLength(text, 'utf8') > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSent = text;
      return this._skip(`skipped ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)} KB (over ${c.maxKB} KB)`);
    }
    this.lastSent = text;
    this.images.text();
    this.server.sendToClient({ t: P.T.CLIP, text });
    this._remember('out', text);
    this.lastSkip = '';
    this.emit('change');
  }

  // No text on the clipboard: its picture, if any.
  async _picture(why) {
    if (!this.images.canSend) return;
    let concealed = false;
    if (this.cfg.skipConcealed) {
      const info = why === 'instant' ? { concealed: this.concealed } : await this.helper.request('clipboardInfo').catch(() => ({}));
      concealed = !!info.concealed;
    }
    const r = await this.images.offerClipboard(concealed);
    if (r === 'sent') {
      this.lastSkip = '';
      this.emit('change');
    } else if (r) {
      this._skip(r);
    }
  }

  _skip(why) {
    if (this.lastSkip !== why) {
      this.lastSkip = why;
      this.emit('change');
    }
  }

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    if (h.image) return this.images.copy(h, h.dir).catch((e) => console.error('[clip] picture not copied:', e.message));
    clipboard.writeText(h.text);
    this.lastSent = h.dir === 'out' ? null : this.lastSent;
  }

  clearHistory() {
    this.history = [];
    this.emit('change');
  }

  // ---- Clipboard › Queue copies while away (shared/clipqueue.js) ----

  _queueEnabled() {
    const c = this.cfg;
    return c.enabled && c.send && c.queue !== false;
  }

  // Pair entries stay the same across reconnects and are replaced on re-pair.
  checkQueuePair() {
    const owner = this.queueOwner;
    if (!owner || (!owner.ctx.released && this.paired(owner.ctx) === owner.pair)) return;
    this.queueOwner = null;
    ++this.queueEpoch;
    this.queue.clear();
    this._watch();
    this.emit('change');
  }

  _queueSocket(ctx, ws) {
    return !!(ctx && ctx === this.server.current && ws && ws.readyState === 1 && this.server.outbound(ctx) === ws);
  }

  async _queueNow() {
    this.checkQueuePair();
    if (!this.queueOwner || !this._queueEnabled() || this.server.current || this.remote || (this.concealed && this.cfg.skipConcealed)) return;
    const epoch = this.queueEpoch;
    const text = await readText().catch(() => '');
    this.checkQueuePair();
    if (epoch !== this.queueEpoch || !this._queueEnabled() || this.server.current || this.remote ||
        (this.concealed && this.cfg.skipConcealed) || !text || require('../shared/otp.js').isQuiet(text)) return;
    if (this.queue.add(text, this.cfg.maxKB)) this.emit('change');
  }

  _flushQueue(ctx, ws) {
    this.checkQueuePair();
    if (!this._queueEnabled() || !this._queueSocket(ctx, ws) || this.queueOwner?.ctx !== ctx) return;
    const m = this.queue.take();
    if (!m) return;
    this.server.send(ctx, m);
    for (const x of m.items) this._remember('out', x.text, x.at);
    this.emit('change');
  }

  // Put the latest work belongs to the socket that delivered it, even across the read.
  async _onQueue(msg, ctx, ws) {
    const allowed = () => this.cfg.enabled && this.cfg.receive && this._queueSocket(ctx, ws) && this.paired(ctx);
    if (!allowed()) return;
    const items = require('../shared/clipqueue.js').itemsOf(msg);
    if (!items.length) return;
    const epoch = ++this.queueEpoch;
    for (const x of items) this._remember('in', x.text, x.at);
    this.emit('change');
    if (this.cfg.queueLatest) {
      const last = items[items.length - 1].text;
      const sequence = ++this.receiveSequence;
      ++this.receiving;
      try {
        const same = !this.remote && (await readText().catch(() => '')) === last;
        if (sequence !== this.receiveSequence || epoch !== this.queueEpoch || !allowed() || !this.cfg.queueLatest) return;
        if (!same) await clipboard.writeText(last);
        if (sequence < this.lastAppliedText) return;
        this.lastAppliedText = sequence;
        ++this.readSequence;
        this.lastReceived = last;
      } finally {
        this._endReceive();
      }
    }
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      peerImages: this.images.peerImages,
      imageSupport: true, // the one-to-one clipboard (Multi-device's has no pictures yet)
      lastSkip: this.lastSkip,
      queued: this.queue.size,
      history: this.history.map((h) => itemView(h, PREVIEW)),
    };
  }
}

module.exports = { Clipboard };
