// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared cursor + keyboard: the state machine for both roles.
//   driving: this Mac's input goes to the PC (owner)
//   driven:  the PC's input drives this Mac
// Ownership model adapted from Beamer (one owner of the input at a time, routes, fail open).
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const blepipe = require('../shared/blepipe.js');
const store = require('./store');

// {them} = the other computer's name (Kvm._them).
const REFUSED = { busy: '{them} is using this computer right now', not_allowed: '{them} doesn’t accept input from here' };
const OFF_BLE = 'Cursor sharing is off over Bluetooth';

class Kvm extends EventEmitter {
  constructor({ server, helper, getSettings, clipboard, input, drop, fileSend }) {
    super();
    Object.assign(this, { server, helper, getSettings, clipboard, input, drop, fileSend });
    this.dragOut = null; // id of our file drag while it is on the PC and not yet dropped
    fileSend.on('policy', () => this.config());
    fileSend.on('dragEnd', (drag) => {
      if (this.dragOut === drag) this.dragOut = null;
    });
    drop.dragIn.isDriven = () => this.mode === 'driven';
    this.mode = 'home';
    this.route = 0;
    this.peerRoute = 0;
    this.message = '';
    this.tapError = null;
    this.acceptTimer = null;
    this.pendingMove = null; // coalesced k.mm while driving
    this.moveTimer = null; // its flush, through Bluetooth
    this.local = null; // phone-bridge.js: drives a phone itself (its input goes through adb, not the link)
    this.drivingSide = null; // which edge was crossed
    this.drivingTarget = null; // 'computer' | 'phone'

    setInterval(() => this._tick(), 250);
    // The host tells the layout on connect; after that either side sends it when its user changes it.
    // Cursor sharing is remembered per pair: on connect take this pair's value, and the
    // host tells it so both computers agree; after that kvm.link keeps them in step.
    server.on('client', (ctx) => {
      this.lastName = ctx.name;
      const by = this.cfg.linkedBy || {};
      if (ctx.deviceId in by && by[ctx.deviceId] !== this.linked) this.setLinked(by[ctx.deviceId], false, false);
      if (ctx.role !== 'host') {
        this._sendLayout();
        server.sendToClient({ t: P.T.KVM_LINK, on: this.linked });
      }
      this.config();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.config();
      if (this.mode === 'driving') this.goHome(this._them('{them} disconnected'));
      else if (this.mode === 'driven') this._drivenHome(this._them('{them} disconnected'));
    });
    // Onto Bluetooth with Over Bluetooth off: everything home; back on Wi-Fi it crosses again.
    server.on('transport', () => this._bleCheck());
    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(P.T.KVM_TAKE, (m) => this._onTake(m));
    on(P.T.KVM_LINK, (m) => this.setLinked(m.on !== false, false));
    // kvm.layout {pcSide} = the sender's crossing side; ours is the opposite (no echo).
    on(P.T.KVM_LAYOUT, (m) => {
      const side = P.opposite(m.pcSide);
      if (!side) return;
      this.getSettings().kvm.pcSide = side;
      const cur = { ...this.edges };
      for (const s of P.SIDES) if (cur[s] === 'computer') cur[s] = null;
      cur[side] = 'computer';
      this.getSettings().kvm.edges = cur;
      store.saveSettings(this.getSettings());
      this.config();
      this.emit('change');
    });
    on(P.T.KVM_ACCEPT, (m) => {
      if (this.mode === 'driving' && m.route === this.route) clearTimeout(this.acceptTimer);
    });
    on(P.T.KVM_REFUSE, (m) => {
      if (this.mode === 'driving' && m.route === this.route) this.goHome(this._them(REFUSED[m.why] || '{them} refused'), false);
    });
    on(P.T.KVM_HOME, (m) => {
      if (this.mode !== 'driving' || m.route !== this.route) return;
      const k = this.cfg;
      const side = this.drivingSide || k.pcSide;
      this.helper.send('capture', typeof m.offset === 'number' ? { on: false, side, offset: m.offset } : { on: false });
      this.drivingSide = null;
      this.drivingTarget = null;
      this._setMode('home', '');
    });
    on(P.T.KVM_RELEASE, (m) => {
      if (this.mode === 'driven' && m.route >= this.peerRoute) this._drivenHome('');
    });
    for (const t of [P.T.K_MOVE, P.T.K_DOWN, P.T.K_UP, P.T.K_WHEEL, P.T.K_KEY_DOWN, P.T.K_KEY_UP]) on(t, (m) => this._onK(m));
    on(P.T.K_GESTURE, (m) => this._onGesture(m));

    helper.on('ready', () => setTimeout(() => this.config(), 150));
    helper.on('exit', () => {
      if (this.mode === 'driving') this.goHome('The helper stopped');
      else if (this.mode === 'driven') this._drivenHome('The helper stopped');
    });
    helper.on('event', (name, ev) => this._onHelper(name, ev));
  }

  get cfg() {
    return this.getSettings().kvm;
  }

  // Messages name the other computer (it may be gone already: the last name we knew).
  _them(text) {
    if (this.server.current) this.lastName = this.server.current.name;
    return text.replace(/\{them\}/g, this.lastName || 'The other computer');
  }

  get view() {
    return {
      where: this.mode,
      message: this.message,
      tapError: this.tapError,
      paused: this.paused,
      edges: this.edges,
      drivingTarget: this.drivingTarget,
    };
  }

  // Edge layout map: { left: 'computer' | 'phone' | null, right: ..., top: ..., bottom: ... }
  get edges() {
    const k = this.cfg;
    if (k.edges && typeof k.edges === 'object') return k.edges;
    const compSide = k.pcSide || 'right';
    return {
      left: compSide === 'left' ? 'computer' : null,
      right: compSide === 'right' ? 'computer' : null,
      top: compSide === 'top' ? 'computer' : null,
      bottom: compSide === 'bottom' ? 'computer' : null,
    };
  }

  setEdge(side, target) {
    if (!P.SIDES.includes(side)) return;
    const k = this.cfg;
    const cur = { ...this.edges };
    if (target === 'computer') {
      for (const s of P.SIDES) if (cur[s] === 'computer') cur[s] = null;
      cur[side] = 'computer';
      k.pcSide = side;
      this._sendLayout();
    } else if (target === 'phone') {
      for (const s of P.SIDES) if (cur[s] === 'phone') cur[s] = null;
      cur[side] = 'phone';
    } else {
      if (cur[side] === 'computer') k.pcSide = null;
      cur[side] = null;
    }
    k.edges = cur;
    store.saveSettings(this.getSettings());
    this.config();
    this.emit('change');
  }

  get activeSides() {
    const edges = this.edges;
    const active = [];
    const phoneReady = !!(this.local && this.local.drives());
    const compReady = !!this.server.current;
    for (const [side, target] of Object.entries(edges)) {
      if (target === 'computer' && compReady) active.push(side);
      else if (target === 'phone' && phoneReady) active.push(side);
    }
    return active.join(',');
  }

  // Tell the helper where the crossing side is and whether edge crossing is armed.
  // Call after settings.kvm or the link changed.
  config() {
    const k = this.cfg;
    const sides = this.activeSides;
    this.helper
      .request('kvmConfig', {
        side: sides || k.pcSide,
        resistancePx: k.resistancePx,
        keyboard: !!k.keyboard,
        driveOther: !!(this.linked && k.driveOther && k.mouse && sides && !this.paused),
        hotkey: this.getSettings().keys.hotkey || P.HOTKEY_MAC,
        gestures: k.gestures !== false, // Trackpad gestures go over as k.ge
        dragFiles: this.fileSend.dragOn && this.fileSend.peerDrag, // drag.policy, both sides
      })
      .then(() => this._setTapError(null), (e) => this._setTapError(e.message));
  }

  // Mouse and keyboard sharing as a whole (the hotkey's double-tap): off = everything home and
  // nothing crosses either way. `tell`: also switch the other computer (kvm.link), which follows.
  get linked() {
    return this.cfg.linked !== false;
  }

  setLinked(on, tell = true, card = true) {
    const c = this.server.current;
    if (c) this.cfg.linkedBy = { ...(this.cfg.linkedBy || {}), [c.deviceId]: on };
    if (on === this.linked) {
      if (c) store.saveSettings(this.getSettings());
      return;
    }
    if (!on) this.home();
    this.cfg.linked = on;
    store.saveSettings(this.getSettings());
    if (tell) this.server.sendToClient({ t: P.T.KVM_LINK, on });
    this.config();
    if (card) this.emit('linked', on, tell); // hud.js: the big card
    this.emit('change');
  }

  // Over Bluetooth (kvm.ble, the same on both: pair.sync 'ble'): off, nothing crosses either way
  // while the session runs through Bluetooth, and it crosses again once it's on Wi-Fi.
  get onBle() {
    const c = this.server.current;
    return !!c && c.transport === 'ble';
  }

  get paused() {
    return this.cfg.ble === false && this.onBle;
  }

  // The one switch (the Cursor tab, the menu bar, the hotkey's double-tap). Through Bluetooth, with
  // cursor sharing on, it is Over Bluetooth: off there leaves it on for Wi-Fi.
  setShared(on) {
    if (this.onBle && this.linked) return this._setBle(on);
    if (on && this.onBle) this.cfg.ble = true; // saved by setLinked
    this.setLinked(on);
  }

  _setBle(on) {
    if (on === (this.cfg.ble !== false)) return;
    this.cfg.ble = on;
    store.saveSettings(this.getSettings());
    this._bleCheck(); // off: everything home first
    this.emit('linked', on, true, true);
    this.emit('change');
  }

  _bleCheck() {
    this.config();
    if (!this.paused) return;
    if (this.mode === 'driving') this.goHome(OFF_BLE);
    else if (this.mode === 'driven') this._sendHome(undefined, OFF_BLE);
  }

  settingsChanged(prev) {
    if (prev && prev.linked !== this.cfg.linked) {
      const on = this.linked;
      this.cfg.linked = prev.linked; // setLinked does the work (home first, tell the peer)
      return this.setLinked(on);
    }
    if (!prev || prev.pcSide !== this.cfg.pcSide) this._sendLayout();
    this._bleCheck(); // config() too
    const k = this.cfg;
    if (this.mode === 'driving' && !k.driveOther) this.goHome('Turned off');
    if (this.mode === 'driven' && !k.beDriven) this._sendHome(undefined, 'Turned off');
  }

  _setTapError(err) {
    if (this.tapError === err) return;
    this.tapError = err;
    this.emit('change');
  }

  _sendLayout() {
    this.server.sendToClient({ t: P.T.KVM_LAYOUT, pcSide: this.cfg.pcSide });
  }

  _setMode(mode, message) {
    const prev = this.mode;
    if (process.env.TWINDESK_DEBUG_KVM && prev !== mode) console.log(`[kvm] ${prev} -> ${mode}${message ? ` (${message})` : ''}`);
    this.mode = mode;
    if (prev !== mode) this.emit('where', mode, prev); // hud.js shows it
    this.message = message || '';
    if (mode !== 'driving') {
      clearTimeout(this.acceptTimer);
      this.pendingMove = null;
    }
    this.emit('change');
  }

  _tick() {
    if (this.mode === 'home') return;
    if (this.mode === 'driving') this.helper.send('keepalive');
    const c = this.server.current;
    if (!c || Date.now() - c.lastRx > (c.transport === 'ble' ? P.KVM_SILENCE_BLE_MS : P.KVM_SILENCE_MS)) {
      if (this.mode === 'driving') this.goHome(this._them('{them} stopped answering'));
      else this._drivenHome(this._them('{them} stopped answering'));
    }
  }

  // ---- owner: this Mac drives the PC ----

  _canDrive(target = null) {
    const k = this.cfg;
    if (this.mode !== 'home' || !k.driveOther || !this.linked || this.paused) return false;
    if (target === 'computer') return !!this.server.current;
    if (target === 'phone') return !!(this.local && this.local.drives());
    return !!this.server.current || !!(this.local && this.local.drives());
  }

  _take(fields) {
    const k = this.cfg;
    this.route++;
    this.drivingSide = this.drivingSide || (fields.where && fields.where.side ? P.opposite(fields.where.side) : k.pcSide);
    this.drivingTarget = fields.target || 'computer';
    this._setMode('driving', '');
    this.input.releaseAll();
    const take = { t: P.T.KVM_TAKE, route: this.route, mouse: !!fields.mouse, keyboard: !!k.keyboard, ...fields.where };
    const plan = fields.paths && fields.paths.length ? this.fileSend.planDrag(fields.paths) : null;
    if (plan) take.drag = { count: plan.items.length };
    this._drive(take);
    if (plan) {
      this.dragOut = this.fileSend.startDrag(plan); // drag.start right after kvm.take
      console.log(`[drag] out ${this.dragOut}: ${plan.items.length} item(s), ${plan.files} file(s), ${plan.bytes} bytes`);
    } else if (fields.paths && fields.paths.length) console.log('[drag] out: nothing sendable in', fields.paths);
    this.clipboard.sendIfChanged('switch');
    clearTimeout(this.acceptTimer);
    const route = this.route;
    this.acceptTimer = setTimeout(() => {
      if (this.mode === 'driving' && this.route === route) {
        this.goHome(this.drivingTarget === 'phone' ? 'Your phone didn’t answer' : this._them('{them} didn’t answer'));
      }
    }, P.KVM_TAKE_TIMEOUT_MS);
  }

  // Row 9: take our input home (helper stops capturing). Tells the PC unless it refused.
  goHome(message, tellPeer = true) {
    if (this.mode !== 'driving') return;
    if (this.dragOut) {
      this.fileSend.cancelDrag(this.dragOut, true); // came back without dropping the files on the PC
      this.dragOut = null;
    }
    this.helper.send('capture', { on: false });
    if (this.drivingTarget === 'phone' && this.local) {
      this.local.handle({ t: P.T.KVM_RELEASE, route: ++this.route });
    } else if (tellPeer && this.server.current) {
      this._drive({ t: P.T.KVM_RELEASE, route: ++this.route });
    }
    this.drivingSide = null;
    this.drivingTarget = null;
    this._setMode('home', message);
  }

  // Through Bluetooth every message is a round trip on the radio: moves go at most every
  // KVM_MOVE_BLE_MS, and wait (still summed) while earlier bytes haven't gone out yet.
  _scheduleMove() {
    if (!this.onBle || this.drivingTarget === 'phone' || (this.local && this.local.drives())) return setImmediate(() => this._flushMove());
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      if (!this.pendingMove) return;
      if (blepipe.backlog() > P.KVM_BLE_BACKLOG) return this._scheduleMove();
      this._flushMove();
    }, P.KVM_MOVE_BLE_MS);
  }

  _flushMove() {
    const m = this.pendingMove;
    this.pendingMove = null;
    if (m && this.mode === 'driving') this._drive({ t: P.T.K_MOVE, dx: m.dx, dy: m.dy });
  }

  // Input while driving goes to the other computer, or to the phone bridge when a phone is the peer.
  _drive(msg) {
    if (this.drivingTarget === 'phone' && this.local) this.local.handle(msg);
    else this.server.sendToClient(msg);
  }

  _onHelper(name, ev) {
    const k = this.cfg;
    switch (name) {
      case 'edge': {
        // The helper already captures (it started at the edge); undo that if we can't cross.
        const crossedSide = ev.side || k.pcSide;
        const target = (this.edges && this.edges[crossedSide]) || (crossedSide === k.pcSide ? 'computer' : null);
        if (!target || !this._canDrive(target) || !k.mouse || (this.blockEdge && this.blockEdge())) {
          this.helper.send('capture', { on: false });
          if (!this.server.current && !this.local) this._setMode('home', 'Nothing connected');
          return;
        }
        this.drivingSide = crossedSide;
        this.drivingTarget = target;
        if (target === 'computer') {
          this._take({ mouse: true, target: 'computer', where: { side: P.opposite(crossedSide), offset: ev.offset }, paths: ev.drag && ev.drag.paths });
        } else if (target === 'phone') {
          this._take({ mouse: true, target: 'phone', where: { side: P.opposite(crossedSide), offset: ev.offset } });
        }
        break;
      }
      // Double-tap: switches mouse and keyboard sharing off (everything home)
      // and on again. In keyboard-only mode (Cursor off + "Switch the keyboard with the hotkey") it
      // moves the keyboard over and back instead.
      case 'hotkey':
        if (k.hotkeySwitch && !k.mouse && k.keyboard && this.linked) {
          if (this.mode === 'home') {
            if (!this._canDrive()) return;
            this.helper.send('capture', { on: true, mouse: false, keyboard: true });
            this._take({ mouse: false, where: {} });
          } else this.home();
          break;
        }
        // Off (by the switch, the hotkey or the other computer) → on, cursor included: the same
        // state the Cursor tab's one switch shows. On → off. Through Bluetooth: Over Bluetooth.
        if (this.onBle && this.linked && k.mouse) {
          this.setShared(this.paused);
          break;
        }
        if (this.onBle) k.ble = true; // off → on: Over Bluetooth too (saved below)
        if (this.linked && k.mouse) this.setLinked(false);
        else {
          if (!k.mouse) {
            k.mouse = true;
            this.config();
          }
          if (this.linked) {
            store.saveSettings(this.getSettings());
            this.emit('linked', true, true);
            this.emit('change');
          } else this.setLinked(true);
        }
        break;
      case 'ev': {
        if (this.mode !== 'driving' || !ev.ev) return;
        const e = ev.ev;
        if (this.fileClip && this.fileClip.intercept(e)) return; // copy/paste shortcut: done over there
        if (e.t === P.T.K_MOVE) {
          if (!this.pendingMove) {
            this.pendingMove = { dx: 0, dy: 0 };
            this._scheduleMove();
          }
          this.pendingMove.dx += e.dx;
          this.pendingMove.dy += e.dy;
          return;
        }
        this._flushMove();
        if (this.dragOut && e.t === P.T.K_UP && e.b === 0) this.dragOut = null; // dropped on the PC (drag.end follows)
        this._drive(e);
        break;
      }
      case 'captureEnded':
        if (this.mode === 'driving') this.goHome(ev.reason === 'deadman' ? 'Input came back by itself (safety timeout)' : '');
        break;
      case 'return':
        if (this.mode === 'driven') this._sendHome(ev.offset, '');
        break;
    }
  }

  // ---- driven: the PC drives this Mac ----

  _onTake(m) {
    const refuse = (why) => this.server.sendToClient({ t: P.T.KVM_REFUSE, route: m.route, why });
    if (this.mode === 'driving') return refuse(P.REFUSE.BUSY);
    if (!this.cfg.beDriven || !this.linked || this.paused) return refuse(P.REFUSE.NOT_ALLOWED);
    if (this.mode === 'driven' && !(m.route > this.peerRoute)) return;
    const first = this.mode !== 'driven';
    this.peerRoute = m.route;
    if (m.drag) console.log(`[drag] in: the PC crossed with a drag of ${m.drag.count} item(s)`);
    if (m.drag) this.drop.armDrag();
    this._setMode('driven', '');
    this.server.sendToClient({ t: P.T.KVM_ACCEPT, route: m.route });
    if (first) this.input.releaseAll();
    if (m.mouse !== false) {
      if (typeof m.side === 'string') this.helper.send('place', { side: m.side, offset: Number(m.offset) || 0.5 });
      else if (first) this.helper.send('place', { center: true });
      this.helper.send('armReturn', { on: true, side: this.cfg.pcSide, resistancePx: this.cfg.resistancePx });
    }
    this.drop.dragIn.onDriven(); // after 'place': the native drag starts where the pointer came in
  }

  _onK(m) {
    if (this.mode !== 'driven') return;
    const k = this.cfg;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let ev;
    switch (m.t) {
      case P.T.K_MOVE:
        ev = { t: m.t, dx: num(m.dx) * k.speed, dy: num(m.dy) * k.speed };
        break;
      case P.T.K_DOWN:
      case P.T.K_UP:
        ev = { t: m.t, b: Math.max(0, Math.min(4, num(m.b) | 0)) };
        if (m.t === P.T.K_UP && ev.b === 0) this.drop.release(); // a drag from the PC ends here
        break;
      case P.T.K_WHEEL: {
        const s = k.reverseScroll ? -1 : 1;
        ev = { t: m.t, dx: num(m.dx) * s, dy: num(m.dy) * s, mode: m.mode === 'line' ? 'line' : 'pixel' };
        break;
      }
      default:
        if (typeof m.code !== 'string' || m.code.length > 32) return;
        // Esc during a drag from the PC cancels it (injected, it would go to the frontmost app).
        if (m.code === 'Escape' && this.drop.dragIn.dragging) {
          if (m.t === P.T.K_KEY_DOWN) this.drop.dragIn.cancel();
          return;
        }
        ev = { t: m.t, code: this.server.keySwap(this.getSettings()) ? P.mapKeyFromOtherPlatform(m.code) : m.code };
    }
    this.helper.send('inject', { ev });
  }

  // A trackpad gesture from the other computer, done the Mac way. Pinches and
  // system swipes become real macOS gesture events (Gesture.swift), so macOS itself zooms and
  // moves Spaces / Mission Control with the fingers. One-off gestures (from a PC), and everything
  // when MACSHARE_GESTURE_KEYS=1, use Mac keys (no Ctrl/Cmd swap) and Mission Control's own app.
  _onGesture(m) {
    if (this.mode !== 'driven' || this.cfg.gestures === false || typeof m.g !== 'string') return;
    const native = !process.env.MACSHARE_GESTURE_KEYS;
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const PH = ['begin', 'change', 'end', 'cancel'];
    if (native && m.g === 'dock') {
      const motion = [1, 2, 3, 4].includes(m.motion) ? (m.motion === 4 ? 3 : m.motion) : 0;
      if (!motion) return;
      this.helper.send('gesture', { kind: 'dock', motion, v: num(m.v), exit: num(m.exit), phase: PH.includes(m.phase) ? m.phase : 'change' });
      return;
    }
    if (native && m.g === 'zoom') {
      // A pinch from a PC may come without phases: begin it, and end it when the steps stop.
      if (!this.pinching || m.phase === 'begin') {
        this.pinching = true;
        this.helper.send('gesture', { kind: 'zoom', v: 0, phase: 'begin' });
      }
      if (m.phase !== 'begin') this.helper.send('gesture', { kind: 'zoom', v: num(m.v), phase: 'change' });
      clearTimeout(this.pinchTimer);
      const end = () => {
        this.pinching = false;
        this.helper.send('gesture', { kind: 'zoom', v: 0, phase: 'end' });
      };
      if (m.phase === 'end') end();
      else this.pinchTimer = setTimeout(end, 250);
      return;
    }
    if (m.g === 'dock') { // keys mode: only the meaning, at the end
      if (m.phase !== 'end' || typeof m.mean !== 'string') return;
      return this._onGesture({ g: m.mean });
    }
    const combo = (...codes) => {
      for (const code of codes) this.helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
      for (const code of codes.slice().reverse()) this.helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
    };
    const mc = (arg) => require('child_process').execFile('/System/Applications/Mission Control.app/Contents/MacOS/Mission Control', arg ? [arg] : [], () => {});
    switch (m.g) {
      case 'zoom': { // pinch: ⌘+ / ⌘− for every 0.15 of magnification
        if (m.phase === 'begin') this.zoomAcc = 0;
        this.zoomAcc = (this.zoomAcc || 0) + (Number.isFinite(m.v) ? m.v : 0);
        while (this.zoomAcc >= 0.15) { combo('MetaLeft', 'Equal'); this.zoomAcc -= 0.15; }
        while (this.zoomAcc <= -0.15) { combo('MetaLeft', 'Minus'); this.zoomAcc += 0.15; }
        break;
      }
      case 'smartZoom': combo('MetaLeft', 'Digit0'); break;
      case 'back': combo('MetaLeft', 'BracketLeft'); break;
      case 'forward': combo('MetaLeft', 'BracketRight'); break;
      case 'overview': mc(); break;
      case 'appWindows': mc('2'); break;
      case 'desktop': mc('1'); break;
      case 'spaceLeft': combo('ControlLeft', 'ArrowLeft'); break;
      case 'spaceRight': combo('ControlLeft', 'ArrowRight'); break;
      case 'launcher': { // Apps (macOS 26+), else Launchpad, else Spotlight
        const open = (app, next) => require('child_process').execFile('/usr/bin/open', ['-a', app], (err) => err && next());
        open('Apps', () => open('Launchpad', () => combo('MetaLeft', 'Space')));
        break;
      }
      default: break; // rotate: no Mac-wide meaning
    }
  }

  // Rows 8c: send the input home to the PC (return edge or hotkey).
  _sendHome(offset, message) {
    if (this.mode !== 'driven') return;
    const msg = { t: P.T.KVM_HOME, route: this.peerRoute };
    if (typeof offset === 'number') msg.offset = offset;
    this.server.sendToClient(msg);
    this._drivenHome(message);
  }

  // Rows 8b / 9b: stop being driven.
  _drivenHome(message) {
    if (this.mode !== 'driven') return;
    this.drop.cancelDrag();
    this.drop.dragIn.cancel(); // before releaseAll: the held button must not drop the files
    this.helper.send('releaseAll');
    this.helper.send('armReturn', { on: false });
    this._setMode('home', message);
    this.clipboard.sendIfChanged('switch');
  }

  // Menu bar "Bring Mouse and Keyboard Back".
  home() {
    if (this.mode === 'driving') this.goHome('');
    else if (this.mode === 'driven') this._sendHome(undefined, '');
  }

  // App quitting: give everything back.
  shutdown() {
    if (this.mode === 'driving') this.goHome('');
    else if (this.mode === 'driven') this._sendHome(undefined, '');
  }
}

module.exports = { Kvm };
