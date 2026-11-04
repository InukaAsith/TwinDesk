// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared cursor and keyboard: state machine, Windows side, both roles
// (this PC drives the Mac, or the Mac drives this PC).
const P = require('../shared/protocol.js');
const { CapsSync } = require('../shared/capsync.js');
const CL = require('../shared/cursorlock.js');
const blepipe = require('../shared/blepipe.js');
const { KvmMoves } = require('../shared/kvm-moves.js');
const { KeyLayout } = require('../shared/keylayout.js');
const { LaneDrive, LaneDriven } = require('../shared/inputlane.js');

const { KvmMap } = require('../shared/kvm-map.js');

const T = P.T;
const K_TYPES = new Set([T.K_MOVE, T.K_DOWN, T.K_UP, T.K_WHEEL, T.K_KEY_DOWN, T.K_KEY_UP]);
// Input that goes numbered (es) and fenced when there's an input lane (shared/inputlane.js).
const LANE_EVENTS = new Set([T.K_DOWN, T.K_UP, T.K_WHEEL, T.K_KEY_DOWN, T.K_KEY_UP, T.K_GESTURE]);

class Kvm {
  // opts: link, helper, clip, fileDrop, fileRecv, settings (shared object), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.mode = 'home'; // 'home' | 'driving' | 'driven'
    this.route = 0;
    this.peerRoute = 0;
    this.keyCodes = new Map();
    this.pcSide = this.settings.kvm.pcSide; // from kvm.layout: where this PC is, seen from the other computer (saved)
    this.message = '';
    this.acceptTimer = null;
    this.keepalive = null;
    this.silence = null;
    this.dragPending = false; // we crossed with a file drag; cleared when our left button comes up
    this.dragOutPaths = null; // its files, for when it comes back home still held (kvm.home drag.back)
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
      move: (dx, dy) => this._inject({ t: T.K_MOVE, dx, dy }),
      deliver: (m) => (m.t === T.K_GESTURE ? this._onGesture(m) : this._inject(m)),
      native: () => { const l = this._lane(); return l && l.native ? l : null; }, // P3: the helper's lane
      speed: () => this.cfg.speed,
    });
    const il = this.link.il;
    let laneSettled;
    this.laneReady = new Promise((r) => (laneSettled = r)); // the helper's lane asked for: main.js starts the first session after
    if (il) {
      // The helper's own lane (native/tdfast, P3) when it has one: an older helper answers "unknown cmd".
      const native = () => il.useNative(this.helper).then(laneSettled, laneSettled);
      this.helper.on('ready', native);
      if (this.helper.running) native();
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
    this.blockEdge = () => false; // main.js: true while the edge must not cross (a phone window has focus)
    this.locked = false; // cursor lock (shared/cursorlock.js): the pointer stays on the computer it is on
    this.lockAt = 0;
    this.lockKey = new CL.LockKey(() => this.settings.keys.lockKeys);
    // The crossing map: both computers' monitors, where they touch (shared/kvm-map.js). Our `along`
    // is where the other computer is along our crossing side.
    this.map = new KvmMap({
      electron: require('electron'),
      send: (m) => this.connected && this.link.send(m),
      side: () => this.crossingSide,
      getAlong: () => (typeof this.cfg.along === 'number' ? this.cfg.along : null),
      setAlong: (v) => {
        this.cfg.along = v;
        if (this.save) this.save();
      },
    });
    this.map.on('change', () => {
      this.applyConfig();
      this._rearmReturn();
      this.onChange();
    });

    const link = this.link;
    // kvm.layout is "either": pcSide = the sender's crossing side, which is where this
    // PC is seen from the sender. Adopt it, save it, never echo.
    // Its along is where we are along its side: ours is -along. An older sender has none: a new side
    // starts centred.
    link.on(T.KVM_LAYOUT, (m) => {
      if (!P.SIDES.includes(m.pcSide)) return;
      const along = typeof m.along === 'number' && Number.isFinite(m.along) ? -m.along : m.along === null || m.pcSide !== this.pcSide ? null : this.cfg.along;
      this._setPcSide(m.pcSide, along);
    });
    link.on(T.KVM_DISPLAYS, (m) => this.map.onDisplays(m));
    link.on(T.KVM_IDENTIFY, () => this.map.identify(false));
    // Caps Lock follows the input (shared/capsync.js, #131): after the handlers above.
    this.caps = new CapsSync({ helper: this.helper, platform: 'win' });
    link.on(T.KVM_TAKE, () => { if (this.mode === 'driven') this.caps.expect(); });
    link.on(T.KVM_HOME, () => { if (this.mode === 'home') this.caps.expect(); });
    link.on(T.KVM_CAPS, (m) => this.caps.onPeer(m));
    link.on(T.KVM_TAKE, (m) => this._onTake(m));
    link.on(T.KVM_LINK, (m) => this.setLinked(m.on !== false, false)); // the other side switched it: follow, no echo
    link.on(T.KVM_ACCEPT, (m) => {
      if (this.mode === 'driving' && m.route === this.route) this._clearAccept();
    });
    link.on(T.KVM_REFUSE, (m) => {
      if (this.mode !== 'driving' || m.route !== this.route) return;
      this._goHome(m.why === P.REFUSE.BUSY ? '{Name} is driving {me}' : m.why === P.REFUSE.NOT_ALLOWED ? "{Name} doesn't accept input from {me}" : '{Name} refused');
    });
    link.on(T.KVM_RELEASE, (m) => {
      if (this.mode === 'driven' && m.route >= this.peerRoute) this._drivenHome('{Name} took its input back', false);
    });
    link.on(T.KVM_HOME, (m) => {
      if (this.mode !== 'driving' || m.route !== this.route) return;
      const has = typeof m.offset === 'number';
      // Our file drag came back with the button still held: it goes on here (_setMode stops its
      // transfer); or the other computer's files follow as a drag here (drag.start next).
      const d = m.drag && typeof m.drag === 'object' ? m.drag : null;
      const back = d && d.back && this.dragPending && this.fileDrop.drag && d.back === this.fileDrop.drag.drag ? this.dragOutPaths : null;
      if (d && d.count && this.dragRecv) this.dragRecv.expectHome();
      this.helper.send('capture', has ? { on: false, side: this.crossingSide, offset: m.offset } : { on: false });
      this._setMode('home', '');
      if (back) this.helper.send('dragLocal', { drag: 'back', paths: back }); // Windows' own drag of them, at the pointer
    });
    for (const t of K_TYPES) link.on(t, (m) => this._onWire(m));
    link.on(T.K_GESTURE, (m) => this._onWire(m)); // Trackpad gestures
    link.on(T.KVM_LOCK, (m) => {
      if (this.mode !== 'home') this.setLocked(m.on === true, false);
    });
    link.on('welcome', () => {
      this.peerDrags = true;
      this.sentDragPolicy = undefined;
      this.map.reset();
      this.map.sendDisplays();
      this.applyConfig(); // re-sends our drag.policy
      // As the host this PC sends the layout (a Mac host sends its own). Default: the other one on the right.
      if (link.hosting) link.send({ t: T.KVM_LAYOUT, pcSide: this.crossingSide || 'right', along: this._along() });
      if (link.hosting && !this.pcSide) this._setPcSide('left');
      // Cursor sharing is remembered per paired device; take this pair's value, and as
      // the host tell it so both computers agree (kvm.link keeps them in step after that).
      const id = this._peerId();
      const by = this.cfg.linkedBy;
      if (id && id in by && by[id] !== this.linked) this.setLinked(by[id], false, false);
      if (link.hosting) link.send({ t: T.KVM_LINK, on: this.linked });
    });
    this.peerDrags = true; // the Mac's drag.policy (assume yes until told)
    link.on(T.DRAG_POLICY, (m) => { this.peerDrags = m.accept !== false; this.applyConfig(); });
    link.on('closed', () => {
      this._linkLost('{Name} disconnected');
      this.locked = false;
      this.applyConfig();
    });
    // Onto Bluetooth with Over Bluetooth off: everything home; back on Wi-Fi it crosses again.
    link.on('transport', () => this.applyConfig());

    const helper = this.helper;
    helper.on('ready', () => {
      this.applyConfig();
      // A restarted helper has lost its state: nothing is captured or armed any more.
      if (this.mode === 'driving') this._release('');
      else if (this.mode === 'driven') this._drivenHome('TwinDesk’s helper restarted', true);
    });
    helper.on('event', (name, msg) => this._onHelper(name, msg));
  }

  // The user picked where the other computer is (side of this PC): tell the other side.
  setLayout(side) {
    if (!P.SIDES.includes(side)) return;
    this._setPcSide(P.opposite(side), side === this.crossingSide ? this.cfg.along : null);
    this.link.send({ t: T.KVM_LAYOUT, pcSide: side, along: this._along() });
  }

  // The Cursor tab dragged the other computer: to `side` of this computer, `along` it (points,
  // shared/kvm-geom.js). Snapped and saved, and the other side told.
  moveTo(side, along) {
    if (!P.SIDES.includes(side)) return;
    if (side !== this.crossingSide) this._setPcSide(P.opposite(side), null);
    if (this.map.move(along) === null) return;
    this.link.send({ t: T.KVM_LAYOUT, pcSide: side, along: this._along() });
    this.applyConfig();
    this._rearmReturn();
    this.onChange();
  }

  _along() {
    return typeof this.cfg.along === 'number' ? this.cfg.along : null;
  }

  // armReturn while driven: the way back, only where the monitors touch.
  _returnCfg() {
    return { on: true, side: this.crossingSide, resistancePx: this.cfg.resistancePx, zones: this.map.zones() };
  }

  // The layout or the monitors changed while driven: the way back follows.
  _rearmReturn() {
    if (this.mode === 'driven' && !this.keyboardOnly && !this.locked && this.crossingSide) this.helper.send('armReturn', this._returnCfg());
  }

  _setPcSide(pcSide, along) {
    this.pcSide = pcSide;
    this.settings.kvm.pcSide = pcSide;
    if (along !== undefined) this.settings.kvm.along = along;
    if (this.save) this.save();
    this.applyConfig();
    this.onChange();
  }

  // Side of this PC that faces the Mac.
  get crossingSide() {
    return this.pcSide ? P.opposite(this.pcSide) : null;
  }

  get cfg() {
    return this.settings.kvm;
  }

  get connected() {
    return this.link.status.state === 'connected' && this.link.authed; // 'closed' comes before the state changes
  }

  // Tell the helper where the edge is and whether to watch it.
  // Drags across the edge go out when our switch and our "send" are on and the Mac takes them.
  _dragsOut() {
    const f = this.settings.files;
    return !!(f.edgeDrag && f.dropToMac && this.peerDrags);
  }

  applyConfig() {
    const k = this.cfg;
    this.helper.send('kvmConfig', {
      side: this.crossingSide,
      resistancePx: k.resistancePx,
      hotkey: this.settings.keys.hotkey || P.HOTKEY_WIN,
      driveOther: !!(this.linked && k.driveOther && k.mouse && this.connected && this.crossingSide && !this.blockEdge() && !this.paused && !(this.locked && this.mode === 'home')),
      keyboard: !!k.keyboard,
      deadmanMs: P.HELPER_DEADMAN_MS,
      doubleTapMs: P.DOUBLE_TAP_MS,
      cooldownMs: P.KVM_CROSS_COOLDOWN_MS,
      dwellMs: P.KVM_EDGE_DWELL_MS,
      zones: this.map.zones(), // only where the monitors touch (null: anywhere on the side)
      dragFiles: this._dragsOut(), // the edge strip that picks up file drags
      gestures: k.gestures !== false, // Touchpad gestures go over as k.ge while capturing
      takeBack: !k.syncPads, // off with Sync touchpads: our own trackpad never takes the computer back (the 'local' watch)
    });
    // Our switch, for the Mac (it doesn't pick up drags towards us while it's off).
    const accept = !!this.settings.files.edgeDrag;
    if (this.connected && accept !== this.sentDragPolicy) {
      this.sentDragPolicy = accept;
      this.link.send({ t: T.DRAG_POLICY, accept });
    }
    if (this.paused && this.mode !== 'home') {
      this.home();
      this._note('Cursor sharing is off over Bluetooth');
    }
  }

  // Cursor sharing as a whole: off = everything
  // home, no crossing either way, takes refused. tell: also switch the other computer (kvm.link).
  get linked() {
    return this.cfg.linked !== false;
  }

  // card: show the big on/off card (not when a connect restores this pair's value).
  setLinked(on, tell = true, card = true) {
    const id = this.connected && this._peerId();
    if (id) this.cfg.linkedBy = { ...this.cfg.linkedBy, [id]: on }; // Per pair
    if (on === this.linked) {
      if (id && this.save) this.save();
      return;
    }
    if (!on) this.home();
    this.cfg.linked = on;
    if (on) this.cfg.mouse = true; // the one Cursor switch turns the mouse on with it
    if (this.save) this.save();
    if (tell && this.connected) this.link.send({ t: T.KVM_LINK, on });
    this.applyConfig();
    if (card && this.onLinked) this.onLinked(on, tell); // main.js: the big card
    this.onChange();
  }

  // Over Bluetooth (kvm.ble, the same on both: pair.sync 'ble'): off, nothing crosses either way
  // while the session runs through Bluetooth, and it crosses again once it's on Wi-Fi.
  get onBle() {
    const c = this.link.current;
    return !!c && c.transport === 'ble';
  }

  get paused() {
    return this.cfg.ble === false && this.onBle;
  }

  // The one switch (the Cursor tab, the tray, the hotkey's double-tap). Through Bluetooth, with
  // cursor sharing on, it is Over Bluetooth: off there leaves it on for Wi-Fi.
  setShared(on) {
    if (this.onBle && this.linked) return this._setBle(on);
    if (on && this.onBle) this.cfg.ble = true; // saved by setLinked
    this.setLinked(on);
  }

  _setBle(on) {
    if (on === (this.cfg.ble !== false)) return;
    this.cfg.ble = on;
    if (this.save) this.save();
    this.applyConfig(); // off: everything home first
    if (this.onLinked) this.onLinked(on, true, true);
    this.onChange();
  }

  _peerId() {
    const s = this.link.snapshot().session;
    return s && s.id ? String(s.id) : '';
  }

  view() {
    return { linked: this.linked, paused: this.paused, mode: this.mode, locked: this.locked, message: this.message, pcSide: this.pcSide, map: this.map.view, helper: this.helper.running ? '' : this.helper.error || 'starting' };
  }

  // Cursor lock: at home the edge doesn't cross, driven the way back isn't watched, driving the
  // other computer is told (kvm.lock) and stops watching its way back. tell: no echo of a kvm.lock.
  setLocked(on, tell = true) {
    on = !!on;
    if (on === this.locked || (on && !this.connected)) return;
    this.locked = on;
    if (tell && this.mode === 'driving') this._drive({ t: T.KVM_LOCK, on });
    else if (tell && this.mode === 'driven') this.link.send({ t: T.KVM_LOCK, on });
    if (this.mode === 'driven' && !this.keyboardOnly && this.crossingSide) {
      this.helper.send('armReturn', on ? { on: false } : this._returnCfg());
    }
    this.applyConfig();
    if (this.onLock) this.onLock(on, this.mode); // main.js: the popup
    this.onChange();
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

  // ---- owner (this PC drives the Mac) ----

  _canDrive() {
    const k = this.cfg;
    return this.connected && this.linked && !this.paused && k.driveOther && (k.mouse || k.keyboard);
  }

  _onHelper(name, msg) {
    switch (name) {
      case 'edge': // The helper is already capturing
        if (this.mode !== 'home' || !this._canDrive() || !this.cfg.mouse || !this.crossingSide || this.locked) {
          this.helper.send('capture', { on: false });
          return;
        }
        {
          // A file/folder drag crossed: the Mac shows it as its own drag; the data follows.
          const paths = msg.drag && Array.isArray(msg.drag.paths) && this._dragsOut() ? msg.drag.paths.filter((p) => typeof p === 'string') : [];
          const drag = paths.length ? this.fileDrop.prepareDrag(paths) : null;
          this._take({ side: P.opposite(this.crossingSide), offset: this.map.toPeer(msg.offset), ...(drag ? { drag: { count: drag.count } } : {}) });
          // A window grabbed with the move key crossed with the pointer (main.js onMoveWindow).
          if (!drag && msg.moving && this.onMoveWindow) this.onMoveWindow(msg);
          if (drag) { // order: kvm.take, drag.start, then the files
            this.dragOutPaths = paths;
            this.fileDrop.beginDrag(drag);
            this.dragPending = true;
          }
        }
        break;
      // Double-tap: cursor sharing off (everything
      // home) and on again. In keyboard-only mode (Cursor off, "Switch the keyboard with the hotkey"
      // on) it moves the keyboard over and back instead.
      case 'hotkey': {
        const k = this.cfg;
        if (!this.connected) break; // nothing connected: the hotkey does nothing (no sharing to switch)
        if (k.hotkeySwitch && !k.mouse && k.keyboard && this.linked) {
          if (this.mode !== 'home') this.home();
          else if (!this._canDrive()) {
            if (this.connected && !k.driveOther) this._note('Mouse and keyboard to the other computer is off');
          } else {
            this.helper.send('capture', { on: true, mouse: false, keyboard: true });
            this._take({});
          }
          break;
        }
        // Off (by the switch, the hotkey or the other computer) → on, mouse included: the
        // state the Cursor tab's one switch shows. On → off. Through Bluetooth: Over Bluetooth.
        if (this.onBle && this.linked && k.mouse) {
          this.setShared(this.paused);
          break;
        }
        if (this.onBle) k.ble = true; // off → on: Over Bluetooth too (saved below)
        if (this.linked && k.mouse) this.setLinked(false);
        else if (this.linked) { // linked but the mouse was off: turn the mouse on, show the card
          this.settings.kvm = { ...k, mouse: true };
          if (this.save) this.save();
          this.applyConfig();
          if (this.onLinked) this.onLinked(true, true);
          this.onChange();
        } else this.setLinked(true); // also turns the mouse on
        break;
      }
      // This computer's own mouse or trackpad moved or clicked while driven (the helper's return
      // watch): it takes the computer back. The driver's pointer comes back where it left, ours stays
      // where the driver left it, and the two pointers work apart again: either one crosses over.
      // Sync touchpads on (kvm.syncPads): every mouse moves the one pointer, nobody takes it back.
      case 'local':
        if (this.mode === 'driven' && !this.locked && !this.cfg.syncPads) this._sendHome(undefined, '');
        break;
      case 'return':
        if (this.mode === 'driven' && !this.locked) {
          this._sendHome(msg.offset, '', msg.drag || {});
          // A window grabbed with the move key crossed with the pointer, home (main.js onMoveWindow).
          if (msg.moving && this.onMoveWindow) this.onMoveWindow(msg);
        }
        break;
      case 'ev':
        if (this.mode === 'driving' && msg.ev && (K_TYPES.has(msg.ev.t) || (msg.ev.t === T.K_GESTURE && this.cfg.gestures !== false))) {
          if (this.local && this.local.drives() && this._lockKeyHere(msg.ev)) break; // a phone has no lock key: ours counts there
          if (this.fileClip && this.fileClip.intercept(msg.ev)) { this.lane.skip(msg.ev, (x) => this.link.send(x)); break; } // copy/paste shortcut: done over there
          if (msg.ev.t === T.K_MOVE) {
            this.lane.nativeTotals(msg.ev); // the helper's lane is down: its totals go with the move
            this.moves.add(Number(msg.ev.dx) || 0, Number(msg.ev.dy) || 0);
            break;
          }
          this._flushMove(); // a click goes where the moves before it took the pointer
          this._driveEvent(this.keys.tag(msg.ev)); // keys with the letter they type here (shared/keylayout.js)
          if (msg.ev.t === T.K_UP && msg.ev.b === P.BUTTON.LEFT) this.dragPending = false; // released on the Mac
        } else if (msg.ev) this.lane.skip(msg.ev, (x) => this.link.send(x)); // numbered by the helper but not sent: its number goes all the same
        break;
      // Shaken while driving (the helper's capture spots it, natively): the pointer comes home (kvm.shakeHome).
      case 'shake':
        if (this.mode === 'driving' && this.cfg.shakeHome !== false) this._release('');
        break;
      case 'captureEnded': // dead-man or a local stop: input is back here
        if (this.mode === 'driving') this._release(msg.reason === 'secureDesktop' ? 'Back here for the administrator prompt or lock screen' : '');
        break;
      // A UAC prompt or the lock screen here: the other computer's input can't reach it, so it
      // goes home (else its pointer stays hidden there while nothing moves here).
      case 'secureDesktop':
        if (msg.on && this.mode === 'driven') this._sendHome(undefined, 'Use this PC’s own mouse for the administrator prompt or lock screen');
        break;
    }
  }

  _take(where) {
    this.route++;
    this.lane.reset(this.route);
    const k = this.cfg;
    this.keyboardOnly = !where.side; // the hotkey in keyboard-only mode (edge crossings carry a side)
    this._drive({ t: T.KVM_TAKE, route: this.route, ...where, mouse: !!k.mouse && !this.keyboardOnly, keyboard: !!k.keyboard });
    if (!(this.local && this.local.drives())) this.caps.handOver((m) => this.link.send(m)); // our Caps Lock, there
    this._setMode('driving', '');
    this.clip.sendIfChanged('switch');
    this._clearAccept();
    const route = this.route;
    this.acceptTimer = setTimeout(() => {
      if (this.mode === 'driving' && this.route === route) this._goHome('Your Mac didn’t answer');
    }, P.KVM_TAKE_TIMEOUT_MS);
  }

  // Row 5: our input goes home by our own choice.
  _release(message) {
    this.route++;
    this._drive({ t: T.KVM_RELEASE, route: this.route });
    this.helper.send('capture', { on: false });
    this._setMode('home', message);
  }

  // Moves through Bluetooth (not to the phone bridge): paced for the radio.
  _movesBle() {
    return this.onBle && !(this.local && this.local.drives());
  }

  // Bytes waiting on the session's socket.
  _movesQueued() {
    if (this.local && this.local.drives()) return 0;
    return this.link.bufferedAmount || 0;
  }

  // The link now, for the log's line every 30 s (shared/applog.js): null when not connected.
  linkSample() {
    return this.link.linkSample ? this.link.linkSample() : null;
  }

  // The input lane, when this session has one and the peer is a computer (not the phone bridge).
  _lane() {
    if (this.local && this.local.drives()) return null;
    return this.link.lane ? this.link.lane() : null;
  }

  // A summed move while driving: on the input lane when there is one, else as always.
  _driveMove(m) {
    if (!this.lane.move(m.dx, m.dy, (x) => this.link.send(x))) this._drive({ t: T.K_MOVE, dx: m.dx, dy: m.dy });
  }

  // A click, key, wheel or gesture while driving: numbered for the lane when there is one.
  _driveEvent(msg) {
    if (!LANE_EVENTS.has(msg.t) || !this._lane()) return this._drive(msg);
    this.lane.event(msg, (x) => this.link.send(x));
  }

  // Input from the other computer on WSS: numbered or with totals (an app with the input lane)
  // through the lane's order, the rest as always.
  _onWire(m) {
    const il = this.link.il;
    if (il && il.started) {
      if (m.t === T.K_MOVE && Number.isInteger(m.mn)) return this.laneIn.wssMove(m);
      if (Number.isInteger(m.es)) return this.laneIn.event(m);
    }
    if (m.t === T.K_GESTURE) this._onGesture(m);
    else this._inject(m);
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

  _drive(msg) {
    if (this.local && this.local.drives()) this.local.handle(msg);
    else this.link.send(msg);
  }

  // Row 9.
  _goHome(message) {
    this.helper.send('capture', { on: false });
    this._setMode('home', message);
  }

  _clearAccept() {
    clearTimeout(this.acceptTimer);
    this.acceptTimer = null;
  }

  // ---- driven (the Mac drives this PC) ----

  _onTake(m) {
    const route = Number(m.route) || 0;
    if (this.mode === 'driving') {
      this.link.send({ t: T.KVM_REFUSE, route, why: P.REFUSE.BUSY });
      return;
    }
    if (this.mode === 'driven') {
      if (route <= this.peerRoute) return;
      this.injectMoves.drop();
      this.peerRoute = route;
      this.link.send({ t: T.KVM_ACCEPT, route });
      if (m.side && m.mouse !== false) this.helper.send('place', { side: m.side, offset: m.offset });
      this.laneIn.take(route); // the lane's totals start again (a move that came ahead goes now)
      return;
    }
    if (!this.cfg.beDriven || !this.linked || this.paused) { // cursor sharing off
      this.link.send({ t: T.KVM_REFUSE, route, why: P.REFUSE.NOT_ALLOWED });
      this._note(this.paused ? '{Name} tried to use {me} over Bluetooth. It’s turned off here.' : '{Name} tried to use {me}. It’s turned off here.');
      return;
    }
    this.peerRoute = route;
    this.link.send({ t: T.KVM_ACCEPT, route });
    this.keyboardOnly = m.mouse === false;
    this._setMode('driven', '');
    if (m.mouse !== false) {
      this.helper.send('place', P.SIDES.includes(m.side) ? { side: m.side, offset: Number(m.offset) || 0 } : { center: true });
      if (this.crossingSide) this.helper.send('armReturn', this._returnCfg());
    }
    this.laneIn.take(route);
  }

  // Row 8.
  _inject(m) {
    if (this.mode !== 'driven') return;
    const k = this.cfg;
    const ev = { ...m };
    if (ev.t === T.K_KEY_DOWN || ev.t === T.K_KEY_UP) {
      if (typeof ev.code !== 'string') return;
      const original = ev.code;
      ev.code = this.keyCodes.get(original) || (this.settings.keys.swapCtrlCmd && P.keySwapNeeded(P.OS.WIN, this.link.peerOs) ? P.mapKeyFromOtherPlatform(original) : original);
      if (ev.t === T.K_KEY_DOWN) this.keyCodes.set(original, ev.code);
      else this.keyCodes.delete(original);
      if (this._lockKeyHere(ev)) return;
      ev.code = this.keys.code(ev.t === T.K_KEY_DOWN, ev.code, ev.ch, ev.tx, ev.im); // a shortcut's letter: our key for it
      if (!ev.code) return; // another alphabet's letter: typed as it is
      delete ev.ch;
      delete ev.tx;
      delete ev.im;
    } else if (ev.t === T.K_MOVE) {
      ev.dx = (Number(ev.dx) || 0) * k.speed;
      ev.dy = (Number(ev.dy) || 0) * k.speed;
      if (!Number.isFinite(ev.dx) || !Number.isFinite(ev.dy)) return;
    } else if (ev.t === T.K_WHEEL) {
      const direction = k.reverseScroll ? -1 : 1;
      ev.dx = (Number(ev.dx) || 0) * direction;
      ev.dy = (Number(ev.dy) || 0) * direction;
      if (!Number.isFinite(ev.dx) || !Number.isFinite(ev.dy)) return;
    }
    if (ev.t === T.K_KEY_DOWN && ev.code === 'Escape' && this.dragRecv && this.dragRecv.dragging) this.dragRecv.cancel('cancelled', false);
    this._injectEv(ev);
    // The Mac released its left button here: its drag drops where the pointer is.
    if (ev.t === T.K_UP && ev.b === P.BUTTON.LEFT) { this.fileRecv.onRelease(); if (this.dragRecv) this.dragRecv.onRelease(); }
  }

  // A trackpad gesture from the other computer, done the
  // Windows way. There is no virtual precision touchpad we could feed, so each one is
  // its Windows shortcut; the Mac's system swipes (`dock`) act once, at their end, on what they meant.
  _onGesture(m) {
    if (this.mode !== 'driven' || this.cfg.gestures === false || !m || typeof m.g !== 'string') return;
    if (m.g === 'dock') {
      if (m.phase === 'end' && typeof m.mean === 'string' && m.mean !== 'dock') this._onGesture({ g: m.mean });
      return;
    }
    const inj = (ev) => this.helper.send('inject', { ev });
    const combo = (...codes) => { // Windows codes as they are: no Ctrl/Cmd swap for these
      for (const code of codes) inj({ t: T.K_KEY_DOWN, code });
      for (const code of codes.slice().reverse()) inj({ t: T.K_KEY_UP, code });
    };
    const click = (b) => { inj({ t: T.K_DOWN, b }); inj({ t: T.K_UP, b }); };
    switch (m.g) {
      case 'zoom': { // pinch: Ctrl + one wheel notch for every 0.15 of magnification
        if (m.phase === 'begin') this.zoomAcc = 0;
        this.zoomAcc = (this.zoomAcc || 0) + (Number.isFinite(m.v) ? Math.max(-10, Math.min(10, m.v)) : 0);
        const steps = Math.trunc(this.zoomAcc / 0.15);
        this.zoomAcc -= steps * 0.15;
        const notches = -steps; // wheel up = zoom in
        if (!notches) break;
        inj({ t: T.K_KEY_DOWN, code: 'ControlLeft' });
        inj({ t: T.K_WHEEL, dx: 0, dy: notches, mode: 'line' });
        inj({ t: T.K_KEY_UP, code: 'ControlLeft' });
        break;
      }
      case 'smartZoom': combo('ControlLeft', 'Digit0'); break;
      case 'back': click(P.BUTTON.BACK); break;
      case 'forward': click(P.BUTTON.FORWARD); break;
      case 'overview': combo('MetaLeft', 'Tab'); break; // Task View
      case 'appWindows': case 'desktop': combo('MetaLeft', 'KeyD'); break; // 4 fingers down on Windows: show desktop
      case 'spaceLeft': combo('ControlLeft', 'MetaLeft', 'ArrowLeft'); break;
      case 'spaceRight': combo('ControlLeft', 'MetaLeft', 'ArrowRight'); break;
      case 'launcher': combo('MetaLeft'); break; // Start
      default: break; // rotate: no Windows-wide meaning
    }
  }

  // Row 8c: we send the input home (return edge or hotkey).
  // `drag` (from the return edge): the Mac's button may still be held in a file drag, which carries
  // on there — its own drag comes back (`back`), or an Explorer drag here ended at the edge
  // (DropEdge.cs) and its files follow (`paths`).
  _sendHome(offset, message = '', drag) {
    const msg = typeof offset === 'number' ? { t: T.KVM_HOME, route: this.peerRoute, offset: this.map.toPeer(offset) } : { t: T.KVM_HOME, route: this.peerRoute };
    const out = this._dragHome(msg, drag);
    this.link.send(msg);
    this.caps.handOver((c) => this.link.send(c)); // our Caps Lock, home
    if (out) this.fileDrop.beginDrag(out); // after kvm.home: drag.start, then the files
    this._drivenHome(message, true);
  }

  // kvm.home's `drag` for a return with the button held; the drag to begin after it, if any.
  _dragHome(msg, drag) {
    if (!drag || typeof drag !== 'object') return null;
    if (this.dragRecv && this.dragRecv.dragging) { // not dropped yet: the button that drags it is still held
      msg.drag = { back: this.dragRecv.cur.drag };
      return null;
    }
    const paths = Array.isArray(drag.paths) && this._dragsOut() ? drag.paths.filter((p) => typeof p === 'string') : [];
    const out = paths.length ? this.fileDrop.prepareDrag(paths) : null;
    if (out) msg.drag = { count: out.count };
    return out;
  }

  // Rows 8b, 8c, 9b.
  _drivenHome(message, sendClip) {
    if (this.dragRecv) this.dragRecv.onHome(); // a drag from the Mac not dropped yet is cancelled
    this.helper.send('releaseAll');
    this.helper.send('armReturn', { on: false });
    this._setMode('home', message);
    if (sendClip) this.clip.sendIfChanged('switch');
  }

  _linkLost(message) {
    if (this.mode === 'driving') this._goHome(message);
    else if (this.mode === 'driven') {
      this.helper.send('releaseAll');
      this.helper.send('armReturn', { on: false });
      this._setMode('home', message);
    }
  }

  // Tray "Bring Mouse and Keyboard Back".
  home() {
    if (this.mode === 'driving') this._release('');
    else if (this.mode === 'driven') this._sendHome(undefined);
  }

  // ---- shared ----

  _setMode(mode, message) {
    const was = this.mode;
    this.mode = mode;
    if (this.link.il) this.link.il.active(mode !== 'home');
    if (was === 'driving' && mode !== 'driving') this.lane.idle(); // the helper's lane: no more moves from the tap
    if (was === 'driven' && mode !== 'driven') this.laneIn.home(); // … and none injected
    if (this.helper.lowLatency) this.helper.lowLatency('kvm', mode !== 'home');
    if (was !== mode && this.locked) { // moved by the hotkey, the tray or a disconnect: the lock was for where it was
      this.locked = false;
      if (was === 'home') this.applyConfig();
    }
    if (was !== mode) this.lockKey.reset();
    if (was !== mode) { // crossing either way: what our keys type (the layout may have changed)
      this.keyCodes.clear();
      this.zoomAcc = 0;
      this.keys.reset();
      if (mode !== 'home') this.keys.refresh();
    }
    if (was !== mode && this.onWhere) this.onWhere(mode, was); // the switching popup (main.js)
    if (mode === 'home' && this.dragPending) { // went home before releasing: the files don't go
      this.dragPending = false;
      this.fileDrop.cancelRelease();
    }
    this.message = message || '';
    if (mode !== 'driving' && this.fileClip) this.fileClip.resetKeys();
    if (mode !== 'driving') this.moves.drop();
    if (mode !== 'driven') this.injectMoves.drop();
    if (mode === 'driving' && was !== 'driving') {
      clearInterval(this.keepalive);
      this.keepalive = setInterval(() => this.helper.send('keepalive'), P.HELPER_KEEPALIVE_MS);
    } else if (mode !== 'driving') {
      clearInterval(this.keepalive);
      this.keepalive = null;
      this._clearAccept();
    }
    // Silence watch while input is shared.
    clearInterval(this.silence);
    this.silence = null;
    if (mode !== 'home') {
      this.silence = setInterval(() => {
        const c = this.link.current;
        const limit = c && c.transport === 'ble' ? P.KVM_SILENCE_BLE_MS : P.KVM_SILENCE_MS;
        if (Date.now() - (this.link.lastRx || 0) > limit) this._linkLost('{Name} stopped answering');
      }, 250);
    }
    this.onChange();
  }

  _note(message) {
    this.message = message;
    this.onChange();
  }

  shutdown() {
    if (this.mode === 'driving') this._release('');
    else if (this.mode === 'driven') this._drivenHome('', false);
    this.helper.stop();
  }
}


module.exports = Kvm;
