// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text sharing across every connected device (docs/mesh.md, one pool): a copy goes to
// the devices that accept clipboard from us, a clip from any device is applied once and relayed by
// the Pool. Switch/instant modes, concealed filter, size limit, clip.policy per device and the
// in-memory Recent list (never on disk).
const electron = require('electron');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');

const electronClipboard = electron.clipboard; // undefined under plain node (tests inject one)
const POLL_MS = 500; // instant mode: how often the clipboard is checked for a new copy
const PREVIEW = 300; // characters kept per history item for the UI

// Password managers mark secrets so clipboard tools leave them alone. clipboard.has() doesn't see
// these registered formats; readBuffer() does (empty buffer = format absent).
function isConcealed(clipboard) {
  try {
    if (clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing').length) return true;
    if (clipboard.readBuffer('Clipboard Viewer Ignore').length) return true;
    const b = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (b && b.length >= 4 && b.readUInt32LE(0) === 0) return true;
  } catch (_) { /* unknown format: not concealed */ }
  return false;
}

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

class Clip {
  // opts:
  //   bus      { on(type, fn(msg, fromId)), onPeer(event, fn(peerId, info)), send(peerId, msg) -> bool,
  //              selectedId() -> string|null, connectedIds() -> string[] }
  //   mesh     shared/mesh.js Mesh (entries: {id, name, send, mesh, pool})
  //   getSettings()  -> settings.clipboard
  //   onChange()     the view changed
  //   clipboard      optional; default Electron's clipboard
  constructor(opts) {
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.getSettings = opts.getSettings;
    this.onChange = opts.onChange;
    this.clipboard = opts.clipboard || electronClipboard;
    this.pool = new Pool({ name: 'clip', selfId: this.mesh.selfId, peers: () => clipPeers(this.mesh) });
    this.lastSync = { sent: null, received: null };
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size, from}
    this.lastSkip = '';
    this.poll = null;
    this.seen = null; // last clipboard text the instant poll saw

    const bus = this.bus;
    bus.on(P.T.CLIP, (m, from) => this._onClip(m, from));
    bus.on(P.T.CLIP_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) e.pool = m.accept !== false;
      this.onChange();
    });
    bus.on(P.T.CLIP_REQUEST, () => this.sendIfChanged('request'));
    bus.onPeer('welcome', (id) => {
      const e = this.mesh.get(id);
      if (e) e.pool = true; // until its clip.policy says otherwise
      this._sendPolicy(id);
      this._applyPoll();
      this.onChange();
    });
    bus.onPeer('closed', (id) => {
      if (!this._othersConnected(id)) this._stopPoll();
      this.onChange();
    });
  }

  get cfg() {
    return this.getSettings();
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

  _othersConnected(id) {
    return this.bus.connectedIds().some((x) => x !== id);
  }

  // Call after settings.clipboard changed.
  applySettings() {
    const c = this.cfg;
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this._applyPoll();
    this.sendPolicy();
    this.onChange();
  }

  _applyPoll() {
    const c = this.cfg;
    if (c.enabled && c.send && c.mode === 'instant' && this.bus.connectedIds().length) this._startPoll();
    else this._stopPoll();
  }

  // Our clip.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    const c = this.cfg;
    this.bus.send(id, { t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  _startPoll() {
    if (this.poll) return;
    // New copies only: what is already on the clipboard when instant mode starts stays here.
    this._readText().then((t) => { this.seen = t; });
    this.poll = setInterval(() => { this.pollOnce(); }, POLL_MS);
  }

  _stopPoll() {
    clearInterval(this.poll);
    this.poll = null;
  }

  // One instant-mode check: a new clipboard text is published to the pool.
  async pollOnce() {
    const t = await this._readText();
    if (t === this.seen) return;
    this.seen = t;
    await this.sendIfChanged('instant');
  }

  destroy() {
    this._stopPoll();
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
    this.onChange();
  }

  // Send this device's clipboard text to the pool if allowed and changed since it was last sent or
  // received. An answer to clip.request is the same thing: a copy, published to every device that
  // accepts it (the requester included). A targeted, unstamped answer would collide with this
  // device's pool sequence numbers at the receiver, so there is none.
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.bus.connectedIds().length) return;
    if (!this.peerAccepts) return this._skip("{name} doesn't accept {me}’s clipboard");
    const text = await this._readText();
    if (!text || text === this.lastSync.sent || text === this.lastSync.received) return;
    if (c.skipConcealed && isConcealed(this.clipboard)) {
      this.lastSync.sent = text; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSync.sent = text;
      return this._skip('skipped ' + Math.round(size / 1024) + ' KB (over ' + c.maxKB + ' KB)');
    }
    if (!this.pool.publish({ t: P.T.CLIP, text }).sent.length) return;
    this.lastSync.sent = text;
    this._remember('out', text);
    this.lastSkip = '';
    this.onChange();
  }

  // Monitor 2 lost focus: ask the selected device for its text (it answers only if it changed).
  request() {
    const id = this.bus.selectedId();
    if (id) this.bus.send(id, { t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    this.onChange();
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
    this.onChange();
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

module.exports = Clip;
