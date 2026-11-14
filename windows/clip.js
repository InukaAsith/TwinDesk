// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing: directions, switch/instant mode, concealed filter, size limit, clip.policy
// both ways, and the in-memory Recent list (never on disk). Text here; pictures, screenshots put
// on the clipboard among them (Clipboard › Pictures, up to 10 MB), through shared/clipimage.js.
const { clipboard } = require('electron');
const P = require('../shared/protocol.js');
const { ClipImages, trimPictures, itemView } = require('../shared/clipimage.js');
const eclip = require('../shared/eclip.js');

// Newer Electron returns a Promise from clipboard.readText() in main; await works for both.
const readText = async () => String((await clipboard.readText()) || '');
const POLL_MS = 500; // instant mode: how often the clipboard is checked for a new copy
const IMAGE_POLL_EVERY = 6; // … and, without the helper's word on a copy, for a new picture (every 3 s)
const PREVIEW = 300; // characters kept per history item for the UI
// The clipboard's formats, a picture on it, a password manager's secret: shared/eclip.js (Electron 44
// has no availableFormats/readBuffer).
const isConcealed = () => eclip.isConcealed(clipboard);

class Clip {
  // getSettings() → settings.clipboard; onChange() → the view changed;
  // opts: {popup(kind, text), peerName()}
  constructor(link, getSettings, onChange, opts = {}) {
    this.link = link;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.lastSync = { sent: null, received: null };
    this.peerAccepts = true; // the Mac's last clip.policy
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size} or a picture (clipimage.js)
    this.lastSkip = '';
    this.poll = null;
    this.ticks = 0;
    this.seen = null; // last clipboard text the instant poll saw
    this.formats = ''; // … and the formats on it, for a new picture
    this.copied = false; // the helper saw a copy since the last look
    this.generation = 0;
    this.readSequence = 0;

    this.images = new ClipImages({
      cfg: () => this.cfg,
      send: (m) => this.link.send(m),
      backlog: () => this.link.bufferedAmount || 0,
      connected: () => this.link.status.state === 'connected',
      ble: () => !!(this.link.current && this.link.current.transport === 'ble'),
      peerName: () => (opts.peerName ? opts.peerName() : 'the other device'),
      remember: (dir, item) => this._remember(dir, item),
      popup: (kind, text, presentation) => opts.popup && opts.popup(kind, presentation || text),
      onChange: () => this.onChange(),
      pasteKeys: process.platform === 'darwin' ? '⌘V' : 'Ctrl+V',
    });
    this.watched = false; // the helper says when anything is copied (useHelper)

    link.on(P.T.CLIP, (m) => this._onClip(m));
    link.on(P.T.CLIP_IMAGE, (m) => this.images.header(m));
    link.on(P.T.CLIP_IMAGE_PART, (m) => this.images.part(m));
    link.on(P.T.CLIP_POLICY, (m) => {
      this.peerAccepts = m.accept !== false;
      this.images.policy(m);
      this.onChange();
    });
    link.on('welcome', () => {
      ++this.generation;
      this.lastSync = { sent: null, received: null };
      this.peerAccepts = true;
      this.images.reset();
      this.applySettings(); // sends clip.policy, starts the instant poll if on
    });
    link.on(P.T.CLIP_REQUEST, () => this.sendIfChanged());
    link.on('closed', () => {
      ++this.generation;
      this._stopPoll();
      this.images.reset();
    });
  }

  get cfg() {
    return this.getSettings();
  }

  // Windows' helper says when anything is copied (pictures too: ClipWatch.cs); without it the
  // poll looks for a new picture now and then.
  useHelper(helper) {
    helper.on('exit', () => { this.watched = false; });
    helper.on('event', (name) => {
      if (name !== 'clipboard') return;
      this.watched = true;
      this.copied = true;
    });
  }

  // Call after settings.clipboard changed.
  applySettings() {
    ++this.readSequence;
    const c = this.cfg;
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    if (c.enabled && c.send && c.mode === 'instant' && this.link.status.state === 'connected') this._startPoll();
    else this._stopPoll();
    this.sendPolicy();
    this.onChange();
  }

  sendPolicy() {
    const c = this.cfg;
    this.link.send({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive), images: this.images.accept });
  }

  _startPoll() {
    if (this.poll) return;
    const token = this.pollToken = {};
    let reading = true;
    // New copies only: what is already on the clipboard when instant mode starts stays here.
    readText().then((t) => { if (this.pollToken === token) this.seen = t; }).catch(() => {}).finally(() => { reading = false; });
    eclip.formats(clipboard).then((f) => { if (this.pollToken === token) this.formats = f.join(); }).catch(() => {});
    this.copied = false;
    this.poll = setInterval(async () => {
      if (reading || this.pollToken !== token) return;
      reading = true;
      try {
        const t = await readText();
        if (this.pollToken !== token) return;
        const list = await eclip.formats(clipboard);
        if (this.pollToken !== token) return;
        const formats = list.join();
        // A new picture: the helper saw a copy, the formats changed, or (no helper) now and then.
        const picture = !t && this.images.canSend && list.some((f) => /^image\//.test(f)) &&
          (this.copied || formats !== this.formats || (!this.watched && ++this.ticks % IMAGE_POLL_EVERY === 0));
        this.copied = false;
        this.formats = formats;
        if (t === this.seen && !picture) return;
        const seen = this.seen;
        if (!t) this.seen = t;
        const handled = await this.sendIfChanged('instant');
        if (handled && this.pollToken === token && this.seen === seen) this.seen = t;
      } catch (_) { /* clipboard temporarily unavailable */ }
      finally { reading = false; }
    }, POLL_MS);
  }

  _stopPoll() {
    clearInterval(this.poll);
    this.poll = null;
    this.pollToken = null;
  }

  _remember(dir, item) {
    // What went out last is no longer on the other side once something came in, and the other way
    // round: copying it again must send it again (#223).
    if (dir === 'in') this.lastSync.sent = null; else this.lastSync.received = null;
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

  async _onClip(m) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(m.text)) return;
    ++this.readSequence;
    try { clipboard.writeText(m.text); } catch (_) { return; }
    this.images.text();
    this.lastSync.sent = null;
    this.lastSync.received = m.text;
    this.seen = m.text; // so instant mode doesn't bounce it back
    this._remember('in', m.text);
    this.onChange();
  }

  // Send this PC's clipboard if allowed and changed since it was last sent or received: its text,
  // else its picture (Clipboard › Pictures).
  async sendIfChanged(why) {
    let c = this.cfg;
    if (!c.enabled || !c.send || this.link.status.state !== 'connected') return;
    if (!this.peerAccepts) return this._skip("{name} doesn't accept {me}’s clipboard");
    const generation = this.generation, sequence = ++this.readSequence;
    let text, concealed;
    // Read together: one await before the checks below (shared/eclip.js reads the formats).
    try { [text, concealed] = await Promise.all([readText(), c.skipConcealed && isConcealed()]); } catch (_) { return; }
    c = this.cfg;
    if (generation !== this.generation || sequence !== this.readSequence || !c.enabled || !c.send || !this.peerAccepts || this.link.status.state !== 'connected') return;
    if (!text) return this._result(await this.images.offerClipboard(c.skipConcealed && concealed));
    if (text === this.lastSync.sent || text === this.lastSync.received) return true;
    if (c.skipConcealed && concealed) {
      this.lastSync.sent = text; // don't retry this item
      this._skip('skipped a password (concealed item)');
      return true;
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      this.lastSync.sent = text;
      this._skip('skipped ' + Math.round(size / 1024) + ' KB (over ' + c.maxKB + ' KB)');
      return true;
    }
    this.images.text();
    if (!this.link.send({ t: P.T.CLIP, text })) return;
    this.lastSync.sent = text;
    this.lastSync.received = null;
    this._remember('out', text);
    this.lastSkip = '';
    this.onChange();
    return true;
  }

  // What the picture side did: sent (the note goes), or why not.
  _result(r) {
    if (r === 'sent') {
      this.lastSkip = '';
      this.onChange();
    } else if (r) {
      this._skip(r);
    }
  }

  // Monitor 2 lost focus: ask the Mac for its text (it answers only if it changed).
  request() {
    this.link.send({ t: P.T.CLIP_REQUEST });
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
    if (h.image) {
      this.images.copy(h, h.dir).catch((e) => console.error('[clip] picture not copied:', e.message));
      this.seen = '';
      return;
    }
    clipboard.writeText(h.text);
    ++this.readSequence;
    this.seen = null;
    if (this.lastSync.sent === h.text) this.lastSync.sent = null;
    if (this.lastSync.received === h.text) this.lastSync.received = null;
  }

  clearHistory() {
    this.history = [];
    this.onChange();
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

module.exports = Clip;
