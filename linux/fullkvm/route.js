// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM (docs/full-kvm.md), the Full KVM build only: ../helper.js wraps its Helper in this when
// shared/edition.js says so (the normal build has no fullkvm/ folders and never loads it). With the
// service there and this user's (service.js), the mouse-and-keyboard commands go to its helper (root:
// the lock screen, polkit, the login screen) and its events come from there; everything else stays
// with ours. Ours lets go of the mouse and keyboard while the service has them, and takes them back
// when it goes. No native input lane through the service (it has no network): the Node lane injects
// through it. One-to-one and Multi-device alike (mesh/helper.js extends ../helper.js).
'use strict';

const { SvcLink, KVM } = require('../../shared/fullkvm/svc-link.js');

const SVC_SOCK = process.env.TWINDESK_KVM_SOCK || '/run/twindesk/kvm.sock';
// The helper's mouse-and-keyboard events (linux-helper/src: capture.c, wl.c).
const KVM_EVENTS = new Set(['edge', 'return', 'ev', 'hotkey', 'captureEnded', 'released', 'local', 'shake', 'lane', 'laneEv']);

module.exports = (Helper) => class FullKvmHelper extends Helper {
  constructor(...args) {
    super(...args);
    this.svc = new SvcLink(SVC_SOCK);
    this.svc.on('ready', () => {
      console.log('[fullkvm] the service has the mouse and keyboard (' + SVC_SOCK + ')');
      this._quietOwn();
      this.emit('ready'); // kvm.js and main.js send their config and screens again: to the service now
    });
    this.svc.on('event', (name, msg) => this.emit('event', name, msg));
    this.svc.on('exit', () => {
      console.log('[fullkvm] the service let go: our own helper again');
      if (this.proc) this.emit('ready'); else this.emit('exit', 1);
    });
    this.svc.start();
  }

  get viaService() {
    return !!this.svc && this.svc.connected;
  }

  // What the mouse and keyboard go through now ('uinput' through the service).
  get kvmBackend() {
    return this.viaService ? this.svc.backend : this.backend;
  }

  get running() {
    return this.viaService || !!this.proc;
  }

  // Ours lets go: nothing captured, armed, held or watched.
  _quietOwn() {
    if (!this.proc) return;
    super.send('capture', { on: false });
    super.send('armReturn', { on: false });
    super.send('releaseAll');
    super.send('kvmConfig', { side: null, sides: [], zones: 'none', driveOther: false, keyboard: false, takeBack: false, hotkey: 'none' });
  }

  send(cmd, args = {}) {
    if (this.viaService && KVM.has(cmd)) return this.svc.send(cmd, args);
    return super.send(cmd, args);
  }

  sendMove(dx, dy) {
    if (this.viaService) return this.svc.sendMove(dx, dy);
    return super.sendMove(dx, dy);
  }

  request(cmd, args = {}, ms) {
    if (this.viaService && KVM.has(cmd)) return this.svc.request(cmd, args, ms);
    if (this.viaService && cmd === 'lane') return Promise.reject(new Error('no native lane through Full KVM'));
    return super.request(cmd, args, ms);
  }

  // Our own helper's events: its mouse-and-keyboard ones (KVM_EVENTS) are dropped while the service
  // has them; the rest (Bluetooth, shortcuts) are ours as ever.
  emit(name, ...rest) {
    if (this._fromOwn && this.viaService && (name === 'ready' || (name === 'event' && KVM_EVENTS.has(rest[0])))) return false;
    return super.emit(name, ...rest);
  }

  _data(d) {
    this._fromOwn = true;
    try { super._data(d); } finally { this._fromOwn = false; }
  }

};
