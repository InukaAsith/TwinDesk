// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Clipboard text sharing across every connected device (docs/mesh.md, one pool): a copy goes to the
// devices that accept clipboard from us, a clip from any device is applied once and relayed by the
// Pool. Instant and switch modes, the concealed (password) filter, size limit, clip.policy per
// device and the in-memory Recent list (never on disk). Port of windows/clip.js; the Mac's helper
// reports copies (instant mode) instead of the Windows poll. Pictures (Clipboard › Pictures) go
// straight to each connected device that takes them (shared/clipimage.js MeshClipImages).
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Pool } = require('../../shared/mesh.js');
const { Latest } = require('../../shared/clipsync.js');
const { MeshClipImages, trimPictures, itemView } = require('../../shared/clipimage.js');

const PREVIEW = 300; // characters kept per history item for the UI

// The Pool's view of the mesh for the clipboard. Items from a device are always applied (its
// clip.policy says what it wants from us, not what it sends); items go only to devices whose
// clip.policy accepted (mesh entry .pool) and that our pair with sends to (consent), checked in send().
// One we don't send to stays in the item's `d`, so no device relays it there either.
function clipPeers(mesh, clip) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => e.pool !== false && clip._sendsTo(e.id) && e.send(msg),
  }));
}

class Clip extends EventEmitter {
  // opts:
  //   bus      { on(type, fn(msg, fromId)), onPeer(event, fn(peerId, info)), send(peerId, msg) -> bool,
  //              selectedId() -> string|null, connectedIds() -> string[] }   (hub.js)
  //   mesh     shared/mesh.js Mesh (entries: {id, name, send, mesh, pool})
  //   getSettings()  -> settings (settings.clipboard is used)
  //   consent  optional shared/consent.js: each device's own Send / Receive (else the settings' for all)
  //   clipboard  {readText() -> string|Promise, writeText(text)}; default Electron's
  //   helper   optional: the helper process {running, send(name, args), request(name, args) -> Promise,
  //            on('event' | 'ready')}: 'clipboard' events (instant mode) and 'clipboardInfo' (concealed)
  //   session(id)    optional: hub.js's session of a device (bufferedAmount, transport), for pictures
  // Events also: 'popup' (kind, text) — "Picture from … copied".
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.getSettings = opts.getSettings;
    this.clipboard = opts.clipboard || require('electron').clipboard;
    this.helper = opts.helper || null;
    this.consent = opts.consent || null;
    this.pool = new Pool({ name: 'clip', selfId: this.mesh.selfId, peers: () => clipPeers(this.mesh, this) });
    this.latest = new Latest({ selfId: this.mesh.selfId }); // the latest copy wins (shared/clipsync.js)
    this.lastSync = { sent: null, received: null };
    this.readSequence = 0;
    this.readsInFlight = 0;
    this.receiveSequence = 0;
    this.lastAppliedText = 0;
    this.receiving = 0;
    this.pending = null; // a sendIfChanged held back while a clip is received: its why
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size, from}
    this.lastSkip = '';
    this.concealed = false; // the helper's last report for the current copy
    this.seen = null; // last clipboard text seen by instant mode
    const sess = (id) => (opts.session ? opts.session(id) : null);
    this.images = new MeshClipImages({
      cfg: () => this.cfg, clipboard: this.clipboard,
      onReceiveStart: () => { ++this.receiving; ++this.receiveSequence; },
      onReceiveEnd: (written) => {
        if (written) ++this.readSequence;
        this._endReceive();
      },
      ids: () => this.bus.connectedIds().filter((id) => this._accepts(id)),
      sendsTo: (id) => this._sendsTo(id), takes: (id) => this._takes(id),
      send: (id, m) => this.bus.send(id, m),
      backlog: (id) => { const x = sess(id); return (x && x.bufferedAmount) || 0; },
      ble: (id) => { const x = sess(id); return !!x && x.transport === 'ble'; },
      peerName: (id) => { const e = this.mesh.get(id); return (e && e.name) || ''; },
      remember: (dir, item, from) => this._remember(dir, item, from),
      popup: (kind, text, presentation) => this.emit('popup', kind, presentation || text),
      log: (line) => console.log(line),
      copied: () => this.latest.copied('image'), // a picture is a copy as text is: the latest wins
      newest: (pic) => this.latest.accept(pic, 'image'),
      onChange: () => this._changed(),
      pasteKeys: '⌘V',
    });

    // Copies made while a device is away go to its Recent when it's back (shared/clipqueue.js).
    this.away = new (require('../../shared/clipqueue.js').MeshClipQueue)(this, {
      concealed: () => this._isConcealed('request'),
      nameOf: (id) => this.mesh.get(id)?.name || id,
      changed: () => this._changed(),
      activePair: opts.activePair,
      knownPair: opts.knownPair,
      currentSocket: (id) => sess(id)?.outbound(),
    });
    const bus = this.bus;
    bus.on(P.T.CLIP, (m, from) => this._onClip(m, from));
    bus.on(P.T.CLIP_QUEUE, (m, from, source, ws = source) => {
      if (ws && ws === sess(from)?.outbound()) return this.away.receive(m, from);
    });
    bus.on(P.T.CLIP_IMAGE, (m, from) => this.images.header(m, from));
    bus.on(P.T.CLIP_IMAGE_PART, (m, from) => this.images.part(m, from));
    bus.on(P.T.CLIP_POLICY, (m, from, source, ws = source) => {
      const e = this.mesh.get(from);
      if (e) e.pool = m.accept !== false;
      console.log(`[clip] ${this._name(from)} takes ${m.accept !== false ? 'the clipboard' : 'no clipboard'}, ${m.images === true ? 'pictures too' : 'no pictures'}`);
      this.images.policy(m, from);
      if (ws && ws === sess(from)?.outbound()) this.away.policy(from, m);
      this._changed();
    });
    bus.on(P.T.CLIP_REQUEST, () => this.sendIfChanged('request'));
    bus.onPeer('welcome', (id) => {
      this.away.welcome(id);
      const e = this.mesh.get(id);
      if (e) e.pool = true; // until its clip.policy says otherwise
      this.images.reset(id);
      this._sendPolicy(id);
      this._applyWatch();
      this._changed();
    });
    bus.onPeer('forgotten', (id) => this.away.forget(id));
    bus.onPeer('closed', (id) => {
      this.images.reset(id);
      this._applyWatch();
      this._changed();
    });
    this.away.applyLatest = (text, allowed) => this._applyQueuedText(text, allowed);
    if (this.helper) {
      this.helper.on('event', (name, ev) => {
        if (name === 'clipboard') this.onLocalCopy(ev);
      });
      this.helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
    }
  }

  async _applyQueuedText(text, allowed) {
    const sequence = ++this.receiveSequence;
    ++this.receiving;
    try {
      const current = await this._readText().catch(() => '');
      if (sequence !== this.receiveSequence || !allowed()) return;
      if (current !== text) await this.clipboard.writeText(text);
      if (sequence < this.lastAppliedText) return;
      this.lastAppliedText = sequence;
      ++this.readSequence;
      this.lastSync.received = text;
      this.seen = text;
      this.away.seen = text;
    } finally {
      this._endReceive();
    }
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // Our pair with that device: our clipboard goes there / theirs is taken here (shared/consent.js).
  _sendsTo(id) {
    const c = this.cfg;
    return !!c.enabled && (this.consent ? this.consent.get(id, 'clipboard', 'out') : !!c.send);
  }

  _takes(id) {
    const c = this.cfg;
    return !!c.enabled && (this.consent ? this.consent.get(id, 'clipboard', 'in') : !!c.receive);
  }

  _anySend() {
    return this.bus.connectedIds().some((id) => this._sendsTo(id));
  }

  // True when some connected device accepts clipboard from us (true with nobody connected, as before).
  get peerAccepts() {
    const ids = this.bus.connectedIds();
    if (!ids.length) return true;
    return ids.some((id) => this._accepts(id));
  }

  _accepts(id) {
    const e = this.mesh.get(id);
    return !!e && e.pool !== false && this._sendsTo(id);
  }

  // Call after settings.clipboard changed.
  applySettings() {
    this.away.configure();
    const c = this.cfg;
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this._applyWatch();
    this.sendPolicy();
    this._changed();
  }

  // The helper reports copies only while something would be sent.
  _applyWatch() {
    if (!this.helper || !this.helper.running) return;
    this.helper.send('clipboardWatch', { on: this._anySend() });
  }

  // Our clip.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    this.bus.send(id, { t: P.T.CLIP_POLICY, accept: this._takes(id), images: !!(this.images.on && this._takes(id)), queue: true }); // queue: clip.queue understood here
  }

  // A copy was made on this Mac (helper event). Instant mode sends new copies only, not what was
  // already on the clipboard when the watch began (initial).
  onLocalCopy(ev) {
    this.concealed = !!(ev && ev.concealed);
    this.remote = !!(ev && ev.remote); // Universal Clipboard: see ../clipboard.js (#211)
    if (this.cfg.mode === 'instant' && !(ev && ev.initial)) this.sendIfChanged('instant');
  }

  destroy() {
    this._applyWatch();
  }

  async _readText() {
    return String((await this.clipboard.readText()) || '');
  }

  // item: the text, or a picture (shared/clipimage.js).
  _remember(dir, item, from, at = Date.now()) {
    // What went out last is no longer on the other side once something came in, and the other way
    // round: copying it again must send it again (#223).
    if (dir === 'in') this.lastSync.sent = null; else this.lastSync.received = null;
    const n = this.cfg.historySize;
    if (!n) return;
    if (typeof item === 'string') {
      this.history = this.history.filter((h) => h.text !== item || h.dir !== dir);
      item = { text: item, size: Buffer.byteLength(item, 'utf8') };
    }
    this.history.unshift({ dir, at, ...item, from: from || '' });
    if (this.history.length > n) this.history.length = n;
    trimPictures(this.history);
  }

  // Name of the device where an item started: the mesh entry, else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    if (typeof on === 'string' && on) return on.slice(0, 100);
    const f = this.mesh.get(from);
    return (f && f.name) || from;
  }

  _name(id) {
    const e = this.mesh.get(id);
    return (e && e.name) || String(id).slice(0, 8);
  }

  async _onClip(m, from) {
    const c = this.cfg;
    if (!c.enabled || !this._takes(from) || !m || !P.clipAllowed(m.text)) return;
    // The phone bridge can report our last send back while a newer local copy is being read. Its
    // clips carry no origin; a mesh device's copy of the same text is a copy, and goes on.
    if (m.o === undefined && m.text === this.lastSync.sent && (this.readsInFlight || this.pending)) return;
    const r = this.pool.receive(from, m);
    if (!r.fresh) return;
    if (r.msg.o && r.msg.o !== from && !this._takes(r.msg.o)) return; // relayed from a device whose clipboard we don't take
    // An older copy than the newest this device knows (its own last copy counts): not applied. The pool
    // relayed it anyway, so each device decides for itself.
    const name = this._nameOf(r.msg.o, m.on, from);
    if (!this.latest.accept(r.msg, 'text')) return void console.log(`[clip] text from ${name} (${m.text.length} characters, by ${this._name(from)}) is older than the newest copy here: not applied`);
    const sequence = ++this.receiveSequence;
    const text = m.text;
    ++this.receiving;
    try {
      const write = this.remote || (await this._readText()) !== text;
      if (sequence !== this.receiveSequence) return void console.log(`[clip] text from ${name}: a newer copy came in meanwhile, not applied`);
      this.images.text(); // a picture still on its way either way is out of date
      if (write) await this.clipboard.writeText(text);
      // A newer clip may have been applied while this one was written.
      if (sequence < this.lastAppliedText) return;
      this.lastAppliedText = sequence;
      ++this.readSequence;
      this.lastSync.received = text;
      this.seen = text; // so instant mode doesn't publish it back
      console.log(`[clip] text from ${name} (${text.length} characters, by ${this._name(from)}): on the clipboard`);
      this._remember('in', text, name);
      this._changed();
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

  // Send this Mac's clipboard text to the pool if allowed and changed since it was last sent or
  // received. An answer to clip.request is the same thing: a copy, published to every device that
  // accepts it (the requester included).
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!this._anySend()) return;
    if (!this.peerAccepts) return this._skip("A connected device doesn’t accept this Mac’s clipboard");
    if (why === 'instant' && this.remote) return; // Universal Clipboard: see ../clipboard.js (#211)
    // While a clip is being put on the clipboard nothing is read: the call runs again after it.
    const defer = () => {
      if (!this.receiving) return false;
      if (why !== 'instant' || !this.pending) this.pending = why;
      return true;
    };
    if (defer()) return;
    const sequence = ++this.readSequence;
    const valid = () => sequence === this.readSequence && this.cfg.enabled && this.cfg.send && !defer();
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
    const text = await this._readText();
    if (!valid()) return;
    if (!text) return this._picture(why, valid);
    if (require('../../shared/otp.js').isQuiet(text)) return; // a code copied by itself (Notifications): kept here only
    if (text === this.lastSync.sent || text === this.lastSync.received) return;
    if (c.skipConcealed && (await this._isConcealed(why))) {
      if (!valid()) return;
      this.lastSync.sent = text; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    if (!valid()) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSync.sent = text;
      return this._skip(`skipped ${Math.round(size / 1024)} KB (over ${c.maxKB} KB)`);
    }
    this.images.text();
    const stamp = this.latest.copied('text'); // when the copy happened; the pool adds where (o)
    const { sent } = this.pool.publish({ t: P.T.CLIP, text, ts: stamp.ts });
    console.log(`[clip] text copied here (${text.length} characters, ${why}): ${sent.length ? 'to ' + sent.map((id) => this._name(id)).join(', ') : 'nobody took it'}`);
    if (!sent.length) return;
    this.lastSync.sent = text;
    this._remember('out', text);
    this.lastSkip = '';
    this._changed();
  }

  // The helper's flag for the current item: a copy from the watch, or asked for now (requests).
  async _isConcealed(why) {
    if (why === 'instant' || !this.helper || !this.helper.running) return this.concealed;
    const info = await this.helper.request('clipboardInfo').catch(() => ({}));
    return !!(info && info.concealed);
  }

  // No text on the clipboard: its picture, if any, to the devices that take pictures.
  // Nobody takes it: offerClipboard() logs why it stays here.
  async _picture(why, valid) {
    if (!valid()) return;
    const concealed = this.images.canSend && this.cfg.skipConcealed && (await this._isConcealed(why));
    if (!valid()) return;
    const r = await this.images.offerClipboard(!!concealed);
    if (!valid()) return;
    if (r === 'sent') {
      this.lastSkip = '';
      this._changed();
    } else if (r) {
      this._skip(r);
    }
  }

  // Ask the selected device for its text (it answers only if it changed).
  request() {
    const id = this.bus.selectedId();
    if (id) this.bus.send(id, { t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    console.log('[clip] not sent:', why);
    this._changed();
  }

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    if (h.image) return void this.images.copy(h, h.dir).catch((e) => console.error('[clip] picture not copied:', e.message));
    this.clipboard.writeText(h.text);
    this.seen = h.text;
    if (h.dir === 'out') this.lastSync.sent = null;
  }

  clearHistory() {
    this.history = [];
    this._changed();
  }

  _changed() {
    this.emit('change');
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      peerImages: this.images.peerImages,
      // The connected devices that take our clipboard but not pictures (the Pictures hint names them).
      noPictures: this.bus.connectedIds().filter((id) => this._accepts(id) && !(this.images.peers.get(id) || {}).images).map((id) => this._name(id)),
      imageSupport: true,
      lastSkip: this.lastSkip,
      queued: this.away.size,
      history: this.history.map((h) => ({ ...itemView(h, PREVIEW), from: h.from || '' })),
    };
  }
}

module.exports = { Clip, Clipboard: Clip };
