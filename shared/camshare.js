// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera sharing between two computers (the Camera tab): one computer's camera in a window on the
// other. The other computer opens the window (cam.open); this one, with Camera › "Let {name} see
// this camera" on (off until turned on), opens its camera in a hidden window (camera-send.html)
// and sends it over WebRTC (cam.offer / answer / ice through the session, the picture straight
// between the two); a popup says so while it does, and it stops when the window there closes, the
// switch goes off, Stop is pressed or the session ends. Not through Bluetooth (no path for the
// picture). Here the other's camera opens in a hidden window (camera-view.html) whose picture goes
// to the Camera tab and, with Virtual camera on, to a camera other apps can pick (shared/vcam.js);
// Camera › Window shows it.
//
// link: {on(type, fn), send(msg), connected(), ble(), closed(fn)}; cfg() → settings.camera; save();
// popup(kind, text); peerName(); onChange().
// Events: none (onChange).
'use strict';

const path = require('path');
const P = require('./protocol.js');
const I18n = require('./i18n.js');

const T = P.T;

class CamShare {
  constructor({ link, cfg, save, popup, peerName, onChange, getLanguage = () => 'en' }) {
    Object.assign(this, { link, cfg, save, popup, peerName, onChange, getLanguage });
    const { app, BrowserWindow, ipcMain } = require('electron');
    this.BrowserWindow = BrowserWindow;
    this.quitting = false; // the window's close hides it, but not on quit
    app.on('before-quit', () => { this.quitting = true; });
    this.peerShares = false; // the other computer's cam.policy
    this.sender = null; // {win, ready, queue, status}: our camera going to the other computer
    this.viewer = null; // {win, ready, queue, status, error}: theirs here
    this.devices = []; // [{id, label}] this computer's cameras (camera-send.html lists them)
    this.shareError = '';

    link.on(T.CAM_POLICY, (m) => {
      this.peerShares = !!m && m.share === true;
      if (!this.peerShares && this.viewer) this._viewStatus('refused');
      this.onChange();
    });
    link.on(T.CAM_OPEN, () => this._open());
    link.on(T.CAM_CLOSE, () => {
      this._stopSending(false);
      if (this.viewer) this._viewStatus('ended');
    });
    link.on(T.CAM_ANSWER, (m) => m && typeof m.sdp === 'string' && this._toSender({ t: 'answer', sdp: m.sdp }));
    link.on(T.CAM_OFFER, (m) => m && typeof m.sdp === 'string' && this._toViewer({ t: 'offer', sdp: m.sdp }));
    link.on(T.CAM_ICE, (m) => {
      if (!m || !m.candidate) return;
      if (m.from === 'view') this._toSender({ t: 'ice', candidate: m.candidate });
      else if (m.from === 'send') this._toViewer({ t: 'ice', candidate: m.candidate });
    });
    link.on(T.CAM_STATE, (m) => m && this._viewStatus(String(m.status || ''), String(m.error || '')));
    link.on('welcome', () => {
      this.peerShares = false;
      this.sendPolicy();
    });
    link.closed(() => {
      this.peerShares = false;
      this._stopSending(false);
      if (this.viewer) this._viewStatus('ended');
      this.onChange();
    });

    const from = (e, who) => who && who.win && !who.win.isDestroyed() && e.sender === who.win.webContents;
    ipcMain.on('cam:out', (e, m) => {
      if (!m || typeof m !== 'object') return;
      if (from(e, this.sender)) this._fromSender(m);
      else if (from(e, this.viewer)) this._fromViewer(m);
    });
  }

  get share() {
    return this.cfg().share === true && this.cfg().on !== false; // Camera's switch off: nothing shared
  }

  sendPolicy() {
    if (this.link.connected()) this.link.send({ t: T.CAM_POLICY, share: this.share });
  }

  // The tab's switch. On the Mac, macOS asks for the camera the first time (askFirst → allowed).
  async setShare(on, askFirst) {
    this.shareError = '';
    if (on && askFirst && !(await askFirst())) {
      this.shareError = 'The camera isn’t allowed for TwinDesk: allow it in System Settings › Privacy & Security › Camera';
      return this.onChange();
    }
    this.cfg().share = !!on;
    this.save();
    if (!on) this._stopSending(true);
    this.sendPolicy();
    this.onChange();
  }

  setDevice(id) {
    this.cfg().device = typeof id === 'string' ? id.slice(0, 200) : '';
    this.save();
    this.onChange();
  }

  // This computer's cameras for the tab's list (their names need no camera turned on).
  listDevices() {
    this._toSender({ t: 'devices' }, true);
  }

  // ---- ours, to the other computer ----

  _open() {
    if (!this.share) return this.link.send({ t: T.CAM_STATE, status: 'refused' });
    if (this.link.ble()) return this.link.send({ t: T.CAM_STATE, status: 'failed', error: 'needs Wi-Fi or a cable: not through Bluetooth' });
    this._stopSending(false);
    this._toSender({ t: 'start', deviceId: this.cfg().device || '' }, true);
    this.sender.status = 'starting';
    this.link.send({ t: T.CAM_STATE, status: 'starting' });
    this.popup('driven', `${this.peerName()} is viewing this computer’s camera`, { key: '{name} is viewing this computer’s camera', vars: { name: this.peerName() } });
    this.onChange();
  }

  // Stop: the camera goes off at once (its window closes); tell: the other computer's window says so.
  stopSending(tell = true) {
    this._stopSending(tell);
  }

  _stopSending(tell) {
    const s = this.sender;
    if (!s || !s.status) return;
    s.status = '';
    this._toSender({ t: 'stop' });
    if (tell && this.link.connected()) this.link.send({ t: T.CAM_CLOSE });
    this.onChange();
  }

  _fromSender(m) {
    const s = this.sender;
    if (m.t === 'ready') {
      s.ready = true;
      for (const q of s.queue.splice(0)) s.win.webContents.send('cam:in', q);
    } else if (m.t === 'devices' && Array.isArray(m.list)) {
      this.devices = m.list.slice(0, 20).map((d, i) => ({ id: String(d.id || '').slice(0, 200), label: String(d.label || '').slice(0, 100) || `Camera ${i + 1}` }));
      this.onChange();
    } else if (!s.status) {
      // stopped meanwhile
    } else if (m.t === 'offer' && typeof m.sdp === 'string') {
      this.link.send({ t: T.CAM_OFFER, sdp: m.sdp });
    } else if (m.t === 'ice' && m.candidate) {
      this.link.send({ t: T.CAM_ICE, from: 'send', candidate: m.candidate });
    } else if (m.t === 'status') {
      s.status = m.status === 'live' ? 'live' : m.status === 'failed' ? '' : s.status;
      this.link.send({ t: T.CAM_STATE, status: String(m.status || ''), error: String(m.error || '').slice(0, 200) });
      if (m.status === 'failed') this.popup('home', `The camera didn’t start: ${String(m.error || '').slice(0, 120)}`, { key: 'The camera didn’t start: {error}', vars: { error: String(m.error || '').slice(0, 120) } });
      this.onChange();
    }
  }

  _toSender(m, create = false) {
    let s = this.sender;
    if (!s || s.win.isDestroyed()) {
      if (!create) return;
      const win = new this.BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-camera.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      s = this.sender = { win, ready: false, queue: [], status: '' };
      win.loadFile(path.join(__dirname, 'camera-send.html'), { query: { language: this.getLanguage() } });
      win.on('closed', () => {
        if (this.sender === s) this.sender = null;
      });
    }
    if (s.ready) s.win.webContents.send('cam:in', m);
    else s.queue.push(m);
  }

  // ---- theirs, here ----

  // The other computer's camera here (Camera's switch): its window opens hidden, the picture goes to
  // the Camera tab and the virtual camera (shared/vcam.js); show: the window too (Camera › Window).
  // Closing that window only hides it: the camera stops with the switch.
  view(show = false) {
    if (this.cfg().on === false) return; // Camera's switch is off
    if (!this.link.connected()) return this.popup('home', 'Not connected', { key: 'Not connected' });
    const old = this.viewer;
    if (old && !old.win.isDestroyed()) {
      if (show) {
        old.win.show();
        old.win.focus();
      }
      if (old.status === 'ended' || old.status === 'refused' || old.status === 'failed') this._ask();
      return;
    }
    const name = this.peerName();
    const win = new this.BrowserWindow({
      width: 854, height: 520, minWidth: 240, minHeight: 160, title: I18n.create(this.getLanguage()).t('{name}’s camera', { name }), backgroundColor: '#000000', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-camera.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    const v = this.viewer = { win, ready: false, queue: [], status: '', error: '', ending: false };
    win.loadFile(path.join(__dirname, 'camera-view.html'), { query: { name, language: this.getLanguage() } });
    if (show) win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
      if (v.ending || this.quitting) return;
      e.preventDefault();
      win.hide();
      this.onChange();
    });
    win.on('show', () => this.onChange());
    win.on('closed', () => {
      if (this.viewer !== v) return;
      this.viewer = null;
      if (this.link.connected()) this.link.send({ t: T.CAM_CLOSE });
      this.onChange();
    });
    this._ask();
    this.onChange();
  }

  closeView() {
    const v = this.viewer;
    if (!v || v.win.isDestroyed()) return;
    v.ending = true;
    v.win.close();
  }

  _ask() {
    this._toViewer({ t: 'reset' });
    this._viewStatus('starting');
    this.link.send({ t: T.CAM_OPEN });
  }

  _viewStatus(status, error = '') {
    const v = this.viewer;
    if (!v) return;
    v.status = status;
    v.error = error;
    this._toViewer({ t: 'status', status, error, name: this.peerName() });
    this.onChange();
  }

  _fromViewer(m) {
    const v = this.viewer;
    if (m.t === 'ready') {
      v.ready = true;
      for (const q of v.queue.splice(0)) v.win.webContents.send('cam:in', q);
    } else if (m.t === 'answer' && typeof m.sdp === 'string') {
      this.link.send({ t: T.CAM_ANSWER, sdp: m.sdp });
    } else if (m.t === 'ice' && m.candidate) {
      this.link.send({ t: T.CAM_ICE, from: 'view', candidate: m.candidate });
    } else if (m.t === 'live') {
      v.status = 'live';
      this.onChange();
    } else if (m.t === 'again') {
      this._ask();
    }
  }

  _toViewer(m) {
    const v = this.viewer;
    if (!v || v.win.isDestroyed()) return;
    if (v.ready) v.win.webContents.send('cam:in', m);
    else v.queue.push(m);
  }

  // For the Camera tab (state.camera).
  get state() {
    return {
      connected: this.link.connected(),
      ble: this.link.ble(),
      shareError: this.shareError,
      share: this.share,
      device: this.cfg().device || '',
      devices: this.devices,
      peerShares: this.peerShares,
      sending: !!(this.sender && this.sender.status), // the other computer is viewing ours
      sendLive: !!(this.sender && this.sender.status === 'live'),
      viewing: !!this.viewer,
      viewShown: !!(this.viewer && !this.viewer.win.isDestroyed() && this.viewer.win.isVisible()),
      viewStatus: this.viewer ? this.viewer.status : '',
      viewError: this.viewer ? this.viewer.error : '',
    };
  }
}

module.exports = { CamShare };
