// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared cursor + keyboard: the state machine for both roles, one partner at a time.
//   driving: this Mac's input goes to the partner device (owner)
//   driven:  the partner device's input drives this Mac
// Ownership model adapted from Beamer (one owner of the input at a time, routes, fail open).
//
// Messages come through the hub's bus, which says which device each one is from (`from`), so a
// message from a device that is not the partner is never mistaken for the partner's. The partner
// is the device our input goes to (driving) or comes from (driven). A phone partner is driven through
// the phone bridge (phone-bridge.js): its replies come back here through onPartnerMessage().
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const E = require('../shared/kvm-edges.js');
const store = require('./store');

// {them} = the other computer's name (Kvm._them).
const REFUSED = { busy: '{them} is using this computer right now', not_allowed: '{them} doesn’t accept input from here' };

class Kvm extends EventEmitter {
  // hub: hub.js (bus, sessions, select, selectedId, device); helper: the Mac helper; getSettings;
  // clipboard, input, drop, fileSend: the features; layoutSync: layout-sync.js (the edges come from it).
  constructor({ hub, layoutSync, helper, getSettings, clipboard, input, drop, fileSend }) {
    super();
    Object.assign(this, { hub, layoutSync, helper, getSettings, clipboard, input, drop, fileSend });
    this.dragOut = null; // id of our file drag while it is on the PC and not yet dropped
    fileSend.on('policy', () => this.config());
    fileSend.on('dragEnd', (drag) => {
      if (this.dragOut === drag) this.dragOut = null;
    });
    drop.dragIn.isDriven = () => this.mode === 'driven';
    this.mode = 'home';
    this.route = 0;
    this.peerRoute = 0;
    this.partner = null; // the device our input goes to (driving) or comes from (driven); null at home
    this.keyboardOnly = false; // the hotkey moved the keyboard only (no edge, no mouse)
    this.lastName = '';
    this.message = '';
    this.tapError = null;
    this.acceptTimer = null;
    this.pendingMove = null; // coalesced k.mm while driving
    this.local = null; // phone-bridge.js: drives a phone itself (its input goes through adb, not the link)

    // Message types -> handler(m, fromId). The bus delivers them; onPartnerMessage() replays a phone bridge's.
    const K = [P.T.K_MOVE, P.T.K_DOWN, P.T.K_UP, P.T.K_WHEEL, P.T.K_KEY_DOWN, P.T.K_KEY_UP];
    this.handlers = {
      [P.T.KVM_TAKE]: (m, from) => this._onTake(m, from),
      [P.T.KVM_LINK]: (m, from) => this._onLink(m, from), // the other side switched it: follow, no echo
      [P.T.KVM_LAYOUT]: () => {}, // an older app's edge: the shared layout is the one map (layout-sync.js)
      [P.T.KVM_ACCEPT]: (m, from) => {
        if (this.mode === 'driving' && from === this.partner && m.route === this.route) clearTimeout(this.acceptTimer);
      },
      [P.T.KVM_REFUSE]: (m, from) => {
        if (this.mode === 'driving' && from === this.partner && m.route === this.route) this.goHome(this._them(REFUSED[m.why] || '{them} refused', from), false);
      },
      [P.T.KVM_HOME]: (m, from) => {
        if (this.mode !== 'driving' || from !== this.partner || m.route !== this.route) return;
        const side = this._sideOf(from);
        this.helper.send('capture', typeof m.offset === 'number' && side ? { on: false, side, offset: m.offset } : { on: false });
        this._setMode('home', '');
      },
      [P.T.KVM_RELEASE]: (m, from) => {
        if (this.mode === 'driven' && from === this.partner && m.route >= this.peerRoute) this._drivenHome('');
      },
      [P.T.KVM_NEXT]: (m, from) => this._onNext(m, from), // a device we drive hands the input on (a chain)
      [P.T.K_GESTURE]: (m, from) => this._onGesture(m, from),
    };
    for (const t of K) this.handlers[t] = (m, from) => this._onK(m, from);
    for (const t of Object.keys(this.handlers)) this.hub.bus.on(t, (m, from) => this.handlers[t](m, from));

    this.hub.bus.onPeer('welcome', (id) => this._onPeerUp(id));
    this.hub.bus.onPeer('closed', (id) => this._onPeerDown(id));
    this.hub.on('selected', (id) => this._onSelected(id));

    setInterval(() => this._tick(), 250);
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

  // The phone bridge drives a phone: attach it so its replies (accept, refuse, home) come here
  // as messages from the partner. Called once by main.js and by the tests.
  attachLocal(bridge) {
    this.local = bridge;
    if (bridge) bridge.reply = (msg) => this.onPartnerMessage(this.partner, msg);
  }

  // A message as if the partner device had sent it (the phone bridge's replies).
  onPartnerMessage(id, msg) {
    if (!id || !msg) return;
    const fn = this.handlers[msg.t];
    if (fn) fn(msg, id);
  }

  // What this Mac's edges lead to: { left, right, top, bottom }, device id or null. The shared layout
  // puts the nearest device on each side (docs/mesh.md, "Shared layout").
  get edges() {
    return this.layoutSync.neighbors();
  }

  // The shared layout changed (here or on another device): the helper watches the new sides, and each
  // connected device is told which side it is on, as the older apps expect (kvm.layout).
  layoutChanged() {
    this.config();
    for (const id of this.hub.bus.connectedIds()) {
      const side = this._sideOf(id);
      if (side) this._send(id, { t: P.T.KVM_LAYOUT, pcSide: side }); // its edge towards us is the opposite
    }
  }

  // A device was forgotten: it leaves the shared layout (a person's edit, synced to the others).
  forgetDevice(id) {
    this.layoutSync.remove(id);
    this.config();
  }

  // Settings changed (ipc.js setKvm): the switch follows the other computer, the rest is applied here.
  settingsChanged(prev) {
    if (prev && prev.linked !== this.cfg.linked) {
      const on = this.linked;
      this.cfg.linked = prev.linked; // setLinked does the work (home first, tell the peer)
      return this.setLinked(on);
    }
    this.config();
    const k = this.cfg;
    if (this.mode === 'driving' && !k.driveOther) this.goHome('Turned off');
    if (this.mode === 'driven' && !k.beDriven) this._sendHome(undefined, 'Turned off');
  }

  // Messages name the other computer (it may be gone already: the last name we knew).
  _them(text, id = this.partner) {
    const s = id ? this.hub.sessions.get(id) : null;
    if (s && s.connected) this.lastName = s.displayName();
    return text.replace(/\{them\}/g, this.lastName || 'The other computer');
  }

  get view() {
    return { where: this.mode, message: this.message, tapError: this.tapError };
  }

  // Device id -> connected now.
  _connectedTo(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return !!s && s.connected;
  }

  // The side of this Mac that leads to device id (null: none).
  _sideOf(id) {
    return E.edgeForPeer(this.edges, id);
  }

  _peerOs(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return s ? s.peerOs : P.OS.MAC;
  }

  _send(id, msg) {
    return this.hub.bus.send(id, msg);
  }

  // Tell the helper where the crossing sides are and whether edge crossing is armed.
  // Call after settings.kvm or the link changed.
  config() {
    const k = this.cfg;
    const sides = this._watchedSides();
    this.helper
      .request('kvmConfig', {
        side: sides[0] || null, sides, resistancePx: k.resistancePx, keyboard: !!k.keyboard,
        driveOther: sides.length > 0,
        hotkey: this.getSettings().keys.hotkey || P.HOTKEY_MAC,
        gestures: k.gestures !== false, // Trackpad gestures go over as k.ge
        dragFiles: this.fileSend.dragOn && this.fileSend.peerDrag, // drag.policy, both sides
      })
      .then(() => this._setTapError(null), (e) => this._setTapError(e.message));
  }

  // The sides the helper watches: a side whose device is connected, while cursor sharing is on.
  _watchedSides() {
    const k = this.cfg;
    if (!this.linked || !k.driveOther || !k.mouse) return [];
    const edges = this.edges;
    return E.SIDES.filter((side) => !!edges[side] && this._connectedTo(edges[side]));
  }

  // Mouse and keyboard sharing as a whole (the hotkey's double-tap): off = everything home and
  // nothing crosses either way. `tell`: also switch the other computer (kvm.link), which follows.
  get linked() {
    return this.cfg.linked !== false;
  }

  setLinked(on, tell = true, card = true) {
    const id = this._connectedTo(this.hub.selectedId) ? this.hub.selectedId : null;
    if (id) this.cfg.linkedBy = { ...(this.cfg.linkedBy || {}), [id]: on }; // per pair
    if (on === this.linked) {
      if (id) store.saveSettings(this.getSettings());
      return;
    }
    if (!on) this.home();
    this.cfg.linked = on;
    store.saveSettings(this.getSettings());
    if (tell && id) this._send(id, { t: P.T.KVM_LINK, on });
    this.config();
    if (card) this.emit('linked', on, tell); // hud.js: the big card
    this.emit('change');
  }

  // The other side switched cursor sharing (kvm.link). For the selected device it is the switch itself.
  _onLink(m, from) {
    const on = m.on !== false;
    if (from === this.hub.selectedId) this.setLinked(on, false);
    else {
      this.cfg.linkedBy = { ...(this.cfg.linkedBy || {}), [from]: on };
      store.saveSettings(this.getSettings());
    }
  }

  // The selection changed: cursor sharing follows the selected device's own memory.
  _onSelected(id) {
    const by = this.cfg.linkedBy || {};
    if (id && id in by && by[id] !== this.linked) this.setLinked(by[id], false, false);
    this.config();
  }

  // A device came up. A device that dialled us gets our cursor state (and our side of it).
  _onPeerUp(id) {
    const s = this.hub.sessions.get(id);
    if (s && s.hostUp && !s.linkUp) {
      const side = this._sideOf(id);
      if (side) this._send(id, { t: P.T.KVM_LAYOUT, pcSide: side });
      this._send(id, { t: P.T.KVM_LINK, on: this.linked });
    }
    this.config();
  }

  _onPeerDown(id) {
    if ((this.mode === 'driving' || this.mode === 'driven') && id === this.partner) {
      if (this.mode === 'driving') this.goHome(this._them('{them} disconnected', id));
      else this._drivenHome(this._them('{them} disconnected', id));
    }
    this.config();
  }

  _setTapError(err) {
    if (this.tapError === err) return;
    this.tapError = err;
    this.emit('change');
  }

  _setMode(mode, message) {
    const prev = this.mode;
    if (prev !== mode) console.log(`[kvm] ${prev} -> ${mode}${message ? ` (${message})` : ''}`);
    this.mode = mode;
    if (mode === 'home') this.partner = null;
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
    const s = this.partner ? this.hub.sessions.get(this.partner) : null;
    if (!s || !s.connected || Date.now() - s.lastRx > P.KVM_SILENCE_MS) {
      const text = this._them('{them} stopped answering');
      if (this.mode === 'driving') this.goHome(text);
      else this._drivenHome(text);
    }
  }

  // ---- owner: this Mac drives a device ----

  _canDrive() {
    return this.mode === 'home' && this._canDriveTo(this.hub.selectedId);
  }

  _canDriveTo(id) {
    return this._connectedTo(id) && !!this.cfg.driveOther && this.linked;
  }

  // id: the device the input goes to (the selected one for the hotkey, the neighbour for an edge).
  _take(fields, id) {
    const k = this.cfg;
    this.route++;
    this.partner = id || null;
    this.keyboardOnly = !fields.where.side;
    this._setMode('driving', '');
    this.input.releaseAll();
    const take = { t: P.T.KVM_TAKE, route: this.route, mouse: !!k.mouse && !this.keyboardOnly, keyboard: !!k.keyboard, ...fields.where };
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
      if (this.mode === 'driving' && this.route === route) this.goHome(this._them('{them} didn’t answer'));
    }, P.KVM_TAKE_TIMEOUT_MS);
  }

  // Row 9: take our input home (helper stops capturing). Tells the partner unless it refused.
  goHome(message, tellPeer = true) {
    if (this.mode !== 'driving') return;
    if (this.dragOut) {
      this.fileSend.cancelDrag(this.dragOut, true); // came back without dropping the files on the PC
      this.dragOut = null;
    }
    this.helper.send('capture', { on: false });
    if (tellPeer && this.partner) this._drive({ t: P.T.KVM_RELEASE, route: ++this.route });
    this._setMode('home', message);
  }

  _flushMove() {
    const m = this.pendingMove;
    this.pendingMove = null;
    if (m && this.mode === 'driving') this._drive({ t: P.T.K_MOVE, dx: m.dx, dy: m.dy });
  }

  // Input while driving goes to the partner: to the phone bridge when the partner is the phone, else to
  // that device's socket.
  _drive(msg) {
    if (!this.partner) return;
    if (this.local && this.local.drives(this.partner)) this.local.handle(msg);
    else this._send(this.partner, msg);
  }

  _onHelper(name, ev) {
    const k = this.cfg;
    switch (name) {
      case 'edge':
        this._onEdge(ev);
        break;
      // Double-tap: switches mouse and keyboard sharing off (everything home)
      // and on again. In keyboard-only mode (Cursor off + "Switch the keyboard with the hotkey") it
      // moves the keyboard over and back instead.
      case 'hotkey':
        if (k.hotkeySwitch && !k.mouse && k.keyboard && this.linked) {
          if (this.mode === 'home') {
            if (!this._canDrive()) return;
            this.helper.send('capture', { on: true, mouse: false, keyboard: true });
            this._take({ where: {} }, this.hub.selectedId);
          } else this.home();
          break;
        }
        // Off (by the switch, the hotkey or the other computer) → on, cursor included: the same
        // state the Cursor tab's one switch shows. On → off.
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
            setImmediate(() => this._flushMove());
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
        if (this.mode === 'driven') this._onReturn(ev);
        break;
    }
  }

  // The helper crossed one of our edges (ev.side) at ev.offset: take the device behind it.
  _onEdge(ev) {
    const side = E.SIDES.includes(ev.side) ? ev.side : null;
    const id = side ? this.edges[side] : null;
    if (this.mode !== 'home' || !id || !this._canDriveTo(id) || !this.cfg.mouse || (this.blockEdge && this.blockEdge())) {
      // The helper already captures (it started at the edge); undo that if we can't cross.
      this.helper.send('capture', { on: false });
      if (!this.hub.bus.connectedIds().length) this._setMode('home', 'Nothing connected');
      return;
    }
    if (!this.hub.select(id)) {
      this.helper.send('capture', { on: false });
      return;
    }
    this._take({ where: { side: P.opposite(side), offset: ev.offset }, paths: ev.drag && ev.drag.paths }, id);
  }

  // ---- driven: a device drives this Mac ----

  _onTake(m, from) {
    const refuse = (why) => this._send(from, { t: P.T.KVM_REFUSE, route: m.route, why });
    if (this.mode === 'driving') return refuse(P.REFUSE.BUSY);
    if (this.mode === 'driven' && from !== this.partner) return refuse(P.REFUSE.BUSY); // another device drives us
    if (!this.cfg.beDriven || !this.linked) return refuse(P.REFUSE.NOT_ALLOWED);
    if (this.mode === 'driven' && !(m.route > this.peerRoute)) return;
    const first = this.mode !== 'driven';
    this.partner = from;
    this.peerRoute = m.route;
    if (m.drag) console.log(`[drag] in: the PC crossed with a drag of ${m.drag.count} item(s)`);
    if (m.drag) this.drop.armDrag();
    this._setMode('driven', '');
    this._send(from, { t: P.T.KVM_ACCEPT, route: m.route });
    if (first) this.input.releaseAll();
    if (m.mouse !== false) {
      if (typeof m.side === 'string') this.helper.send('place', { side: m.side, offset: Number(m.offset) || 0.5 });
      else if (first) this.helper.send('place', { center: true });
      this._armReturn();
    }
    this.drop.dragIn.onDriven(); // after 'place': the native drag starts where the pointer came in
  }

  // The sides of this Mac that have a device behind them: while we are driven the helper watches them
  // (the way back to the driver, and every edge that leads on to another device).
  _returnSides() {
    const edges = this.edges;
    return E.SIDES.filter((side) => !!edges[side]);
  }

  _armReturn() {
    this.helper.send('armReturn', { on: true, sides: this._returnSides(), resistancePx: this.cfg.resistancePx });
  }

  // The helper saw the pointer leave this Mac (driven) through msg.side. Back to the driver: kvm.home as
  // before. Past another device: kvm.next, so the driver takes that device (see _onNext). Nothing behind
  // that side: ignored. The watch is armed again unless we went home, so a driver that did not take the
  // device leaves the edge live.
  _onReturn(msg) {
    const side = E.SIDES.includes(msg.side) ? msg.side : null; // an older helper says nothing: the way back
    if (!side || side === this.layoutSync.sideTo(this.partner)) return this._sendHome(msg.offset, '');
    const to = this.layoutSync.across(side);
    if (to && to !== this.partner) this._send(this.partner, { t: P.T.KVM_NEXT, route: this.peerRoute, to, side, offset: Number(msg.offset) || 0 });
    this._armReturn();
  }

  // A device we drive (the partner) reached an edge that leads to device `to` (kvm.next): the chain. Only the
  // one we drive may say it, only for a neighbour in the layout that is connected to us, and never from a
  // phone (it ends a chain). We release the device and take `to`, as an edge crossing would: the device it
  // reached sees the input come in through the side opposite to the one it left by.
  _onNext(m, from) {
    if (this.mode !== 'driving' || from !== this.partner || m.route !== this.route || this.keyboardOnly) return;
    if (this._peerOs(from) === P.OS.ANDROID) return; // a phone has no edges of its own: it ends a chain
    const side = E.SIDES.includes(m.side) ? m.side : null;
    const to = typeof m.to === 'string' ? m.to : '';
    if (!side || !to || to === from || to === this.hub.device.id) return;
    if (this.layoutSync.across(side, from) !== to) return; // not the device next to `from` on that side
    if (!this._canDriveTo(to) || !this.cfg.mouse) return; // connected, and our switch and cursor sharing for it
    if (!this.hub.select(to)) return;
    this.route++;
    this._send(from, { t: P.T.KVM_RELEASE, route: this.route }); // the device we drove goes home
    this._take({ where: { side: P.opposite(side), offset: Number(m.offset) || 0 } }, to);
  }

  _onK(m, from) {
    if (this.mode !== 'driven' || from !== this.partner) return;
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
        ev = { t: m.t, code: this._swapKeys(from) ? P.mapKeyFromOtherPlatform(m.code) : m.code };
    }
    this.helper.send('inject', { ev });
  }

  // Ctrl/Cmd swap for keys from a device (never between two Macs).
  _swapKeys(id) {
    return this.getSettings().keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.MAC, this._peerOs(id));
  }

  // A trackpad gesture from the other computer, done the Mac way. Pinches and
  // system swipes become real macOS gesture events (Gesture.swift), so macOS itself zooms and
  // moves Spaces / Mission Control with the fingers. One-off gestures (from a PC), and everything
  // when MACSHARE_GESTURE_KEYS=1, use Mac keys (no Ctrl/Cmd swap) and Mission Control's own app.
  _onGesture(m, from) {
    if (this.mode !== 'driven' || from !== this.partner || this.cfg.gestures === false || !m || typeof m.g !== 'string') return;
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
      return this._onGesture({ g: m.mean }, from);
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

  // Rows 8c: send the input home to the partner (return edge or hotkey).
  _sendHome(offset, message) {
    if (this.mode !== 'driven') return;
    const msg = { t: P.T.KVM_HOME, route: this.peerRoute };
    if (typeof offset === 'number') msg.offset = offset;
    this._send(this.partner, msg);
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
