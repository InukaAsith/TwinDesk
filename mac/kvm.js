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
const { CapsSync } = require('../shared/capsync.js');
const blepipe = require('../shared/blepipe.js');
const { KvmMoves } = require('../shared/kvm-moves.js');
const { LaneDrive, LaneDriven } = require('../shared/inputlane.js');
const { KeyLayout } = require('../shared/keylayout.js');
const CL = require('../shared/cursorlock.js');
const store = require('./store');
const { KvmMap } = require('../shared/kvm-map.js');

// {them} = the other computer's name (Kvm._them).
const REFUSED = { busy: '{them} is using this computer right now', not_allowed: '{them} doesn’t accept input from here' };
const OFF_BLE = 'Cursor sharing is off over Bluetooth';
// Input that goes numbered (es) and fenced when there's an input lane (shared/inputlane.js).
const LANE_EVENTS = new Set([P.T.K_DOWN, P.T.K_UP, P.T.K_WHEEL, P.T.K_KEY_DOWN, P.T.K_KEY_UP, P.T.K_GESTURE]);

class Kvm extends EventEmitter {
  constructor({ server, helper, getSettings, clipboard, input, drop, fileSend }) {
    super();
    Object.assign(this, { server, helper, getSettings, clipboard, input, drop, fileSend });
    this.dragOut = null; // id of our file drag while it is on the PC and not yet dropped
    this.dragOutPaths = null; // …and its files, for when it comes back home still held (kvm.home drag.back)
    this.heldMove = null; // moves while a drag from the PC is starting here (dragin.js arming)
    drop.dragIn.onStarted = () => this._flushHeldMove();
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
    // k.mm summed while driving, sent as one (shared/kvm-moves.js): paced for Bluetooth, and held
    // (still summed) while the socket is backed up, so the pointer never replays old moves.
    this.moves = new KvmMoves({
      send: (m) => this.mode === 'driving' && this._driveMove(m),
      delay: () => (this._movesBle() ? P.KVM_MOVE_BLE_MS : 0),
      backlog: () => (this.lane.quiet ? 0 : this._movesBle() ? blepipe.backlog() : this._movesQueued()),
      limit: () => (this._movesBle() ? P.KVM_BLE_BACKLOG : P.KVM_IP_BACKLOG),
      maxWait: () => (this._movesBle() ? Infinity : P.KVM_MOVE_MAX_WAIT_MS),
    });
    // The input lane (shared/inputlane.js), with an app that has one: moves over UDP, events on both.
    this.lane = new LaneDrive(() => this._lane());
    this.laneIn = new LaneDriven({
      route: () => this.peerRoute,
      move: (dx, dy) => this._onK({ t: P.T.K_MOVE, dx, dy }),
      deliver: (m) => (m.t === P.T.K_GESTURE ? this._onGesture(m) : this._onK(m)),
      native: () => { const l = this._lane(); return l && l.native ? l : null; }, // P3: the helper's lane
      speed: () => this.cfg.speed,
    });
    const il = server.il;
    let laneSettled;
    this.laneReady = new Promise((r) => (laneSettled = r)); // the helper's lane asked for: main.js starts the first session after
    if (il) {
      // The helper's own lane (native/tdfast, P3) when it has one: an older helper answers "unknown cmd".
      const native = () => il.useNative(helper).then(laneSettled, laneSettled);
      helper.on('ready', native);
      if (helper.running) native();
      il.on('start', () => this.laneIn.reset());
      il.on('move', (s) => this.laneIn.move(s));
      il.on('event', (m) => LANE_EVENTS.has(m.t) && this.laneIn.event(m, true));
    } else laneSettled();
    // … and on the driven side, the moves that came in the same turn go to the helper as one.
    this.injectMoves = new KvmMoves({
      send: (m) => this.mode === 'driven' && this.helper.send('inject', { ev: { t: P.T.K_MOVE, dx: m.dx, dy: m.dy } }),
    });
    this.keys = new KeyLayout((cmd, args) => this.helper.request(cmd, args), (cmd, args) => this.helper.send(cmd, args)); // shortcuts and alphabets across layouts
    this.local = null; // phone-bridge.js: drives a phone itself (its input goes through adb, not the link)
    this.locked = false; // cursor lock (shared/cursorlock.js): the pointer stays on the computer it is on
    this.lockAt = 0;
    this.lockKey = new CL.LockKey(() => this.getSettings().keys.lockKeys);
    this.drivenMouse = false; // driven with the mouse too (not keyboard only): the way back is watched
    // The crossing map: both computers' monitors, where they touch (shared/kvm-map.js).
    this.map = new KvmMap({
      electron: require('electron'),
      send: (m) => server.current && server.sendToClient(m),
      side: () => this.cfg.pcSide,
      getAlong: () => (typeof this.cfg.along === 'number' ? this.cfg.along : null),
      setAlong: (v) => {
        this.cfg.along = v;
        store.saveSettings(this.getSettings());
      },
    });
    this.map.on('change', () => {
      this.config();
      this._rearmReturn();
      this.emit('change');
    });

    this.ticker = null; // the 250 ms keepalive and silence check: only away from home (_setMode), as on Windows and Linux
    // The host tells the layout on connect; after that either side sends it when its user changes it.
    // Cursor sharing is remembered per pair: on connect take this pair's value, and the
    // host tells it so both computers agree; after that kvm.link keeps them in step.
    server.on('client', (ctx) => {
      this.lastName = ctx.name;
      this.map.reset();
      this.map.sendDisplays();
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
      this.locked = false;
      this.config();
      if (this.mode === 'driving') this.goHome(this._them('{them} disconnected'));
      else if (this.mode === 'driven') this._drivenHome(this._them('{them} disconnected'));
    });
    // Onto Bluetooth with Over Bluetooth off: everything home; back on Wi-Fi it crosses again.
    server.on('transport', () => this._bleCheck());
    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(P.T.KVM_TAKE, (m) => this._onTake(m));
    on(P.T.KVM_LINK, (m) => this.setLinked(m.on !== false, false));
    // kvm.layout {pcSide, along} = the sender's crossing side and where we are along it; ours is the
    // opposite side and -along (no echo). An older sender has no along: a new side starts centred.
    on(P.T.KVM_LAYOUT, (m) => {
      const side = P.opposite(m.pcSide);
      if (!side) return;
      const k = this.cfg;
      let along = typeof m.along === 'number' && Number.isFinite(m.along) ? -m.along : m.along === null ? null : undefined;
      if (along === undefined) along = side === k.pcSide ? k.along : null;
      if (side === k.pcSide && along === k.along) return;
      k.pcSide = side;
      k.along = along;
      store.saveSettings(this.getSettings());
      this.config();
      this._rearmReturn();
      this.emit('change');
    });
    on(P.T.KVM_DISPLAYS, (m) => this.map.onDisplays(m));
    on(P.T.KVM_IDENTIFY, () => this.map.identify(false));
    // Caps Lock follows the input (shared/capsync.js, #131): after the handlers above.
    this.caps = new CapsSync({ helper: this.helper, platform: 'mac' });
    on(P.T.KVM_TAKE, () => { if (this.mode === 'driven') this.caps.expect(); });
    on(P.T.KVM_HOME, () => { if (this.mode === 'home') this.caps.expect(); });
    on(P.T.KVM_CAPS, (m) => this.caps.onPeer(m));
    on(P.T.KVM_ACCEPT, (m) => {
      if (this.mode === 'driving' && m.route === this.route) clearTimeout(this.acceptTimer);
    });
    on(P.T.KVM_REFUSE, (m) => {
      if (this.mode === 'driving' && m.route === this.route) this.goHome(this._them(REFUSED[m.why] || '{them} refused'), false);
    });
    on(P.T.KVM_HOME, (m) => {
      if (this.mode !== 'driving' || m.route !== this.route) return;
      const k = this.cfg;
      // Our file drag came back with the button still held: it goes on here as Finder's own drag.
      const back = m.drag && m.drag.back && m.drag.back === this.dragOut ? this.dragOutPaths : null;
      if (back) {
        this.fileSend.forgetDrag(this.dragOut);
        this.dragOut = null;
      }
      if (m.drag && m.drag.count) this.drop.dragIn.expectHome(); // the PC's files follow as a drag here
      this.helper.send('capture', typeof m.offset === 'number' ? { on: false, side: k.pcSide, offset: m.offset } : { on: false });
      this._setMode('home', '');
      if (back) {
        console.log(`[drag] back home: ${back.length} item(s)`);
        this.helper.send('dragLocal', { drag: 'back', paths: back });
      }
    });
    on(P.T.KVM_RELEASE, (m) => {
      if (this.mode === 'driven' && m.route >= this.peerRoute) this._drivenHome('');
    });
    for (const t of [P.T.K_MOVE, P.T.K_DOWN, P.T.K_UP, P.T.K_WHEEL, P.T.K_KEY_DOWN, P.T.K_KEY_UP]) on(t, (m) => this._onWire(m));
    on(P.T.K_GESTURE, (m) => this._onWire(m));
    on(P.T.KVM_LOCK, (m) => {
      if (this.mode !== 'home') this.setLocked(m.on === true, false);
    });

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
    return { where: this.mode, message: this.message, tapError: this.tapError, paused: this.paused, locked: this.locked, map: this.map.view };
  }

  // Cursor lock: at home the edge doesn't cross, driven the way back isn't watched, driving the
  // other computer is told (kvm.lock) and stops watching its way back. tell: no echo of a kvm.lock.
  setLocked(on, tell = true) {
    on = !!on;
    if (on === this.locked || (on && !this.server.current)) return;
    this.locked = on;
    if (tell && this.mode === 'driving') this._drive({ t: P.T.KVM_LOCK, on });
    else if (tell && this.mode === 'driven') this.server.sendToClient({ t: P.T.KVM_LOCK, on });
    if (this.mode === 'driven' && this.drivenMouse) {
      this.helper.send('armReturn', on ? { on: false } : this._returnCfg());
    }
    this.config();
    this.emit('lock', on, this.mode); // main.js: the popup
    this.emit('change');
  }

  // The lock key (main.js's global shortcut, or the driver's keyboard): a press and its echo count once.
  toggleLock() {
    const now = Date.now();
    if (now - this.lockAt < CL.TOGGLE_GAP_MS) return;
    this.lockAt = now;
    this.setLocked(!this.locked);
  }

  // This device's own lock key, typed on the keyboard of the computer that drives it (ev in our key
  // codes): used up here, the app in front never gets it.
  _lockKeyHere(ev) {
    const hit = this.lockKey.intercept(ev);
    if (hit === 'press') this.toggleLock();
    return !!hit;
  }

  // Tell the helper where the crossing side is and whether edge crossing is armed.
  // Call after settings.kvm or the link changed.
  config() {
    const k = this.cfg;
    this.helper
      .request('kvmConfig', {
        side: k.pcSide, resistancePx: k.resistancePx, keyboard: !!k.keyboard,
        driveOther: !!(this.linked && k.driveOther && k.mouse && this.server.current && this.server.current.os !== P.OS.IOS && !this.paused && !(this.locked && this.mode === 'home')),
        hotkey: this.getSettings().keys.hotkey || P.HOTKEY_MAC,
        cooldownMs: P.KVM_CROSS_COOLDOWN_MS,
        dwellMs: P.KVM_EDGE_DWELL_MS,
        zones: this.map.zones(), // only where the monitors touch (null: anywhere on the side)
        gestures: k.gestures !== false, // Trackpad gestures go over as k.ge
        takeBack: !k.syncPads, // off with Sync touchpads: our own trackpad never takes the computer back (the 'local' watch)
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
    if (prev && prev.pcSide !== this.cfg.pcSide && prev.along === this.cfg.along) this.cfg.along = null; // a new side starts centred
    if (!prev || prev.pcSide !== this.cfg.pcSide || prev.along !== this.cfg.along) {
      this._sendLayout();
      this._rearmReturn();
    }
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
    this.server.sendToClient({ t: P.T.KVM_LAYOUT, pcSide: this.cfg.pcSide, along: typeof this.cfg.along === 'number' ? this.cfg.along : null });
  }

  // The Cursor tab dragged the other computer: to `side`, `along` it (points, shared/kvm-geom.js).
  moveTo(side, along) {
    if (P.SIDES.includes(side) && side !== this.cfg.pcSide) this.cfg.pcSide = side;
    if (this.map.move(along) === null) return;
    this._sendLayout();
    this.config();
    this._rearmReturn();
    this.emit('change');
  }

  // armReturn while driven: the way back, only where the monitors touch.
  _returnCfg() {
    return { on: true, side: this.cfg.pcSide, resistancePx: this.cfg.resistancePx, zones: this.map.zones() };
  }

  // The layout or the monitors changed while driven: the way back follows.
  _rearmReturn() {
    if (this.mode === 'driven' && this.drivenMouse && !this.locked) this.helper.send('armReturn', this._returnCfg());
  }

  _setMode(mode, message) {
    const prev = this.mode;
    if (process.env.TWINDESK_DEBUG_KVM && prev !== mode) console.log(`[kvm] ${prev} -> ${mode}${message ? ` (${message})` : ''}`);
    this.mode = mode;
    require('../shared/quiet.js').hold('kvm', mode !== 'home'); // input shared either way: the session pings every second (#143)
    if (mode === 'home') { clearInterval(this.ticker); this.ticker = null; }
    else if (!this.ticker) this.ticker = setInterval(() => this._tick(), 250);
    if (prev !== mode && this.locked) { // moved by the hotkey, the menu bar or a disconnect: the lock was for where it was
      this.locked = false;
      if (prev === 'home') this.config();
    }
    if (prev !== mode) this.lockKey.reset();
    if (prev !== mode) { // crossing either way: what our keys type (the layout may have changed)
      this.keys.reset();
      if (mode !== 'home') this.keys.refresh();
    }
    if (prev !== mode) this.emit('where', mode, prev); // hud.js shows it
    if (this.server.il) this.server.il.active(mode !== 'home');
    if (prev === 'driving' && mode !== 'driving') this.lane.idle(); // the helper's lane: no more moves from the tap
    if (prev === 'driven' && mode !== 'driven') this.laneIn.home(); // … and none injected
    this.message = message || '';
    if (mode !== 'driving') {
      clearTimeout(this.acceptTimer);
      this.moves.drop();
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

  _canDrive() {
    return this.mode === 'home' && !!this.server.current && !!this.cfg.driveOther && this.linked && !this.paused;
  }

  _take(fields) {
    const k = this.cfg;
    this.route++;
    this.lane.reset(this.route);
    this._setMode('driving', '');
    this.input.releaseAll();
    const take = { t: P.T.KVM_TAKE, route: this.route, mouse: !!fields.mouse, keyboard: !!k.keyboard, ...fields.where };
    const plan = fields.paths && fields.paths.length ? this.fileSend.planDrag(fields.paths) : null;
    if (plan) take.drag = { count: plan.items.length };
    this._drive(take);
    if (!(this.local && this.local.drives())) this.caps.handOver((m) => this.server.sendToClient(m)); // our Caps Lock, there
    if (plan) {
      this.dragOut = this.fileSend.startDrag(plan); // drag.start right after kvm.take
      this.dragOutPaths = fields.paths;
      console.log(`[drag] out ${this.dragOut}: ${plan.items.length} item(s), ${plan.files} file(s), ${plan.bytes} bytes`);
    } else if (fields.paths && fields.paths.length) console.log('[drag] out: nothing sendable in', fields.paths);
    this.clipboard.sendIfChanged('switch');
    clearTimeout(this.acceptTimer);
    const route = this.route;
    this.acceptTimer = setTimeout(() => {
      if (this.mode === 'driving' && this.route === route) this.goHome(this._them('{them} didn’t answer'));
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
    if (tellPeer && this.server.current) this._drive({ t: P.T.KVM_RELEASE, route: ++this.route });
    this._setMode('home', message);
  }

  // Moves through Bluetooth (not to the phone bridge): paced for the radio.
  _movesBle() {
    return this.onBle && !(this.local && this.local.drives());
  }

  // Bytes waiting on the session's socket.
  _movesQueued() {
    if (this.local && this.local.drives()) return 0;
    const c = this.server.current;
    return c && c.ws ? c.ws.bufferedAmount || 0 : 0;
  }

  // The link now, for the log's line every 30 s (shared/applog.js): null when not connected.
  linkSample() {
    const c = this.server.current;
    const lane = this._lane();
    return c ? { rtt: c.rttMs, lane: lane && lane.up ? lane.rttMs : null, queued: c.ws ? c.ws.bufferedAmount || 0 : 0 } : null;
  }

  _flushMove() {
    this.moves.flush();
  }

  // To the helper: a move summed with the others of this turn; anything else after them. The phone
  // Remote's moves (smooth: the helper eases them out) go as they are.
  _injectEv(ev) {
    if (ev.t === P.T.K_MOVE && !ev.smooth) return this.injectMoves.add(ev.dx, ev.dy);
    this.injectMoves.flush();
    this.helper.send('inject', { ev });
  }

  // The input lane, when this session has one and the peer is a computer (not the phone bridge).
  _lane() {
    if (this.local && this.local.drives()) return null;
    return this.server.lane ? this.server.lane() : null;
  }

  // A summed move while driving: on the input lane when there is one, else as always.
  _driveMove(m) {
    if (!this.lane.move(m.dx, m.dy, (x) => this.server.sendToClient(x))) this._drive({ t: P.T.K_MOVE, dx: m.dx, dy: m.dy });
  }

  // A click, key, wheel or gesture while driving: numbered for the lane when there is one.
  _driveEvent(msg) {
    if (!LANE_EVENTS.has(msg.t) || !this._lane()) return this._drive(msg);
    this.lane.event(msg, (x) => this.server.sendToClient(x));
  }

  // Input from the other computer on WSS: numbered or with totals (an app with the input lane)
  // through the lane's order, the rest as always.
  _onWire(m) {
    const il = this.server.il;
    if (il && il.started) {
      if (m.t === P.T.K_MOVE && Number.isInteger(m.mn)) return this.laneIn.wssMove(m);
      if (Number.isInteger(m.es)) return this.laneIn.event(m);
    }
    if (m.t === P.T.K_GESTURE) this._onGesture(m);
    else this._onK(m);
  }

  // Input while driving goes to the other computer, or to the phone bridge when a phone is the peer.
  _drive(msg) {
    if (this.local && this.local.drives()) this.local.handle(msg);
    else this.server.sendToClient(msg);
  }

  _onHelper(name, ev) {
    const k = this.cfg;
    switch (name) {
      case 'edge':
        // The helper already captures (it started at the edge); undo that if we can't cross.
        if (!this._canDrive() || !k.mouse || this.locked || (!ev.moving && this.blockEdge && this.blockEdge())) {
          this.helper.send('capture', { on: false });
          if (!this.server.current) this._setMode('home', 'Nothing connected');
          return;
        }
        this._take({ mouse: true, where: { side: P.opposite(k.pcSide), offset: this.map.toPeer(ev.offset) }, paths: ev.drag && ev.drag.paths });
        // A window grabbed with the move key crossed with the pointer (main.js onMoveWindow).
        if (ev.moving && this.onMoveWindow) this.onMoveWindow(ev);
        break;
      // Double-tap: switches mouse and keyboard sharing off (everything home)
      // and on again. In keyboard-only mode (Cursor off + "Switch the keyboard with the hotkey") it
      // moves the keyboard over and back instead.
      case 'hotkey':
        if (!this.server.current) break; // nothing connected: the hotkey does nothing (no sharing to switch)
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
        if (!ev.ev) return;
        const e = ev.ev;
        const wss = (x) => this.server.sendToClient(x);
        if (this.mode !== 'driving') return this.lane.skip(e, wss); // numbered by the helper: its number goes all the same
        if (this.local && this.local.drives() && this._lockKeyHere(e)) return; // a phone has no lock key: ours counts there
        if (this.fileClip && this.fileClip.intercept(e)) return this.lane.skip(e, wss); // copy/paste shortcut: done over there
        if (e.t === P.T.K_MOVE) {
          this.lane.nativeTotals(e); // the helper's lane is down: its totals go with the move
          this.moves.add(e.dx, e.dy);
          return;
        }
        this._flushMove();
        if (this.dragOut && e.t === P.T.K_UP && e.b === 0) this.dragOut = null; // dropped on the PC (drag.end follows)
        this._driveEvent(this.keys.tag(e)); // keys with the letter they type here (shared/keylayout.js)
        break;
      }
      // Shaken while driving (the helper's capture spots it, natively): the pointer comes home (kvm.shakeHome).
      case 'shake':
        if (this.mode === 'driving' && this.cfg.shakeHome !== false) this.goHome('');
        break;
      case 'captureEnded':
        if (this.mode === 'driving') this.goHome(ev.reason === 'deadman' ? 'Input came back by itself (safety timeout)' : '');
        break;
      // This computer's own mouse or trackpad moved or clicked while driven (the helper's return
      // watch): it takes the computer back. The driver's pointer comes back where it left, ours stays
      // where the driver left it, and the two pointers work apart again: either one crosses over.
      // Sync touchpads on (kvm.syncPads): every mouse moves the one pointer, nobody takes it back.
      case 'local':
        if (this.mode === 'driven' && !this.locked && !this.cfg.syncPads) this._sendHome(undefined, '');
        break;
      case 'return':
        if (this.mode === 'driven' && !this.locked) {
          this._sendHome(ev.offset, '', ev.drag || {});
          // A window grabbed with the move key crossed with the pointer, home (main.js onMoveWindow).
          if (ev.moving && this.onMoveWindow) this.onMoveWindow(ev);
        }
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
    this.drivenMouse = m.mouse !== false;
    if (m.mouse !== false) {
      if (typeof m.side === 'string') this.helper.send('place', { side: m.side, offset: Number(m.offset) || 0.5 });
      else if (first) this.helper.send('place', { center: true });
      if (!this.locked) this.helper.send('armReturn', this._returnCfg());
    }
    this.drop.dragIn.onDriven(); // after 'place': the native drag starts where the pointer came in
    this.laneIn.take(m.route); // the lane's totals start again (a move that came ahead goes now)
    if (this.drop.dragIn.arming) this.laneIn.hold(true); // the helper's lane holds its moves too
  }

  _onK(m) {
    if (this.mode !== 'driven') return;
    const k = this.cfg;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let ev;
    switch (m.t) {
      case P.T.K_MOVE:
        ev = { t: m.t, dx: num(m.dx) * k.speed, dy: num(m.dy) * k.speed };
        if (this.drop.dragIn.arming) { // the drag starts where the pointer came in; these follow once it has
          this.heldMove = { dx: ev.dx + (this.heldMove ? this.heldMove.dx : 0), dy: ev.dy + (this.heldMove ? this.heldMove.dy : 0) };
          return;
        }
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
        if (this._lockKeyHere(ev)) return;
        ev.code = this.keys.code(m.t === P.T.K_KEY_DOWN, ev.code, m.ch, m.tx, m.im); // a shortcut's letter: our key for it
        if (!ev.code) return; // another alphabet's letter: typed as it is
    }
    this._injectEv(ev);
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

  // Rows 8c: send the input home to the PC (return edge or hotkey). `drag` (the helper's return):
  // the PC's button still held in a file drag, which carries on there — its own drag from it comes
  // back (`back`), or a Finder drag here ended at the edge and its files follow (`paths`).
  _sendHome(offset, message, drag) {
    if (this.mode !== 'driven') return;
    const msg = { t: P.T.KVM_HOME, route: this.peerRoute };
    if (typeof offset === 'number') msg.offset = this.map.toPeer(offset);
    let plan = null;
    if (drag && this.drop.dragIn.dragging) msg.drag = { back: this.drop.dragIn.cur.id }; // not dropped yet: the PC's button still holds it
    else if (drag && Array.isArray(drag.paths) && this.fileSend.dragOn && this.fileSend.peerDrag) {
      plan = this.fileSend.planDrag(drag.paths.filter((p) => typeof p === 'string'));
      if (plan) msg.drag = { count: plan.items.length };
    }
    this.server.sendToClient(msg);
    this.caps.handOver((c) => this.server.sendToClient(c)); // our Caps Lock, home
    if (plan) { // after kvm.home: drag.start, then the files
      const id = this.fileSend.startDrag(plan);
      console.log(`[drag] back ${id}: ${plan.items.length} item(s), ${plan.files} file(s), ${plan.bytes} bytes`);
    }
    this._drivenHome(message);
  }

  // The drag from the PC started here (or never will): the moves held meanwhile go on.
  _flushHeldMove() {
    const h = this.heldMove;
    this.heldMove = null;
    this.laneIn.hold(false);
    if (h && this.mode === 'driven') this._injectEv({ t: P.T.K_MOVE, dx: h.dx, dy: h.dy });
  }

  // Rows 8b / 9b: stop being driven.
  _drivenHome(message) {
    if (this.mode !== 'driven') return;
    this.heldMove = null;
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
