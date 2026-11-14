// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › PC → Mac: this PC's screen in a window on the Mac.
// Mirror = one existing monitor; Extend = the virtual monitor (vdd.js). Sharing starts off every
// time the app starts. We offer an `rtc2` session (kind `screen` / `screen+audio`) while sharing is
// on and the Mac's `screen.policy` accepts (sender.js); `in.*` without `wid` from the Mac are
// injected by the helper (remote-input.js).
// `screen.policy` means "a viewer is open and watching" (any peer); nothing is captured
// while it is false. A peer that never sends one (an older app) counts as watching, after a moment
// for its first policy to arrive. We tell the viewer what we share (`screen.state`) and, when
// "Let <peer> start and switch this screen" is on (pcScreen.remote), obey its `screen.ctl`.
const { desktopCapturer, powerMonitor, screen: displays } = require('electron');
const P = require('../shared/protocol.js');
const RemoteInput = require('./remote-input');
const encoder = require('./encoder');
const { StallWatch } = encoder;

const T = P.T;
const RETRY_MS = 2000; // a capture that ended by itself (the desktop locked): tried again, doubling up to 30 s

class PcScreen {
  // opts: link, helper, sender, vdd, settings (shared), inputAllowed() (KVM at home), onChange(), needDriver?() (Extend asked, no driver)
  constructor(opts) {
    Object.assign(this, opts);
    this.mode = 'off'; // 'off' | 'mirror' | 'extend' — never saved
    this.mac = { accept: false, width: 0, height: 0, told: false }; // the viewer's screen.policy (told: it sent one)
    this.sending = null; // {session, displayId, rect (physical px), key}
    this.status = { status: 'off', error: '', name: '', width: 0, height: 0 };
    this.input = new RemoteInput(opts);
    this.busy = false;
    this.revision = 0;
    this.retries = 0;
    this.retryTimer = null;
    this.modeRequest = 0;
    this.lastMode = 'mirror'; // what screen.ctl {share:true} starts (the last mode used)
    this.stateKey = ''; // the last screen.state sent on this connection

    const link = this.link;
    link.on('welcome', () => {
      this.mac = { accept: false, width: 0, height: 0, told: false };
      this.stateKey = '';
      clearTimeout(this.policyTimer);
      this.policyTimer = setTimeout(() => { // never told: an older app, always watching
        if (!this.mac.told) { this.mac.accept = true; this.apply(); }
      }, 1500);
      this.apply();
    });
    link.on('closed', () => { ++this.modeRequest; clearTimeout(this.policyTimer); this.mac.accept = false; this.stateKey = ''; this.apply(); });
    // The session moved (Bluetooth -> a Wi-Fi Direct link, or back): a session offered on the old path
    // never connects on the new one; the transport is part of the key, so apply() starts again.
    link.on('transport', () => this.apply());
    link.on(T.SCREEN_CTL, (m) => this._onCtl(m));
    link.on(T.SCREEN_POLICY, (m) => {
      const n = (v) => (Number.isInteger(v) && v >= 320 && v <= 7680 ? v : 0);
      const size = this.mac.width + 'x' + this.mac.height;
      // A viewer that only says accept keeps the size it told before (Windows viewers send no size).
      const width = n(m.width) || (m.width === undefined ? this.mac.width : 0);
      const height = n(m.height) || (m.height === undefined ? this.mac.height : 0);
      this.mac = { accept: m.accept === true, width, height, told: true };
      if (this.mode === 'extend' && this.cfg.extendSize === 'mac' && size !== this.mac.width + 'x' + this.mac.height) this.sizeExtend();
      else this.apply();
    });
    for (const t of RemoteInput.TYPES) link.on(t, (m) => this._input(m));

    this.sender.on('state', (session, s) => {
      if (!this.sending || session !== this.sending.session) return;
      if (s.status === 'ended' || s.status === 'failed') { this._stopSend(true); this._retryLater(); }
      if (s.status === 'live') { this.retries = 0; if (this.retryTimer) clearTimeout(this.retryTimer); }
      Object.assign(this.status, s);
      this.onChange();
    });
    this.sender.on('stats', (session, st) => {
      if (!this.sending || session !== this.sending.session) return;
      this.stats = st;
      // The hardware encoder stalled (#133): the software one (OpenH264) from the next start.
      if (!this.stall || this.stall.session !== session) this.stall = Object.assign(new StallWatch(), { session });
      if (this.stall.feed(st) && encoder.fallBack('stalled')) {
        console.warn(`[pcscreen] the hardware encoder (${st.encoder || '?'}) stalled: software encoding (OpenH264) after a restart`);
        this.status.error = 'The hardware encoder stopped sending. Restart TwinDesk to use the software encoder (General › Advanced)';
      }
      this.onChange();
    });
    // A monitor came or went (or changed size): the shared one may be different now.
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) displays.on(ev, () => this.apply());
    // Win+L hands the desktop to the logon screen, which can't be captured: the picture ends there and
    // nothing else changes when it's unlocked (#81). Unlocked or awake: at once, and again a moment
    // later (the desktop may not be capturable yet).
    for (const ev of ['unlock-screen', 'resume']) powerMonitor.on(ev, () => { this.retries = 0; this.apply(); this._retryLater(); });
  }

  // The capture ended by itself: try again while it's still wanted.
  _retryLater() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (!this._wanted()) return;
    const ms = Math.min(30000, RETRY_MS * 2 ** Math.min(this.retries++, 4));
    this.retryTimer = setTimeout(() => { if (!this.sending) this.apply(); }, ms);
  }

  get cfg() {
    return this.settings.pcScreen;
  }

  async setMode(mode, prepare) {
    // 'last': this side's own Share switch, in the mode last picked here (the viewer's start is Mirror: _onCtl).
    if (mode === 'last') return this.lastMode === 'extend' ? this.extend() : this.setMode('mirror', prepare);
    if (!['off', 'mirror', 'extend'].includes(mode)) return;
    const request = ++this.modeRequest;
    if (prepare && (!(await prepare()) || request !== this.modeRequest)) return;
    if (this.busy) {
      if (mode === 'off') {
        this.mode = 'off';
        this._stopSend(true);
        this.apply();
      }
      return;
    }
    if (mode === 'extend' && !this.vdd.state.installed) mode = 'mirror'; // no virtual display driver
    const was = this.mode;
    if (mode !== 'off') this.lastMode = mode;
    this.mode = mode;
    this.status.error = '';
    this.onChange();
    if (mode === 'extend' && was !== 'extend') {
      this.busy = true;
      this.onChange();
      const size = this._extendSize();
      try {
        const [w, h] = size;
        this.vdd.addMode(w, h);
        const mon = await this.vdd.setOn(true);
        if (this.mode === 'extend' && mon && mon.name) await this.vdd.setMode(mon, w, h);
        if (!mon && this.mode === 'extend') this.mode = 'off';
      } catch (e) {
        this.mode = 'off';
        this.status.error = 'Starting Extend: ' + e.message;
      } finally {
        if (this.mode !== 'extend') await this.vdd.setOn(false).catch(() => {});
        this.busy = false;
      }
      // The viewer told its size meanwhile (sizeExtend doesn't wait while busy): that size now.
      if (this.mode === 'extend' && String(this._extendSize()) !== String(size)) return this.sizeExtend();
    } else if (was === 'extend' && mode !== 'extend') {
      this._stopSend(true);
      await this.vdd.setOn(false).catch((e) => { this.status.error = e.message; });
    }
    this.apply();
  }

  // The virtual monitor's size: chosen, or what the Mac asks for (else 1920 × 1080).
  _extendSize() {
    const m = /^(\d+)x(\d+)$/.exec(this.cfg.extendSize);
    if (m && Number(m[1]) >= 320 && Number(m[2]) >= 320 && Number(m[1]) <= 7680 && Number(m[2]) <= 7680) return [Number(m[1]), Number(m[2])];
    if (!this.mac.width || !this.mac.height) return [1920, 1080];
    // A phone tells its pixels: a monitor half that size, so text is readable there (the Mac's
    // Extend for a phone has the same size in points).
    // Windows takes no monitor with a side under 640 × 480 (a portrait phone's half is ~540 wide):
    // grown to a short side of at least 720, keeping the phone's shape.
    if (P.isPhoneOs(this.link.peerOs)) {
      const [w, h] = [this.mac.width / 2, this.mac.height / 2];
      const k = Math.max(1, 720 / Math.min(w, h));
      return [Math.round((w * k) / 2) * 2, Math.round((h * k) / 2) * 2];
    }
    return [this.mac.width, this.mac.height];
  }

  // Extend size changed while Extend is on: a size the driver doesn't know yet needs a device restart.
  async sizeExtend() {
    if (this.mode !== 'extend' || this.busy) return this.apply();
    this.busy = true;
    this.onChange();
    const size = this._extendSize();
    try {
      const [w, h] = size;
      if (this.vdd.addMode(w, h)) {
        this._stopSend(true);
        await this.vdd.setOn(false);
        if (this.mode !== 'extend') return;
        await this.vdd.setOn(true);
      }
      if (this.mode !== 'extend') return;
      const mon = await this.vdd.find().catch(() => null);
      if (mon && this.mode === 'extend') await this.vdd.setMode(mon, w, h);
    } catch (e) {
      this.mode = 'off';
      this.status.error = 'Resizing Extend: ' + e.message;
    } finally {
      if (this.mode !== 'extend') await this.vdd.setOn(false).catch(() => {});
      this.busy = false;
      if (this.mode !== 'extend') this.apply();
    }
    if (this.mode === 'extend' && String(this._extendSize()) !== String(size)) return this.sizeExtend(); // changed again meanwhile
    this.apply();
  }

  // Stream size: scale down (on the GPU, by the capturer) to at most maxHeight, keeping the shape.
  _streamSize(rect) {
    const max = this.cfg.maxHeight;
    if (!max || rect.height <= max) return [rect.width, rect.height];
    return [Math.round((rect.width * max) / rect.height / 2) * 2, max];
  }

  // The display to share: Extend → the virtual monitor; Mirror → the chosen one (else the main one).
  async _target() {
    const all = displays.getAllDisplays();
    if (this.mode === 'extend') {
      const mon = await this.vdd.find().catch(() => null);
      if (!mon) return null;
      return all.find((d) => { const r = displays.dipToScreenRect(null, d.bounds); return r.x === mon.x && r.y === mon.y; }) || null;
    }
    return all.find((d) => String(d.id) === this.cfg.monitor) || displays.getPrimaryDisplay();
  }

  // After welcome, a policy, a settings or display change.
  async apply() {
    ++this.revision;
    if (!this._wanted()) this._stopSend(this.link.status.state === 'connected');
    if (this.applying) { this.again = true; return; }
    this.applying = true;
    try {
      do {
        this.again = false;
        const revision = this.revision;
        try {
          await this._applyOnce(revision);
        } catch (e) {
          if (revision === this.revision) {
            this._stopSend(true);
            Object.assign(this.status, { status: 'failed', error: 'Capturing: ' + e.message });
          }
        }
      } while (this.again);
    } finally {
      this.applying = false;
    }
    this.onChange();
  }

  _wanted() {
    return this.link.status.state === 'connected' && this.mode !== 'off' && !this.busy && this.mac.accept &&
      (!this.link.current || this.link.current.transport !== 'ble');
  }

  async _applyOnce(revision) {
    const connected = this.link.status.state === 'connected';
    // Bluetooth can't carry the picture: it starts once the session is on Wi-Fi (netlink.js).
    const transport = (this.link.current && this.link.current.transport) || 'ip';
    const want = connected && this.mode !== 'off' && !this.busy && this.mac.accept && transport !== 'ble';
    if (!want) return this._stopSend(connected);
    const d = await this._target();
    if (revision !== this.revision || !this._wanted()) return;
    if (!d) return this._stopSend(true);
    const rect = displays.dipToScreenRect(null, d.bounds);
    const [width, height] = this._streamSize(rect);
    const fps = PcScreen.fps(d, this.cfg.fps);
    // Playback › Steady is set up per session (shared/screencodec.js steady()): a change starts a new one.
    const steady = !!(this.settings.monitor && this.settings.monitor.pacing === 'steady');
    const key = [d.id, rect.x, rect.y, rect.width, rect.height, width, this.cfg.mbps, this.cfg.sound, fps, transport, steady].join(',');
    if (this.sending && this.sending.key === key) return;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (revision !== this.revision || !this._wanted()) return;
    const src = sources.find((s) => s.display_id === String(d.id));
    if (!src) {
      this.status.error = 'Windows didn’t offer that monitor for capture';
      return this._stopSend(true);
    }
    this._stopSend(true);
    const mbps = this.cfg.mbps; // Share screen › Quality, for phones too
    const session = this.sender.start({ sourceId: src.id, width, height, mbps, fps, steady, audio: this.cfg.sound, offer: { kind: 'screen' } });
    this.sending = { session, displayId: d.id, rect, key };
    this.stats = null;
    Object.assign(this.status, { status: 'starting', error: '', name: d.label || src.name, width: rect.width, height: rect.height });
  }

  // What we offer the viewer: Extend only with the virtual display driver.
  // Extend from a menu or the viewer. Without the display driver: Mirror for now, and the Share
  // screen tab here, where Install is (needDriver; never an administrator prompt from afar).
  extend() {
    if (this.vdd.state.checked && !this.vdd.state.installed) {
      if (this.needDriver) this.needDriver();
      return this.setMode('mirror');
    }
    return this.setMode('extend');
  }

  // Both, always: the viewer keeps its Extend button even before the driver is here (extend()).
  _modes() {
    return ['extend', 'mirror'];
  }

  // screen.state after welcome and whenever any of it changes (called with every state push).
  sendState() {
    if (this.link.status.state !== 'connected') return void (this.stateKey = '');
    const msg = { t: T.SCREEN_STATE, on: this.mode !== 'off', mode: this.mode, remote: this.cfg.remote, modes: this._modes(), touch: true };
    const key = JSON.stringify(msg);
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.link.send(msg);
  }

  // The viewer starts/stops our sharing or switches Extend/Mirror, if we let it.
  _onCtl(m) {
    // The phone viewer's Close stops sharing even when the viewer may not start and switch it.
    if (m.share === false && m.close === true) return this.setMode('off');
    if (!this.cfg.remote) {
      this.stateKey = ''; // re-send: remote false
      return this.onChange();
    }
    const mode = m.mode === 'extend' || m.mode === 'mirror' ? m.mode : null;
    if (m.share === false) return this.setMode('off');
    if (mode && (m.share === true || this.mode !== 'off')) return mode === 'extend' ? this.extend() : this.setMode(mode);
    if (mode) { this.lastMode = mode; return this.onChange(); }
    // Started from the viewer: Mirror (a virtual display doesn't always start); Extend is its switch.
    if (m.share === true && this.mode === 'off') return this.setMode('mirror');
  }

  // Frames per second to send: the display's refresh rate (30–120), so motion is never decimated.
  // cap: Share screen › Frame rate (30 or 60; 0 = the display's).
  static fps(d, cap = 0) {
    const hz = Math.min(120, Math.max(30, Math.round((d && d.displayFrequency) || 60)));
    return cap === 30 || cap === 60 ? Math.min(cap, hz) : hz;
  }

  _stopSend(tellMac) {
    this.input.release();
    if (!this.sending) return;
    const { session } = this.sending;
    this.sending = null;
    this.stats = null;
    this.status.status = 'off';
    this.sender.stop(session, tellMac);
  }

  // in.* from the Mac's PC window (no `wid`; those are app windows, pcapps.js): coordinates are
  // normalized over the shared monitor.
  _input(m) {
    if (!this.sending || m.wid != null) return;
    const r = this.sending.rect;
    const at = (x, y) => ({ x: Math.round(r.x + x * (r.width - 1)), y: Math.round(r.y + y * (r.height - 1)) });
    this.input.handle(m, (x, y) => this.helper.send('moveTo', at(x, y)), null, (x, y, pen) => this.helper.send('pen', { ...at(x, y), pen }),
      false, (list) => this.helper.send('touch', RemoteInput.touchCmd(list, at)));
  }

  applyInput() {
    if (!this.settings.pcScreen.input) this.input.release();
  }

  // Monitors for the Mirror picker.
  monitors() {
    const primary = displays.getPrimaryDisplay().id;
    const v = this.vdd.state.on && this.vdd.mon; // the virtual monitor is Extend's, not Mirror's
    return displays.getAllDisplays()
      .map((d) => ({ d, r: displays.dipToScreenRect(null, d.bounds) }))
      .filter(({ r }) => !(v && r.x === v.x && r.y === v.y))
      .map(({ d, r }, i) => {
        // The monitor's own name; a laptop panel often has none (real names, not 'Monitor').
        const name = d.label || (d.internal ? 'Built-in screen' : 'Monitor ' + (i + 1));
        return { id: String(d.id), label: name + ', ' + r.width + ' × ' + r.height + (d.id === primary ? ' (main)' : '') };
      });
  }

  // Sharing ends with the app; the virtual monitor too.
  shutdown() {
    const extended = this.mode === 'extend' || this.busy;
    this.mode = 'off';
    ++this.modeRequest;
    ++this.revision;
    clearTimeout(this.policyTimer);
    this._stopSend(true);
    if (extended && !this.busy) this.vdd.setOn(false).catch(() => {});
  }

  view() {
    return { ...this.cfg, mode: this.mode, busy: this.busy, mac: this.mac, ...this.status, stats: this.stats || null, extendPx: this._extendSize(), sending: !!this.sending, monitors: this.monitors(), vdd: this.vdd.view() };
  }
}

module.exports = PcScreen;
