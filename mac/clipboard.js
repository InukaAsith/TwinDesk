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
const { keysLabel } = require('../shared/cursorlock.js');

// Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
const readText = async () => String((await clipboard.readText()) || '');
const PREVIEW = 300; // characters kept per history item for the UI

class Clipboard extends EventEmitter {
  constructor(server, helper, getSettings) {
    super();
    this.server = server;
    this.helper = helper;
    this.getSettings = getSettings;
    this.lastSent = null;
    this.lastReceived = null;
    this.concealed = false; // last helper report for the current item
    this.peerAccepts = true; // the PC's last clip.policy
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size} or a picture (clipimage.js)
    this.lastSkip = '';
    const ws = () => this.server.current && this.server.current.ws;
    this.images = new ClipImages({
      cfg: () => this.cfg,
      send: (m) => this.server.sendToClient(m),
      backlog: () => (ws() ? ws().bufferedAmount : 0),
      connected: () => !!this.server.current,
      ble: () => !!(this.server.current && this.server.current.transport === 'ble'),
      peerName: () => (this.server.current && this.server.current.name) || 'the other device',
      remember: (dir, item) => this._remember(dir, item),
      popup: (kind, text, presentation) => this.emit('popup', kind, presentation || text),
      onChange: () => this.emit('change'),
      pasteKeys: '⌘V',
    });

    server.on('client', () => {
      this.peerAccepts = true;
      this.images.reset();
      this.sendPolicy();
      this._watch();
    });
    server.on('closed', () => {
      this.images.reset();
      this._watch();
    });
    server.on(`t:${P.T.CLIP}`, (msg) => this._onClip(msg));
    server.on(`t:${P.T.CLIP_IMAGE}`, (msg) => this.images.header(msg));
    server.on(`t:${P.T.CLIP_IMAGE_PART}`, (msg) => this.images.part(msg));
    server.on(`t:${P.T.CLIP_POLICY}`, (msg) => {
      this.peerAccepts = msg.accept !== false;
      this.images.policy(msg);
      this.emit('change');
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.sendIfChanged('request'));
    helper.on('event', (name, ev) => {
      if (name !== 'clipboard') return;
      this.concealed = !!ev.concealed;
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
    this._watch(true);
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this.sendPolicy();
    this.emit('change');
  }

  // The helper watches the clipboard (4 checks a second) only while a session could take a copy:
  // with nobody connected nothing would be sent (sendIfChanged), so nothing wakes the Mac for it.
  _watch(force = false) {
    const c = this.cfg;
    const on = !!(c.enabled && c.send && this.server.current);
    if (!force && on === this.watching) return;
    this.watching = on;
    this.helper.send('clipboardWatch', { on });
  }

  sendPolicy() {
    const c = this.cfg;
    this.server.sendToClient({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive), images: this.images.accept });
  }

  _remember(dir, item) {
    const n = this.cfg.historySize;
    if (!n) return;
    if (typeof item === 'string') {
      this.history = this.history.filter((h) => h.text !== item || h.dir !== dir);
      item = { text: item, size: Buffer.byteLength(item, 'utf8') };
    }
    this.history.unshift({ dir, at: Date.now(), ...item });
    if (this.history.length > n) this.history.length = n;
    trimPictures(this.history);
  }

  async _onClip(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(msg.text)) return;
    this.images.text();
    this.lastReceived = msg.text;
    if ((await readText()) !== msg.text) clipboard.writeText(msg.text);
    this._remember('in', msg.text);
    this.emit('change');
  }

  // Send our clipboard if allowed and changed since it was last sent or received: its text, else
  // its picture (Clipboard › Pictures).
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.server.current) return;
    if (!this.peerAccepts) return this._skip(`${this.server.current ? this.server.current.name : 'the other computer'} doesn’t take the clipboard`);
    const text = await readText();
    // Files copied in Finder: the clipboard also holds their names and icon, which aren't the copy.
    // Files go with the Files tab's shortcuts (fclip.js).
    const src = await this.helper.request('fileSource').catch(() => ({}));
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

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      peerImages: this.images.peerImages,
      imageSupport: true, // the one-to-one clipboard (Multi-device's has no pictures yet)
      lastSkip: this.lastSkip,
      history: this.history.map((h) => itemView(h, PREVIEW)),
    };
  }
}

module.exports = { Clipboard };
