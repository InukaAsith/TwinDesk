// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text sharing across every connected device (docs/mesh.md, one pool): a copy goes to the
// devices that accept clipboard from us, a clip from any device is applied once and relayed by the
// Pool. Instant and switch modes, the concealed (password) filter, size limit, clip.policy per
// device and the in-memory Recent list (never on disk). Port of windows/clip.js; the Mac's helper
// reports copies (instant mode) instead of the Windows poll.
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');

const PREVIEW = 300; // characters kept per history item for the UI

// The Pool's view of the mesh for the clipboard. Items from a device are always applied (its
// clip.policy says what it wants from us, not what it sends); items go only to devices whose
// clip.policy accepted (mesh entry .pool), which is checked in send().
function clipPeers(mesh) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => e.pool !== false && e.send(msg),
  }));
}

class Clip extends EventEmitter {
  // opts:
  //   bus      { on(type, fn(msg, fromId)), onPeer(event, fn(peerId, info)), send(peerId, msg) -> bool,
  //              selectedId() -> string|null, connectedIds() -> string[] }   (hub.js)
  //   mesh     shared/mesh.js Mesh (entries: {id, name, send, mesh, pool})
  //   getSettings()  -> settings (settings.clipboard is used)
  //   clipboard  {readText() -> string|Promise, writeText(text)}; default Electron's
  //   helper   optional: the helper process {running, send(name, args), request(name, args) -> Promise,
  //            on('event' | 'ready')}: 'clipboard' events (instant mode) and 'clipboardInfo' (concealed)
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.getSettings = opts.getSettings;
    this.clipboard = opts.clipboard || require('electron').clipboard;
    this.helper = opts.helper || null;
    this.pool = new Pool({ name: 'clip', selfId: this.mesh.selfId, peers: () => clipPeers(this.mesh) });
    this.lastSync = { sent: null, received: null };
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size, from}
    this.lastSkip = '';
    this.concealed = false; // the helper's last report for the current copy
    this.seen = null; // last clipboard text seen by instant mode

    const bus = this.bus;
    bus.on(P.T.CLIP, (m, from) => this._onClip(m, from));
    bus.on(P.T.CLIP_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) e.pool = m.accept !== false;
      this._changed();
    });
    bus.on(P.T.CLIP_REQUEST, () => this.sendIfChanged('request'));
    bus.onPeer('welcome', (id) => {
      const e = this.mesh.get(id);
      if (e) e.pool = true; // until its clip.policy says otherwise
      this._sendPolicy(id);
      this._applyWatch();
      this._changed();
    });
    bus.onPeer('closed', () => {
      this._applyWatch();
      this._changed();
    });
    if (this.helper) {
      this.helper.on('event', (name, ev) => {
        if (name === 'clipboard') this.onLocalCopy(ev);
      });
      this.helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
    }
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // True when some connected device accepts clipboard from us (true with nobody connected, as before).
  get peerAccepts() {
    const ids = this.bus.connectedIds();
    if (!ids.length) return true;
    return ids.some((id) => this._accepts(id));
  }

  _accepts(id) {
    const e = this.mesh.get(id);
    return !!e && e.pool !== false;
  }

  // Call after settings.clipboard changed.
  applySettings() {
    const c = this.cfg;
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this._applyWatch();
    this.sendPolicy();
    this._changed();
  }

  // The helper reports copies only while something would be sent.
  _applyWatch() {
    if (!this.helper || !this.helper.running) return;
    const c = this.cfg;
    this.helper.send('clipboardWatch', { on: !!(c.enabled && c.send && this.bus.connectedIds().length) });
  }

  // Our clip.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    const c = this.cfg;
    this.bus.send(id, { t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  // A copy was made on this Mac (helper event). Instant mode sends new copies only, not what was
  // already on the clipboard when the watch began (initial).
  onLocalCopy(ev) {
    this.concealed = !!(ev && ev.concealed);
    if (this.cfg.mode === 'instant' && !(ev && ev.initial)) this.sendIfChanged('instant');
  }

  destroy() {
    this._applyWatch();
  }

  async _readText() {
    return String((await this.clipboard.readText()) || '');
  }

  _remember(dir, text, from) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8'), from: from || '' });
    if (this.history.length > n) this.history.length = n;
  }

  // Name of the device where an item started: the mesh entry, else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    if (typeof on === 'string' && on) return on.slice(0, 100);
    const f = this.mesh.get(from);
    return (f && f.name) || from;
  }

  async _onClip(m, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !m || !P.clipAllowed(m.text)) return;
    const r = this.pool.receive(from, m);
    if (!r.fresh) return;
    const text = m.text;
    const name = this._nameOf(r.msg.o, m.on, from);
    this.lastSync.received = text;
    this.seen = text; // so instant mode doesn't publish it back
    if ((await this._readText()) !== text) this.clipboard.writeText(text);
    this._remember('in', text, name);
    this._changed();
  }

  // Send this Mac's clipboard text to the pool if allowed and changed since it was last sent or
  // received. An answer to clip.request is the same thing: a copy, published to every device that
  // accepts it (the requester included).
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.bus.connectedIds().length) return;
    if (!this.peerAccepts) return this._skip("A connected device doesn’t accept this Mac’s clipboard");
    const text = await this._readText();
    if (!text || text === this.lastSync.sent || text === this.lastSync.received) return;
    if (c.skipConcealed && (await this._isConcealed(why))) {
      this.lastSync.sent = text; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSync.sent = text;
      return this._skip(`skipped ${Math.round(size / 1024)} KB (over ${c.maxKB} KB)`);
    }
    if (!this.pool.publish({ t: P.T.CLIP, text }).sent.length) return;
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

  // Ask the selected device for its text (it answers only if it changed).
  request() {
    const id = this.bus.selectedId();
    if (id) this.bus.send(id, { t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    this._changed();
  }

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
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
      lastSkip: this.lastSkip,
      history: this.history.map((h) => ({
        dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW), from: h.from || '',
      })),
    };
  }
}

module.exports = { Clip, Clipboard: Clip };
