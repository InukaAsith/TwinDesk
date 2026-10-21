// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screen sharing: hidden capture window (getDisplayMedia + RTCPeerConnection, the offerer),
// session numbering, rtc.* relay between the capture window and the Windows client, stats.
// We capture only while a viewer is open on the other side (its `screen.policy
// {accept}`); a peer that never sends one is an older app and always gets the picture.
//
// Events: 'change' — this.view changed (pushed to the control window as state.stream).
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, session, desktopCapturer, webContents } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const RETRY_MS = 2000;
// A phone over Wi-Fi: a high rate only fills the radio's queues (latency) without looking sharper
// on a phone screen, and a smaller keyframe gets there sooner.
const PHONE_MBPS = 16;

// One display-media handler for the session, shared by every Stream (one per target device): the
// request tells which capture window asked, so each Stream gives its own source.
const byCapture = new Map(); // webContents id -> Stream
let handlerSet = false;
function setHandler() {
  if (handlerSet) return;
  handlerSet = true;
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const wc = req.frame ? webContents.fromFrame(req.frame) : null;
      const st = (wc && byCapture.get(wc.id)) || byCapture.values().next().value;
      cb({ video: await st._source() });
    } catch (e) {
      console.error(`[stream] no capture source: ${e.message}`);
      cb({});
    }
  });
}

class Stream extends EventEmitter {
  constructor(server, displays, getSettings, hub) {
    super();
    this.server = server;
    this.displays = displays;
    this.getSettings = getSettings;
    this.hub = hub; // shared system-audio capture (audiohub.js)
    this.audio = { on: false, error: null }; // sound travelling with the screen
    this.win = null;
    this.session = 0;
    this.active = null; // {session, displayId, width, height} while a session runs
    this.retryTimer = null;
    this.viewer = null; // the peer's screen.policy accept; null = never said (older app: always watching)
    this.view = { status: 'off', display: null, width: 0, height: 0, fps: 0, mbps: 0, encoder: '', codec: '' };

    this.choice = null; // this target's own choice {mode: 'none'|'mirror'|'virtual', displayId?}; null = the shared settings
    this.audioOk = () => true; // StreamSet: only the active target's stream carries the sound
    setHandler();

    // A new peer says within moments whether its viewer is open (screen.policy); an older app never
    // does. So wait up to 1.5 s before sending anything, then treat silence as "watching".
    server.on('client', () => {
      this.viewer = null;
      this.waitingPolicy = true;
      clearTimeout(this.policyTimer);
      this.policyTimer = setTimeout(() => {
        this.waitingPolicy = false;
        if (this.viewer === null) this.restart('older viewer');
      }, 1500);
      this._stopWindow(this.getSettings().sharing.on ? 'no viewer' : 'off');
    });
    server.on(`t:${P.T.SCREEN_POLICY}`, (msg) => {
      const on = !!msg.accept;
      // A phone's viewer says how big it is: Extend becomes a screen of that shape.
      const c = this.server.current;
      if (c && c.os === P.OS.ANDROID && on && msg.width > 0 && msg.height > 0) {
        this.phoneSize = { width: msg.width | 0, height: msg.height | 0 };
        this.displays.setOverride(this.phoneSize);
      }
      this.waitingPolicy = false;
      clearTimeout(this.policyTimer);
      if (on === this.viewer) return;
      this.viewer = on;
      if (on) this.restart('viewer open');
      else if (this.active) this._stopWindow('no viewer');
      else this._setStatus(this.getSettings().sharing.on ? 'no viewer' : 'off');
    });
    server.on('closed', () => {
      if (!server.current || server.current.os !== P.OS.ANDROID) {
        this.phoneSize = null;
        this.displays.setOverride(null);
      }
      if (!server.current) this._stopWindow('nothing connected');
    });
    // The session moved (Bluetooth -> a Wi-Fi Direct link, or back): a session offered on the old
    // path has no candidates for the new one and never connects. Start again on this one.
    server.on('transport', (c) => {
      const moved = this.active ? this.active.transport !== c.transport : this.view.status === 'waiting for Wi-Fi' && c.transport !== 'ble';
      if (moved) this.restart(`moved to ${c.transport === 'ble' ? 'Bluetooth' : 'Wi-Fi'}`);
    });
    server.on(`t:${P.T.RTC_ANSWER}`, (msg) => this._toWindow('remote', msg));
    server.on(`t:${P.T.RTC_ICE}`, (msg) => this._toWindow('remote', msg));
    displays.on('change', () => this._displaysChanged());

    ipcMain.on('capture:out', (e, msg) => {
      if (!this._fromCapture(e) || !this.active || msg.session !== this.active.session) return;
      if (msg.t === P.T.RTC_OFFER && process.env.TWINDESK_DEBUG_STREAM) console.log(`[stream] offer #${msg.session} -> ${server.current ? server.current.name : 'nobody'}`);
      if (msg.t === P.T.RTC_OFFER || msg.t === P.T.RTC_ICE) server.sendToClient(msg);
    });
    ipcMain.on('capture:stats', (e, s) => {
      if (!this._fromCapture(e) || !this.active || s.session !== this.active.session) return;
      const { fps, mbps, encoder, codec, qp, encodeMs, limit, targetMbps } = s;
      Object.assign(this.view, { fps, mbps, encoder, codec, qp, encodeMs, limit, targetMbps });
      if (process.env.MACSHARE_DEBUG_STATS) console.log(`[stream] ${JSON.stringify(s)}`);
      if (s.width) Object.assign(this.view, { width: s.width, height: s.height });
      this.emit('change');
    });
    ipcMain.on('capture:state', (e, s) => {
      if (!this._fromCapture(e) || !this.active || s.session !== this.active.session) return;
      this._setStatus(s.status);
      if (s.status === 'failed' || s.status.startsWith('error')) this._scheduleRetry();
    });
  }

  // The display this target gets: its own choice, else what the shared settings say.
  _target() {
    const c = this.choice;
    if (c && c.mode === 'mirror') return this.displays.byId(c.displayId) || this.displays.target();
    if (c && c.mode === 'virtual') return this.displays.virtualTarget() || this.displays.target();
    return this.displays.target();
  }

  _fromCapture(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  async _source() {
    const target = this._target();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = (target && sources.find((s) => s.display_id === String(target.id))) || sources[0];
    if (!src) throw new Error('no screens (Screen Recording permission?)');
    return src;
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return Promise.resolve();
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-capture.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    byCapture.set(this.win.webContents.id, this);
    this.win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[stream] capture window gone: ${d.reason}`);
      this.win = null;
      this._scheduleRetry();
    });
    this.win.webContents.on('console-message', (e) => console.log(`[capture] ${e.message}`));
    return this.win.loadFile(path.join(__dirname, 'capture.html'));
  }

  _toWindow(channel, msg) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, msg);
  }

  _setStatus(status) {
    this.view.status = status;
    this.emit('change');
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.restart('retry'), RETRY_MS);
  }

  // Start a fresh WebRTC session (or stop, if sharing is off or no PC is connected).
  async restart(reason) {
    clearTimeout(this.retryTimer);
    if (!this.getSettings().sharing.on) return this.stop('off');
    if (!this.server.current) return this._stopWindow('nothing connected');
    if (this.viewer === false || this.waitingPolicy) return this._stopWindow('no viewer');
    if (this.choice && this.choice.mode === 'none') return this._stopWindow('off for this device');
    // Bluetooth can't carry the picture: it starts once the session is on Wi-Fi (netlink.js, 'transport').
    if (this.server.current && this.server.current.transport === 'ble') return this._stopWindow('waiting for Wi-Fi');
    const target = this._target();
    if (!target) return this._stopWindow('no display to share');

    const s = ++this.session;
    const { width, height } = this._outSize(target);
    // Sound goes with the screen only when "Share sound with the screen" is on (else: none, for latency).
    let audio = false;
    if (this.getSettings().sharing.audio && this.audioOk()) {
      await this._ensureWindow();
      audio = await this.hub.acquire('screen', this.win.webContents);
      this.audio.error = audio ? null : this.hub.error;
    } else {
      this.hub.release('screen');
    }
    this.audio.on = audio;
    if (this.session !== s) return;
    this.active = { session: s, displayId: target.id, width: target.pixelWidth, height: target.pixelHeight, transport: this.server.current.transport };
    Object.assign(this.view, { display: target.label, width, height, fps: 0, mbps: 0 });
    this._setStatus('starting');
    console.log(`[stream] session ${s} (${reason}): ${target.label} ${target.pixelWidth}x${target.pixelHeight} -> ${width}x${height}`);
    this.server.sendToClient({ t: P.T.STREAM_INFO, name: target.label, width, height, audio });
    try {
      await this._ensureWindow();
      if (!this.active || this.active.session !== s) return;
      const src = await this._source();
      const set = this.getSettings();
      const phone = this._phone();
      this._toWindow('start', {
        session: s, bitrateMbps: phone ? Math.min(PHONE_MBPS, set.bitrateMbps) : set.bitrateMbps, sourceId: src.id, width, height, audio,
        ice: (this.server.current && this.server.current.ice) || null, // a phone on the USB cable: through the relay
        fps: Math.min(120, Math.max(30, Math.round(target.hz || 60))),
      });
    } catch (e) {
      console.error(`[stream] start failed: ${e.message}`);
      this._setStatus(`error: ${e.message}`);
      this._scheduleRetry();
    }
  }

  // Capture size: the display's pixels, scaled down to settings.streamMaxHeight if that is smaller.
  // Encoding 4K costs ~30 ms of latency on an M3; a GPU downscale to 1440p costs almost nothing.
  // A phone: no more pixels than its screen has (Mirror of a big display is scaled to fit it).
  _outSize(d) {
    const max = this.getSettings().streamMaxHeight;
    let k = max && d.pixelHeight > max ? max / d.pixelHeight : 1;
    const p = this._phone() && this.phoneSize;
    if (p) k = Math.min(k, Math.max(p.width, p.height) / Math.max(d.pixelWidth, d.pixelHeight), Math.min(p.width, p.height) / Math.min(d.pixelWidth, d.pixelHeight));
    if (k >= 1) return { width: d.pixelWidth, height: d.pixelHeight };
    return { width: Math.round((d.pixelWidth * k) / 2) * 2, height: Math.round((d.pixelHeight * k) / 2) * 2 };
  }

  _phone() {
    return !!(this.server.current && this.server.current.os === P.OS.ANDROID);
  }

  _displaysChanged() {
    if (!this.active) return;
    const t = this._target();
    if (!t || t.id !== this.active.displayId || t.pixelWidth !== this.active.width || t.pixelHeight !== this.active.height) {
      this.restart('display changed');
    }
  }

  _stopWindow(status) {
    clearTimeout(this.retryTimer);
    this.hub.release('screen');
    this.audio.on = false;
    this.active = null;
    this._toWindow('stop', {});
    Object.assign(this.view, { fps: 0, mbps: 0 });
    this._setStatus(status);
  }

  // Sharing off: tell Windows too, so it shows "Mac is not sharing".
  stop(status = 'off') {
    if (this.server.current) this.server.sendToClient({ t: P.T.STREAM_STOP });
    this._stopWindow(status);
  }
}

module.exports = { Stream };
