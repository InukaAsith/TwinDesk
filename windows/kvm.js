// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared cursor and keyboard: state machine, Windows side, both roles
// (this PC drives the Mac, or the Mac drives this PC).
const P = require('../shared/protocol.js');
const blepipe = require('../shared/blepipe.js');

const T = P.T;
const K_TYPES = new Set([T.K_MOVE, T.K_DOWN, T.K_UP, T.K_WHEEL, T.K_KEY_DOWN, T.K_KEY_UP]);

class Kvm {
  // opts: link, helper, clip, fileDrop, fileRecv, settings (shared object), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.mode = 'home'; // 'home' | 'driving' | 'driven'
    this.route = 0;
    this.peerRoute = 0;
    this.pcSide = this.settings.kvm.pcSide; // from kvm.layout: where this PC is, seen from the other computer (saved)
    this.message = '';
    this.acceptTimer = null;
    this.keepalive = null;
    this.silence = null;
    this.dragPending = false; // we crossed with a file drag; cleared when our left button comes up
    this.pendingMove = null; // k.mm summed while driving, sent as one
    this.moveTimer = null; // its flush, through Bluetooth
    this.local = null; // phone-bridge.js: drives a phone itself (its input goes through adb, not the link)
    this.blockEdge = () => false; // main.js: true while the edge must not cross (a phone window has focus)
    this.drivingSide = null; // which edge was crossed to begin driving
    this.drivingTarget = null; // 'computer' | 'phone'

    const link = this.link;
    // kvm.layout is "either": pcSide = the sender's crossing side, which is where this
    // PC is seen from the sender. Adopt it, save it, never echo.
    link.on(T.KVM_LAYOUT, (m) => {
      if (!P.SIDES.includes(m.pcSide)) return;
      this._setPcSide(m.pcSide);
    });
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
      const side = this.drivingSide || this.crossingSide;
      this.helper.send('capture', has ? { on: false, side, offset: m.offset } : { on: false });
      this.drivingSide = null;
      this.drivingTarget = null;
      this._setMode('home', '');
    });
    for (const t of K_TYPES) link.on(t, (m) => this._inject(m));
    link.on(T.K_GESTURE, (m) => this._onGesture(m)); // Trackpad gestures
    link.on('welcome', () => {
      this.peerDrags = true;
      this.sentDragPolicy = undefined;
      this.applyConfig(); // re-sends our drag.policy
      // As the host this PC sends the layout (a Mac host sends its own). Default: the other one on the right.
      if (link.hosting) link.send({ t: T.KVM_LAYOUT, pcSide: this.crossingSide || 'right' });
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

  // Edge layout map: { left: 'computer' | 'phone' | null, right: ..., top: ..., bottom: ... }
  get edges() {
    const k = this.settings.kvm;
    if (k.edges && typeof k.edges === 'object') return k.edges;
    const compSide = this.crossingSide || 'right';
    return {
      left: compSide === 'left' ? 'computer' : null,
      right: compSide === 'right' ? 'computer' : null,
      top: compSide === 'top' ? 'computer' : null,
      bottom: compSide === 'bottom' ? 'computer' : null,
    };
  }

  setEdge(side, target) {
    if (!P.SIDES.includes(side)) return;
    const k = this.settings.kvm;
    const cur = { ...this.edges };
    if (target === 'computer') {
      for (const s of P.SIDES) if (cur[s] === 'computer') cur[s] = null;
      cur[side] = 'computer';
      this.pcSide = P.opposite(side);
      k.pcSide = this.pcSide;
      if (this.link && this.connected) this.link.send({ t: T.KVM_LAYOUT, pcSide: side });
    } else if (target === 'phone') {
      for (const s of P.SIDES) if (cur[s] === 'phone') cur[s] = null;
      cur[side] = 'phone';
    } else {
      if (cur[side] === 'computer') {
        this.pcSide = null;
        k.pcSide = null;
      }
      cur[side] = null;
    }
    k.edges = cur;
    if (this.save) this.save();
    this.applyConfig();
    this.onChange();
  }

  // The user picked where the other computer is (side of this PC): tell the other side.
  setLayout(side) {
    if (!P.SIDES.includes(side)) return;
    this.setEdge(side, 'computer');
  }

  _setPcSide(pcSide) {
    this.pcSide = pcSide;
    this.settings.kvm.pcSide = pcSide;
    const compSide = P.opposite(pcSide);
    const cur = { ...this.edges };
    for (const s of P.SIDES) if (cur[s] === 'computer') cur[s] = null;
    cur[compSide] = 'computer';
    this.settings.kvm.edges = cur;
    if (this.save) this.save();
    this.applyConfig();
    this.onChange();
  }

  // Side of this PC that faces the Mac.
  get crossingSide() {
    return this.pcSide ? P.opposite(this.pcSide) : null;
  }

  // Active edges to send to helper: comma-separated, e.g. "left,right"
  get activeSides() {
    const edges = this.edges;
    const active = [];
    const phoneReady = !!(this.local && this.local.drives());
    const compReady = this.connected;
    for (const [side, target] of Object.entries(edges)) {
      if (target === 'computer' && compReady) active.push(side);
      else if (target === 'phone' && phoneReady) active.push(side);
    }
    return active.join(',');
  }

  get cfg() {
    return this.settings.kvm;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // Tell the helper where the edge is and whether to watch it.
  // Drags across the edge go out when our switch and our "send" are on and the Mac takes them.
  _dragsOut() {
    const f = this.settings.files;
    return !!(f.edgeDrag && f.dropToMac && this.peerDrags);
  }

  applyConfig() {
    const k = this.cfg;
    const sides = this.activeSides;
    this.helper.send('kvmConfig', {
      side: sides || this.crossingSide,
      resistancePx: k.resistancePx,
      hotkey: this.settings.keys.hotkey || P.HOTKEY_WIN,
      driveOther: !!(this.linked && k.driveOther && k.mouse && sides && !this.blockEdge() && !this.paused),
      keyboard: !!k.keyboard,
      deadmanMs: P.HELPER_DEADMAN_MS,
      doubleTapMs: P.DOUBLE_TAP_MS,
      dragFiles: this._dragsOut(), // the edge strip that picks up file drags
      gestures: k.gestures !== false, // Touchpad gestures go over as k.ge while capturing
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
    return {
      linked: this.linked,
      paused: this.paused,
      mode: this.mode,
      message: this.message,
      pcSide: this.pcSide,
      edges: this.edges,
      drivingTarget: this.drivingTarget,
      helper: this.helper.running ? '' : this.helper.error || 'starting',
    };
  }

  // ---- owner (this PC drives the Mac or Phone) ----

  _canDrive(target = null) {
    const k = this.cfg;
    if (!this.linked || this.paused || !k.driveOther || (!k.mouse && !k.keyboard)) return false;
    if (target === 'computer') return this.connected;
    if (target === 'phone') return !!(this.local && this.local.drives());
    return this.connected || !!(this.local && this.local.drives());
  }

  _onHelper(name, msg) {
    switch (name) {
      case 'edge': // The helper is already capturing
        {
          const crossedSide = msg.side || this.crossingSide;
          const target = (this.edges && this.edges[crossedSide]) || (crossedSide === this.crossingSide ? 'computer' : null);
          if (this.mode !== 'home' || !target || !this._canDrive(target) || !this.cfg.mouse) {
            this.helper.send('capture', { on: false });
            return;
          }
          this.drivingSide = crossedSide;
          this.drivingTarget = target;
          if (target === 'computer') {
            // A file/folder drag crossed: the Mac shows it as its own drag; the data follows.
            const paths = msg.drag && Array.isArray(msg.drag.paths) && this._dragsOut() ? msg.drag.paths.filter((p) => typeof p === 'string') : [];
            const drag = paths.length ? this.fileDrop.prepareDrag(paths) : null;
            this._take({ side: P.opposite(crossedSide), offset: msg.offset, target: 'computer', ...(drag ? { drag: { count: drag.count } } : {}) });
            if (drag) { // order: kvm.take, drag.start, then the files
              this.fileDrop.beginDrag(drag);
              this.dragPending = true;
            }
          } else if (target === 'phone') {
            this._take({ side: P.opposite(crossedSide), offset: msg.offset, target: 'phone' });
          }
        }
        break;
      // Double-tap: cursor sharing off (everything
      // home) and on again. In keyboard-only mode (Cursor off, "Switch the keyboard with the hotkey"
      // on) it moves the keyboard over and back instead.
      case 'hotkey': {
        const k = this.cfg;
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
      case 'return':
        if (this.mode === 'driven') this._sendHome(msg.offset);
        break;
      case 'ev':
        if (this.mode === 'driving' && msg.ev && (K_TYPES.has(msg.ev.t) || (msg.ev.t === T.K_GESTURE && this.cfg.gestures !== false))) {
          if (this.fileClip && this.fileClip.intercept(msg.ev)) break; // copy/paste shortcut: done over there
          if (msg.ev.t === T.K_MOVE) {
            if (!this.pendingMove) {
              this.pendingMove = { dx: 0, dy: 0 };
              this._scheduleMove();
            }
            this.pendingMove.dx += Number(msg.ev.dx) || 0;
            this.pendingMove.dy += Number(msg.ev.dy) || 0;
            break;
          }
          this._flushMove(); // a click goes where the moves before it took the pointer
          this._drive(msg.ev);
          if (msg.ev.t === T.K_UP && msg.ev.b === P.BUTTON.LEFT) this.dragPending = false; // released on the Mac
        }
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
    const k = this.cfg;
    this.keyboardOnly = !where.side; // the hotkey in keyboard-only mode (edge crossings carry a side)
    this.drivingSide = this.drivingSide || (where.side ? P.opposite(where.side) : this.crossingSide);
    this.drivingTarget = where.target || 'computer';
    this._drive({ t: T.KVM_TAKE, route: this.route, ...where, mouse: !!k.mouse && !this.keyboardOnly, keyboard: !!k.keyboard });
    this._setMode('driving', '');
    this.clip.sendIfChanged('switch');
    this._clearAccept();
    const route = this.route;
    this.acceptTimer = setTimeout(() => {
      if (this.mode === 'driving' && this.route === route) {
        this._goHome(this.drivingTarget === 'phone' ? 'Your phone didn’t answer' : 'Your Mac didn’t answer');
      }
    }, P.KVM_TAKE_TIMEOUT_MS);
  }

  // Row 5: our input goes home by our own choice.
  _release(message) {
    this.route++;
    this._drive({ t: T.KVM_RELEASE, route: this.route });
    this.helper.send('capture', { on: false });
    this.drivingSide = null;
    this.drivingTarget = null;
    this._setMode('home', message);
  }

  // Input while driving goes to the other computer, or to the phone bridge when a phone is the peer.
  // Moves summed: one message per turn of the event loop. Through Bluetooth every message is a
  // round trip on the radio, so they go at most every KVM_MOVE_BLE_MS and wait (still summed)
  // while earlier bytes haven't gone out: otherwise they queue up and the cursor lags minutes.
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
    if (m && this.mode === 'driving') this._drive({ t: T.K_MOVE, dx: m.dx, dy: m.dy });
  }

  _drive(msg) {
    if (this.drivingTarget === 'phone' && this.local) this.local.handle(msg);
    else this.link.send(msg);
  }

  // Row 9.
  _goHome(message) {
    if (this.drivingTarget === 'phone' && this.local) {
      this.local.handle({ t: T.KVM_RELEASE, route: this.route });
    }
    this.helper.send('capture', { on: false });
    this.drivingSide = null;
    this.drivingTarget = null;
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
      this.peerRoute = route;
      this.link.send({ t: T.KVM_ACCEPT, route });
      if (m.side && m.mouse !== false) this.helper.send('place', { side: m.side, offset: m.offset });
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
      if (this.crossingSide) this.helper.send('armReturn', { on: true, side: this.crossingSide, resistancePx: this.cfg.resistancePx });
    }
  }

  // Row 8.
  _inject(m) {
    if (this.mode !== 'driven') return;
    const k = this.cfg;
    const ev = { ...m };
    if (ev.t === T.K_KEY_DOWN || ev.t === T.K_KEY_UP) {
      if (typeof ev.code !== 'string') return;
      if (this.settings.keys.swapCtrlCmd && P.keySwapNeeded(P.OS.WIN, this.link.peerOs)) ev.code = P.mapKeyFromOtherPlatform(ev.code);
    } else if (ev.t === T.K_MOVE) {
      ev.dx = (Number(ev.dx) || 0) * k.speed;
      ev.dy = (Number(ev.dy) || 0) * k.speed;
    } else if (ev.t === T.K_WHEEL && k.reverseScroll) {
      ev.dx = -(Number(ev.dx) || 0);
      ev.dy = -(Number(ev.dy) || 0);
    }
    if (ev.t === T.K_KEY_DOWN && ev.code === 'Escape' && this.dragRecv && this.dragRecv.dragging) this.dragRecv.cancel('cancelled', false);
    this.helper.send('inject', { ev });
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
        this.zoomAcc = (this.zoomAcc || 0) + (Number.isFinite(m.v) ? m.v : 0);
        let notches = 0;
        while (this.zoomAcc >= 0.15) { notches--; this.zoomAcc -= 0.15; } // wheel up = zoom in
        while (this.zoomAcc <= -0.15) { notches++; this.zoomAcc += 0.15; }
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
  _sendHome(offset, message = '') {
    this.link.send(typeof offset === 'number' ? { t: T.KVM_HOME, route: this.peerRoute, offset } : { t: T.KVM_HOME, route: this.peerRoute });
    this._drivenHome(message, true);
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
    if (was !== mode && this.onWhere) this.onWhere(mode, was); // the switching popup (main.js)
    if (mode === 'home' && this.dragPending) { // went home before releasing: the files don't go
      this.dragPending = false;
      this.fileDrop.cancelRelease();
    }
    this.message = message || '';
    if (mode !== 'driving' && this.fileClip) this.fileClip.resetKeys();
    if (mode !== 'driving') this.pendingMove = null;
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
