// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM (docs/full-kvm.md), the Full KVM build only: linux/helper.js and windows/helper.js wrap
// their Helper in this when shared/edition.js says so (the normal build has no fullkvm/ folders and
// never loads it). With the service there and this user's (linux/fullkvm/service.js, Windows'
// TwinDeskFullKvm), the mouse-and-keyboard commands go to its helper (root on Linux, the agent as
// SYSTEM on Windows: the lock screen, polkit or UAC, the login screen) and its events come from
// there; everything else stays with ours. Ours lets go of the mouse and keyboard while the service has them, and takes them back
// when it goes. No native input lane through the service (it has no network): the Node lane injects
// through it. One-to-one and Multi-device alike (mesh/helper.js extends ../helper.js).
//
// Windows: the file-drag strip at the edge (windows-helper/src/DropEdge.cs) is ours, not the service's:
// Explorer can't drop onto a window of SYSTEM's. Ours is told what the service's capture does
// (dragStrip), and a drag it catches goes to the service (dragCross, dragHold), whose capture crosses.
'use strict';

const { SvcLink, KVM } = require('./svc-link.js');

const SVC_SOCK = process.env.TWINDESK_KVM_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\TwinDesk.kvm' : '/run/twindesk/kvm.sock');
// The helpers' mouse-and-keyboard events (linux-helper/src: capture.c, wl.c; windows-helper/src: Capture*.cs).
const KVM_EVENTS = new Set(['edge', 'return', 'ev', 'hotkey', 'captureEnded', 'released', 'local', 'shake', 'lane', 'laneEv', 'hooksReinstalled', 'secureDesktop', 'letGo']);
// Our helper's events for the service: a file drag caught on our strip (windows-helper/src/DragRelay.cs).
const TO_SERVICE = new Set(['dragCross', 'dragHold']);

module.exports = (Helper) => class FullKvmHelper extends Helper {
  constructor(...args) {
    super(...args);
    this.svc = null;
    if (!require('../edition.js').fullKvm()) return; // General › Modules › Full KVM is off: our own helper only
    this.svc = new SvcLink(SVC_SOCK);
    this.strip = { on: false, sides: [], driveOther: false, dragFiles: true, back: [], capturing: false, cross: 0 };
    this.svc.on('ready', () => {
      console.log('[fullkvm] the service has the mouse and keyboard (' + SVC_SOCK + ')');
      this._quietOwn();
      this._strip({ on: true, capturing: false, back: [] });
      this.emit('ready'); // kvm.js and main.js send their config and screens again: to the service now
    });
    this.svc.on('event', (name, msg) => {
      // The service's capture began (an edge) or the input went home: our strip waits until the pointer has left the edge.
      if (name === 'edge') this._strip({ capturing: true, cross: this.strip.cross + 1 });
      else if (name === 'return') this._strip({ cross: this.strip.cross + 1 });
      else if (name === 'captureEnded') this._strip({ capturing: false });
      this.emit('event', name, msg);
    });
    this.svc.on('exit', () => {
      console.log('[fullkvm] the service let go: our own helper again');
      this._strip({ on: false });
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

  // Our file-drag strip's view of the service's capture (Windows: windows-helper/src/DragRelay.cs).
  _strip(change) {
    if (process.platform !== 'win32' || !this.svc) return;
    this.strip = { ...this.strip, ...change };
    if (this.proc) super.send('dragStrip', this.strip);
  }

  // What kvm.js tells the service's capture, our strip hears too.
  _follow(cmd, args) {
    if (cmd === 'kvmConfig') {
      const sides = Array.isArray(args.dragSides) ? args.dragSides : Array.isArray(args.sides) ? args.sides : args.side ? [args.side] : []; // those whose device takes drags
      this._strip({ sides, driveOther: !!args.driveOther, dragFiles: args.dragFiles !== false });
    } else if (cmd === 'armReturn') {
      this._strip({ back: args.on ? (Array.isArray(args.sides) ? args.sides : args.side ? [args.side] : []) : [] });
    } else if (cmd === 'capture') {
      this._strip({ capturing: !!args.on });
    } else if (cmd === 'place') {
      this._strip({ cross: this.strip.cross + 1 }); // the pointer came here: it starts at the edge
    }
  }

  send(cmd, args = {}) {
    if (this.viaService && KVM.has(cmd)) {
      this._follow(cmd, args);
      return this.svc.send(cmd, args);
    }
    return super.send(cmd, args);
  }

  sendMove(dx, dy) {
    if (this.viaService) return this.svc.sendMove(dx, dy);
    return super.sendMove(dx, dy);
  }

  request(cmd, args = {}, ms) {
    if (this.viaService && KVM.has(cmd)) return this.svc.request(cmd, args, ms);
    // Not before the service is up either: a lane bound on our helper while it starts (kvm.js asks at
    // once) took the moves there, past the service's return watch, and the pointer never came back.
    if (this.svc && cmd === 'lane') return Promise.reject(new Error('no native lane with Full KVM'));
    return super.request(cmd, args, ms);
  }

  // Our own helper's events: its mouse-and-keyboard ones (KVM_EVENTS) are dropped while the service
  // has them; the rest (Bluetooth, shortcuts) are ours as ever.
  emit(name, ...rest) {
    if (this._fromOwn && name === 'event' && TO_SERVICE.has(rest[0])) {
      if (!this.viaService) return false;
      const { event: _e, ...args } = rest[1] || {};
      if (rest[0] === 'dragCross') { // our strip caught a drag: the service's capture crosses with it, or says why not
        this.svc.request('dragCross', args).then(() => console.log('[drag] the Full KVM service crosses with it'), (e) => console.log('[drag] the Full KVM service didn’t cross: ' + e.message));
      } else this.svc.send(rest[0], args);
      return false;
    }
    if (this._fromOwn && this.viaService && name === 'ready') { // ours started again while the service has them
      this._quietOwn();
      this._strip({});
      return false;
    }
    if (this._fromOwn && this.viaService && name === 'event' && KVM_EVENTS.has(rest[0])) return false;
    return super.emit(name, ...rest);
  }

  _data(d) {
    this._fromOwn = true;
    try { super._data(d); } finally { this._fromOwn = false; }
  }

};
