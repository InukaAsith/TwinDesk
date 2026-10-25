// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Shared cursor and keyboard: state machine, Windows side, both roles
// (this PC drives a device, or a device drives this PC).
//
// The edges come from the shared layout (windows/layout-sync.js, docs/mesh.md "Shared layout"): each
// side of this screen leads to the device the layout puts next to this one. The device whose keyboard
// and mouse are used is the centre of a star: crossing an edge selects the device behind it
// (hub.select) and takes it; coming back goes home.
//
// Messages come and go through the hub's bus, which knows the device each one is from or to, so
// every device is handled on its own. `partner` is the device our input goes to (driving) or comes
// from (driven); `drivenBy` is the same thing when we are driven.
'use strict';

const P = require('../../shared/protocol.js');
const E = require('../../shared/kvm-edges.js');
const blepipe = require('../../shared/blepipe.js');

const T = P.T;
const K_TYPES = new Set([T.K_MOVE, T.K_DOWN, T.K_UP, T.K_WHEEL, T.K_KEY_DOWN, T.K_KEY_UP]);

class Kvm {
  // opts: hub (hub.js: bus, sessions, select, selectedId), layoutSync (layout-sync.js), helper, clip,
  // fileDrop, fileRecv, dragRecv, settings (shared object), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.mode = 'home'; // 'home' | 'driving' | 'driven'
    this.route = 0;
    this.peerRoute = 0;
    this.sub = null; // driven by a computer, passing its input on to a phone through our own bridge: {to, side, route}
    this.subRoute = 0;
    this.partner = null; // the device our input goes to (driving) or comes from (driven); null at home
    this.message = '';
    this.acceptTimer = null;
    this.keepalive = null;
    this.silence = null;
    this.dragPending = false; // we crossed with a file drag; cleared when our left button comes up
    this.local = null; // phone-bridge.js: drives a phone itself (its input goes through adb, not the link)
    this.blockEdge = () => false; // main.js: true while the edge must not cross (a phone window has focus)
    this.dragPolicyBy = new Map(); // device id -> its drag.policy (its switch for drags towards it); default yes
    this.sentDragPolicy = undefined;
    this.pendingMove = null; // k.mm summed while driving, sent as one
    this.moveTimer = null; // its flush, through Bluetooth

    const hub = this.hub;
    const bus = hub.bus;
    bus.on(T.KVM_LAYOUT, (m, from) => this._onOldLayout(m, from)); // a one-to-one app's edge: placed as it says
    bus.on(T.KVM_TAKE, (m, from) => this._onTake(m, from));
    bus.on(T.KVM_LINK, (m, from) => this._onLink(m, from)); // the other side switched it: follow, no echo
    bus.on(T.KVM_NEXT, (m, from) => this._onNext(m, from)); // a device we drive hands the input on (a chain)
    bus.on(T.KVM_ACCEPT, (m, from) => {
      if (this.mode === 'driving' && from === this.partner && m.route === this.route) this._clearAccept();
    });
    bus.on(T.KVM_REFUSE, (m, from) => {
      console.log('[kvm] kvm.refuse from ' + from + ' (' + m.why + ', mode ' + this.mode + ')');
      if (this.sub && from === this.sub.to && m.route === this.sub.route) return this._relayBack(undefined);
      if (this.mode !== 'driving' || from !== this.partner || m.route !== this.route) return;
      this._goHome(m.why === P.REFUSE.BUSY ? '{Name} is driving {me}' : m.why === P.REFUSE.NOT_ALLOWED ? "{Name} doesn't accept input from {me}" : '{Name} refused');
    });
    bus.on(T.KVM_RELEASE, (m, from) => {
      if (this.mode === 'driven' && from === this.partner && m.route >= this.peerRoute) this._drivenHome('{Name} took its input back', false);
    });
    bus.on(T.KVM_HOME, (m, from) => {
      console.log('[kvm] kvm.home from ' + from + ' (offset ' + m.offset + ', mode ' + this.mode + ')');
      if (this.sub && from === this.sub.to && m.route === this.sub.route) return this._relayBack(m.offset); // the phone hands the pointer back
      if (this.mode !== 'driving' || from !== this.partner || m.route !== this.route) return;
      const has = typeof m.offset === 'number';
      const side = this._sideOf(from);
      this.helper.send('capture', has && side ? { on: false, side, offset: m.offset } : { on: false });
      this._setMode('home', '');
    });
    for (const t of K_TYPES) bus.on(t, (m, from) => this._inject(m, from));
    bus.on(T.K_GESTURE, (m, from) => this._onGesture(m, from)); // Trackpad gestures
    bus.on(T.DRAG_POLICY, (m, from) => {
      this.dragPolicyBy.set(from, m.accept !== false);
      this.applyConfig();
    });
    bus.onPeer('welcome', (id) => this._onPeerUp(id));
    bus.onPeer('closed', (id) => this._onPeerDown(id));
    // Onto Bluetooth with Over Bluetooth off: everything home; back on Wi-Fi it crosses again.
    bus.onPeer('transport', () => this.applyConfig());
    hub.on('selected', (id) => this._onSelected(id));

    const helper = this.helper;
    helper.on('ready', () => {
      this.applyConfig();
      // A restarted helper has lost its state: nothing is captured or armed any more.
      if (this.mode === 'driving') this._release('');
      else if (this.mode === 'driven') this._drivenHome('TwinDesk’s helper restarted', true);
    });
    helper.on('event', (name, msg) => this._onHelper(name, msg));
  }

  get cfg() {
    return this.settings.kvm;
  }

  // This PC's edges: the device the shared layout puts on each side ({left, right, top, bottom}).
  get edges() {
    return this.layoutSync.neighbors();
  }

  // Cursor sharing as a whole: off = everything home, no crossing either way, takes refused.
  get linked() {
    return this.cfg.linked !== false;
  }

  // The side of this PC that leads to the selected device (null: none).
  get crossingSide() {
    return E.edgeForPeer(this.edges, this.hub.selectedId);
  }

  // Device id -> connected now.
  _connectedTo(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return !!s && s.connected;
  }

  get connected() {
    return this._connectedTo(this.hub.selectedId);
  }

  // 'ble' when the device's session runs through Bluetooth (blepipe.js), else 'ip'.
  _transportOf(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return s && s.connected ? s.transport : 'ip';
  }

  // Over Bluetooth (kvm.ble, the same on both: pair.sync 'ble'): off, nothing crosses either way
  // while a device's session runs through Bluetooth, and it crosses again once it's on Wi-Fi.
  _pausedFor(id) {
    return this.cfg.ble === false && this._transportOf(id) === 'ble';
  }

  get onBle() {
    return this._transportOf(this.hub.selectedId) === 'ble';
  }

  get paused() {
    return this._pausedFor(this.hub.selectedId);
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

  // Cursor sharing for one device: the selected one uses the switch, the others their own memory.
  _linkedFor(id) {
    if (id && id === this.hub.selectedId) return this.linked;
    return !!id && this.cfg.linkedBy[id] !== false;
  }

  // The side that leads to this device, or null.
  _sideOf(id) {
    return E.edgeForPeer(this.edges, id);
  }

  _peerOs(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    return s ? s.peerOs : P.OS.MAC;
  }

  _lastRx() {
    const s = this.partner ? this.hub.sessions.get(this.partner) : null;
    return s ? s.lastRx : 0;
  }

  _send(id, msg) {
    return this.hub.bus.send(id, msg);
  }

  // A device was forgotten: it leaves the shared layout (a person's edit, synced to the others).
  forgetDevice(id) {
    this.layoutSync.remove(id);
    this.applyConfig();
  }

  // The shared layout changed (here or on another device): the watched sides follow it, and each
  // connected device is told which side it is on, as the older apps expect (kvm.layout).
  layoutChanged() {
    this.applyConfig();
    for (const id of this.hub.bus.connectedIds()) {
      const side = this._sideOf(id);
      if (side) this._send(id, { t: T.KVM_LAYOUT, pcSide: side }); // its edge towards us is the opposite
    }
  }

  // kvm.layout from a one-to-one app (no mesh): pcSide is the edge of its screen that leads to this PC,
  // so it sits beyond the opposite edge of this one. It goes there in the shared layout (an edit, synced
  // to the others), as the one-to-one app would set it; layoutChanged() tells it our side back. A mesh
  // device's kvm.layout changes nothing: the shared layout is the one map between mesh devices.
  _onOldLayout(m, from) {
    const s = this.hub.sessions.get(from);
    if (!s || s.meshCapable || !P.SIDES.includes(m.pcSide)) return;
    const side = P.opposite(m.pcSide);
    if (this._sideOf(from) === side) return;
    const me = this.layoutSync.view().cells[this.layoutSync.selfId];
    if (!me) return;
    const [dx, dy] = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[side];
    this.layoutSync.place(from, me.x + dx, me.y + dy);
  }

  // A device came up (its welcome). A device that dialled us gets our side of it and our cursor state.
  _onPeerUp(id) {
    const s = this.hub.sessions.get(id);
    this.dragPolicyBy.delete(id);
    this.sentDragPolicy = undefined;
    if (s && s.hosting) {
      const side = this._sideOf(id);
      if (side) this._send(id, { t: T.KVM_LAYOUT, pcSide: side });
      this._send(id, { t: T.KVM_LINK, on: this._linkedFor(id) });
    }
    this.applyConfig(); // re-sends our drag.policy
  }

  _onPeerDown(id) {
    if ((this.mode === 'driving' || this.mode === 'driven') && id === this.partner) {
      this._linkLost('{Name} disconnected');
    }
    this.applyConfig();
  }

  // The selection changed: the cursor switch follows the selected device's own memory.
  _onSelected(id) {
    const by = this.cfg.linkedBy;
    if (id && id in by && by[id] !== this.linked) this.setLinked(by[id], false, false);
    this.applyConfig();
  }

  // The other side switched cursor sharing (kvm.link). For the selected device it is the switch
  // itself; for another device it is only remembered.
  _onLink(m, from) {
    const on = m.on !== false;
    if (from === this.hub.selectedId) {
      this.setLinked(on, false);
      return;
    }
    this.cfg.linkedBy = { ...this.cfg.linkedBy, [from]: on };
    if (this.save) this.save();
    this.applyConfig();
    this.onChange();
  }

  // Tell the helper which sides to watch and whether to watch them. A side is watched when the
  // device behind it is connected and cursor sharing for it is on.
  // Drags across the edge go out when our switch and our "send" are on and the device takes them.
  _watchedSides() {
    const k = this.cfg;
    if (!k.driveOther || !k.mouse || this.blockEdge()) return [];
    const edges = this.edges;
    return E.SIDES.filter((side) => {
      const id = edges[side];
      return !!id && this._connectedTo(id) && this._linkedFor(id) && !this._pausedFor(id);
    });
  }

  _dragsOut(id) {
    const f = this.settings.files;
    return !!(f.edgeDrag && f.dropToMac) && this.dragPolicyBy.get(id) !== false;
  }

  // The drag.policy of the selected device (the Cursor tab shows it; the same as before for one device).
  get peerDrags() {
    return this.dragPolicyBy.get(this.hub.selectedId) !== false;
  }

  applyConfig() {
    const k = this.cfg;
    const sides = this._watchedSides();
    const key = sides.map((x) => x + '=' + this.edges[x]).join(',');
    if (key !== this._sidesKey) { // only a change is worth a line
      this._sidesKey = key;
      console.log('[kvm] watching sides: ' + (key || 'none') + ' (edges ' + JSON.stringify(this.edges) + ')');
    }
    if (this.mode !== 'home' && this.partner && this._pausedFor(this.partner)) {
      this.home();
      this._note('Cursor sharing is off over Bluetooth');
    }
    this.helper.send('kvmConfig', {
      side: sides[0] || null, // the first side also drives the file-drag strip (DropEdge)
      sides,
      resistancePx: k.resistancePx,
      hotkey: this.settings.keys.hotkey || P.HOTKEY_WIN,
      driveOther: sides.length > 0,
      keyboard: !!k.keyboard,
      deadmanMs: P.HELPER_DEADMAN_MS,
      doubleTapMs: P.DOUBLE_TAP_MS,
      dragFiles: this._dragsOut(sides.length ? this.edges[sides[0]] : null), // the edge strip that picks up file drags
      gestures: k.gestures !== false, // Touchpad gestures go over as k.ge while capturing
      lockScreen: k.lockScreen !== false, // control on lock screen and UAC prompts
    });
    // Our switch, for every connected device (it doesn't pick up drags towards us while it's off).
    const accept = !!this.settings.files.edgeDrag;
    if (accept !== this.sentDragPolicy) {
      this.sentDragPolicy = accept;
      for (const id of this.hub.bus.connectedIds()) this._send(id, { t: T.DRAG_POLICY, accept });
    }
  }

  // Cursor sharing switched on or off (the switch, the hotkey, or a device): kvm.link tells the other side.
  // tell: also switch the other computer. card: show the big on/off card.
  setLinked(on, tell = true, card = true) {
    const id = this.connected ? this.hub.selectedId : null;
    if (id) this.cfg.linkedBy = { ...this.cfg.linkedBy, [id]: on }; // per pair
    if (on === this.linked) {
      if (id && this.save) this.save();
      return;
    }
    if (!on) this.home();
    this.cfg.linked = on;
    if (on) this.cfg.mouse = true; // the one Cursor switch turns the mouse on with it
    if (this.save) this.save();
    if (tell && id) this._send(id, { t: T.KVM_LINK, on });
    this.applyConfig();
    if (card && this.onLinked) this.onLinked(on, tell); // main.js: the big card
    this.onChange();
  }

  // Cursor sharing for one device, whichever is selected (the Overview's per-device switch). The selected
  // device uses the one Cursor switch, the others their own memory (linkedBy); the device is told.
  setLinkedFor(id, on) {
    if (typeof id !== 'string' || !id) return;
    on = !!on;
    if (id === this.hub.selectedId) return this.setLinked(on, true, false);
    this.cfg.linkedBy = { ...this.cfg.linkedBy, [id]: on };
    if (!on && this.partner === id) this.home();
    if (this.save) this.save();
    this._send(id, { t: T.KVM_LINK, on });
    this.applyConfig();
    this.onChange();
  }

  view() {
    return { linked: this.linked, paused: this.paused, mode: this.mode, message: this.message, edges: { ...this.edges }, helper: this.helper.running ? '' : this.helper.error || 'starting' };
  }

  // ---- owner (this PC drives a device) ----

  // Can the selected device be driven now (the hotkey takes it).
  _canDrive() {
    return this._canDriveTo(this.hub.selectedId);
  }

  _canDriveTo(id) {
    const k = this.cfg;
    return this._connectedTo(id) && this._linkedFor(id) && !this._pausedFor(id) && k.driveOther && (k.mouse || k.keyboard);
  }

  _onHelper(name, msg) {
    switch (name) {
      case 'edge':
        this._onEdge(msg);
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
            this._take({}, this.hub.selectedId);
          }
          break;
        }
        // Off (by the switch, the hotkey or the other computer) → on, mouse included: the
        // state the Cursor tab's one switch shows. On → off.
        if (this.onBle && this.linked && k.mouse) { // through Bluetooth: Over Bluetooth
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
        if (this.mode === 'driven') this._onReturn(msg);
        break;
      case 'edgeNote': // pushing on a watched side's edge that is not the outer edge of the desktop (more monitors beyond it)
        if (msg.outer) console.log('[kvm] push at the outer ' + msg.side + ' edge (' + msg.x + ',' + msg.y + '): watched=' + (msg.watched || 'none') + ' driveOther=' + msg.driveOther + ' button=' + msg.button + ' monitors ' + msg.monitors);
        else console.log('[kvm] push at ' + msg.side + ' edge (' + msg.x + ',' + msg.y + ') is not the outer edge; monitors ' + msg.monitors);
        break;
      case 'ev':
        if (this.mode === 'driving' && msg.ev && (K_TYPES.has(msg.ev.t) || (msg.ev.t === T.K_GESTURE && this.cfg.gestures !== false))) {
          if (this.fileClip && this.fileClip.intercept(msg.ev)) break; // copy/paste shortcut: done over there
          if (msg.ev.t === T.K_MOVE) { // moves are summed (see _scheduleMove)
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
        console.log('[kvm] capture ended by the helper: ' + (msg.reason || 'stopped'));
        if (this.mode === 'driving') this._release(msg.reason === 'secureDesktop' ? 'Back here for the administrator prompt or lock screen' : '');
        break;
      // A UAC prompt or the lock screen here: send home only when lockScreen control is disabled
      case 'secureDesktop':
        if (msg.on && this.mode === 'driven' && this.cfg.lockScreen === false) {
          this._sendHome(undefined, 'Use this PC’s own mouse for the administrator prompt or lock screen');
        }
        break;
    }
  }

  // The helper crossed one of the watched edges (msg.side) at msg.offset.
  _onEdge(msg) {
    console.log('[kvm] edge ' + (msg && msg.side) + ' while ' + this.mode);
    if (this.mode === 'driving') return; // already capturing: a late edge is not ours to act on
    const side = E.SIDES.includes(msg.side) ? msg.side : this.crossingSide; // an older helper: the selected side
    const id = side ? this.edges[side] : null;
    if (this.mode !== 'home' || !id || !this._canDriveTo(id) || !this.cfg.mouse || !this.hub.select(id)) {
      console.log('[kvm] edge ' + side + ' not taken: mode=' + this.mode + ' device=' + (id || 'none') + ' canDrive=' + (id ? this._canDriveTo(id) : false) + ' mouse=' + this.cfg.mouse);
      this.helper.send('capture', { on: false });
      return;
    }
    // A file/folder drag crossed: the other device shows it as its own drag; the data follows.
    const paths = msg.drag && Array.isArray(msg.drag.paths) && this._dragsOut(id) ? msg.drag.paths.filter((p) => typeof p === 'string') : [];
    const drag = paths.length ? this.fileDrop.prepareDrag(paths) : null;
    this._take({ side: P.opposite(side), offset: msg.offset, ...(drag ? { drag: { count: drag.count } } : {}) }, id);
    if (drag) { // order: kvm.take, drag.start, then the files
      this.fileDrop.beginDrag(drag);
      this.dragPending = true;
    }
  }

  // id: the device the input goes to (the selected one for the hotkey).
  _take(where, id) {
    this.route++;
    const k = this.cfg;
    this.keyboardOnly = !where.side; // the hotkey in keyboard-only mode (edge crossings carry a side)
    this.partner = id || null;
    this._drive({ t: T.KVM_TAKE, route: this.route, ...where, mouse: !!k.mouse && !this.keyboardOnly, keyboard: !!k.keyboard });
    this._setMode('driving', '');
    this.clip.sendIfChanged('switch');
    this._clearAccept();
    const route = this.route;
    this.acceptTimer = setTimeout(() => {
      if (this.mode === 'driving' && this.route === route) {
        console.log('[kvm] no kvm.accept from ' + id + ' within ' + P.KVM_TAKE_TIMEOUT_MS + ' ms: back home');
        this._goHome('Your Mac didn’t answer');
      }
    }, P.KVM_TAKE_TIMEOUT_MS);
  }

  // Row 5: our input goes home by our own choice.
  _release(message) {
    this.route++;
    this._drive({ t: T.KVM_RELEASE, route: this.route });
    this.helper.send('capture', { on: false });
    this._setMode('home', message);
  }

  // Moves summed: one message per turn of the event loop. Through Bluetooth every message is a
  // round trip on the radio, so they go at most every KVM_MOVE_BLE_MS and wait (still summed)
  // while earlier bytes haven't gone out: otherwise they queue up and the cursor lags minutes.
  _scheduleMove() {
    if (this._transportOf(this.partner) !== 'ble' || (this.local && this.local.drives(this.partner))) return setImmediate(() => this._flushMove());
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

  // Input while driving goes to the partner device, or to the phone bridge when a phone is the peer.
  _drive(msg) {
    // The phone bridge only when the PARTNER is the phone (a phone being connected is not enough: a
    // take meant for a computer went to the bridge and nobody answered it).
    if (this.local && this.local.drives(this.partner)) this.local.handle(msg, this.partner);
    else if (this.partner) this._send(this.partner, msg);
  }

  // A device we drive (partner) reached an edge that leads to device `to` (kvm.next): the chain. Only the
  // one we drive may say it, only for a neighbour in the layout that is connected to us, and never from
  // a phone (it ends a chain). We release the device and take `to`, as an edge crossing would: the
  // device it reached sees the input come in through the side opposite to the one it left by.
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
    this._send(from, { t: T.KVM_RELEASE, route: this.route }); // the device we drove goes home
    this._take({ side: P.opposite(side), offset: Number(m.offset) || 0 }, to);
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

  // ---- driven (a device drives this PC) ----

  _onTake(m, from) {
    console.log('[kvm] take from ' + from + ' route ' + m.route + ' side ' + m.side + ' (this PC is ' + this.mode + ')');
    const route = Number(m.route) || 0;
    if (this.mode === 'driving') {
      this._send(from, { t: T.KVM_REFUSE, route, why: P.REFUSE.BUSY });
      return;
    }
    if (this.mode === 'driven') {
      if (from !== this.partner) { // another device drives us: only the one that does may
        this._send(from, { t: T.KVM_REFUSE, route, why: P.REFUSE.BUSY });
        return;
      }
      if (route <= this.peerRoute) return;
      this.peerRoute = route;
      this._send(from, { t: T.KVM_ACCEPT, route });
      if (m.side && m.mouse !== false) this.helper.send('place', { side: m.side, offset: m.offset });
      return;
    }
    if (!this.cfg.beDriven || !this._linkedFor(from) || this._pausedFor(from)) { // cursor sharing off
      this._send(from, { t: T.KVM_REFUSE, route, why: P.REFUSE.NOT_ALLOWED });
      this._note(this._pausedFor(from) ? '{Name} tried to use {me} over Bluetooth. It’s turned off here.' : '{Name} tried to use {me}. It’s turned off here.');
      return;
    }
    // A driver with no bridge of its own to a phone asks us to drive that phone for it (m.via): the input it
    // sends us goes on to the phone through our bridge, and the phone hands the pointer back to the driver.
    const via = typeof m.via === 'string' && m.via ? m.via : '';
    if (via && !(this._peerOs(via) === P.OS.ANDROID && this.local && this.local.drives(via) && (!this.local.drivable || this.local.drivable(via)) && this._linkedFor(via))) {
      console.log('[kvm] ' + from + ' asked us to drive ' + via + ' but we cannot');
      this._send(from, { t: T.KVM_REFUSE, route, why: P.REFUSE.NOT_ALLOWED });
      return;
    }
    this.partner = from;
    this.peerRoute = route;
    this._send(from, { t: T.KVM_ACCEPT, route });
    this.keyboardOnly = m.mouse === false;
    this._setMode('driven', '');
    if (via) return this._relayTo(via, P.opposite(m.side || 'left'), Number(m.offset) || 0.5, true);
    if (m.mouse !== false) {
      this.helper.send('place', E.SIDES.includes(m.side) ? { side: m.side, offset: Number(m.offset) || 0 } : { center: true });
      this._armReturn();
    }
  }

  // The sides of this PC that have a device behind them (the layout): the helper watches them while
  // this PC is driven, the way back to the driver and every edge that leads on to another device.
  _returnSides() {
    const edges = this.edges;
    return E.SIDES.filter((side) => !!edges[side]);
  }

  _armReturn() {
    console.log('[kvm] return watch on: ' + this._returnSides().join(',') + ' (partner ' + this.partner + ')');
    const sides = this._returnSides();
    // side: the first one, for a helper from before several sides (it watches that one; a newer one reads sides)
    this.helper.send('armReturn', { on: true, side: sides[0] || null, sides, resistancePx: this.cfg.resistancePx });
  }

  // The helper saw the pointer leave this PC (driven) through `side`. Back to the driver: kvm.home as
  // before. Past another device: kvm.next, so the driver takes that device (see _onNext). Nothing
  // behind that side: ignored. The watch is armed again unless we went home, so a driver that did not
  // take the device leaves the edge live.
  _onReturn(msg) {
    const side = E.SIDES.includes(msg.side) ? msg.side : null; // an older helper says nothing: the way back
    const to = side ? this.layoutSync.across(side) : null;
    console.log('[kvm] return ' + side + ' -> ' + (to || 'nobody') + ' (partner ' + this.partner + ')');
    // The way back: the side of the device that drives us (judged by who is there, not only by the side we expect).
    if (!side || to === this.partner || side === this.layoutSync.sideTo(this.partner)) return this._sendHome(msg.offset);
    if (to && to !== this.partner && this._canRelay(to)) return this._relayTo(to, side, Number(msg.offset) || 0);
    if (to && to !== this.partner) this._send(this.partner, { t: T.KVM_NEXT, route: this.peerRoute, to, side, offset: Number(msg.offset) || 0 });
    this._armReturn();
  }

  // Row 8.
  _inject(m, from) {
    if (this.mode !== 'driven' || from !== this.partner) return;
    const k = this.cfg;
    const ev = { ...m };
    if (this.sub) { // the input goes on to the phone, in Windows key codes (the bridge swaps for the phone)
      if ((ev.t === T.K_KEY_DOWN || ev.t === T.K_KEY_UP) && typeof ev.code === 'string' && this.settings.keys.swapCtrlCmd && P.keySwapNeeded(P.OS.WIN, this._peerOs(from))) ev.code = P.mapKeyFromOtherPlatform(ev.code);
      this.local.handle(ev, this.sub.to);
      return;
    }
    if (ev.t === T.K_KEY_DOWN || ev.t === T.K_KEY_UP) {
      if (typeof ev.code !== 'string') return;
      if (this.settings.keys.swapCtrlCmd && P.keySwapNeeded(P.OS.WIN, this._peerOs(from))) ev.code = P.mapKeyFromOtherPlatform(ev.code);
    } else if (ev.t === T.K_MOVE) {
      ev.dx = (Number(ev.dx) || 0) * k.speed;
      ev.dy = (Number(ev.dy) || 0) * k.speed;
    } else if (ev.t === T.K_WHEEL && k.reverseScroll) {
      ev.dx = -(Number(ev.dx) || 0);
      ev.dy = -(Number(ev.dy) || 0);
    }
    if (ev.t === T.K_KEY_DOWN && ev.code === 'Escape' && this.dragRecv && this.dragRecv.dragging) this.dragRecv.cancel('cancelled', false);
    this.helper.send('inject', { ev });
    // The other device released its left button here: its drag drops where the pointer is.
    if (ev.t === T.K_UP && ev.b === P.BUTTON.LEFT) { this.fileRecv.onRelease(); if (this.dragRecv) this.dragRecv.onRelease(); }
  }

  // ---- relay: a computer drives this PC and its pointer reaches the edge of a phone we can drive ----
  // The driver (a Mac, say) may not have wireless debugging set up for that phone, we do: the input it
  // sends us goes to the phone through our bridge until the phone hands the pointer back.

  _canRelay(to) {
    return !this.sub && this.mode === 'driven' && !this.keyboardOnly && this._peerOs(to) === P.OS.ANDROID && !!this.local
      && this.local.drives(to) && (!this.local.drivable || this.local.drivable(to)) && this._linkedFor(to) && this.cfg.driveOther && !!this.cfg.mouse;
  }

  _relayTo(to, side, offset, viaTake = false) {
    this.subRoute++;
    this.sub = { to, side, route: this.subRoute, viaTake };
    console.log('[kvm] relay to ' + to + ' side ' + side + ' (driven by ' + this.partner + ')');
    this.helper.send('armReturn', { on: false });
    this.local.handle({ t: T.KVM_TAKE, route: this.subRoute, side: P.opposite(side), offset, mouse: true, keyboard: true }, to);
  }

  // The phone handed the pointer back (or refused): we are an ordinary driven PC again, the pointer at the edge it left by.
  _relayBack(offset) {
    const sub = this.sub;
    if (!sub) return;
    this.sub = null;
    console.log('[kvm] relay back from ' + sub.to);
    if (this.mode !== 'driven') return;
    if (sub.viaTake) { // the driver asked for this phone: the pointer goes straight back to it
      const home = typeof offset === 'number' ? { t: T.KVM_HOME, route: this.peerRoute, offset } : { t: T.KVM_HOME, route: this.peerRoute };
      this._send(this.partner, home);
      return this._drivenHome('', true);
    }
    this.helper.send('place', { side: sub.side, offset: typeof offset === 'number' ? offset : 0.5 });
    this._armReturn();
  }

  _endRelay() {
    if (!this.sub) return;
    const to = this.sub.to;
    this.sub = null;
    if (this.local) this.local.handle({ t: T.KVM_RELEASE }, to);
  }

  // A trackpad gesture from the other computer, done the
  // Windows way. There is no virtual precision touchpad we could feed, so each one is
  // its Windows shortcut; the Mac's system swipes (`dock`) act once, at their end, on what they meant.
  _onGesture(m, from) {
    if (this.mode !== 'driven' || from !== this.partner || this.cfg.gestures === false || !m || typeof m.g !== 'string') return;
    if (m.g === 'dock') {
      if (m.phase === 'end' && typeof m.mean === 'string' && m.mean !== 'dock') this._onGesture({ g: m.mean }, from);
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
    const msg = typeof offset === 'number' ? { t: T.KVM_HOME, route: this.peerRoute, offset } : { t: T.KVM_HOME, route: this.peerRoute };
    this._send(this.partner, msg);
    this._drivenHome(message, true);
  }

  // Rows 8b, 8c, 9b.
  _drivenHome(message, sendClip) {
    this._endRelay();
    if (this.dragRecv) this.dragRecv.onHome(); // a drag from the other device not dropped yet is cancelled
    this.helper.send('releaseAll');
    this.helper.send('armReturn', { on: false });
    this._setMode('home', message);
    if (sendClip) this.clip.sendIfChanged('switch');
  }

  _linkLost(message) {
    if (this.mode === 'driving') this._goHome(message);
    else if (this.mode === 'driven') {
      this._endRelay();
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
    if (mode !== 'driving') this.pendingMove = null;
    if (was !== mode) console.log('[kvm] ' + was + ' -> ' + mode + ' (partner ' + (this.partner || '-') + ')' + (message ? ': ' + message : ''));
    if (mode === 'home') this.partner = null;
    if (was !== mode && this.onWhere) this.onWhere(mode, was); // the switching popup (main.js)
    if (mode === 'home' && this.dragPending) { // went home before releasing: the files don't go
      this.dragPending = false;
      this.fileDrop.cancelRelease();
    }
    this.message = message || '';
    if (mode !== 'driving' && this.fileClip) this.fileClip.resetKeys();
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
        const limit = this._transportOf(this.partner) === 'ble' ? P.KVM_SILENCE_BLE_MS : P.KVM_SILENCE_MS;
        if (Date.now() - this._lastRx() > limit) this._linkLost('{Name} stopped answering');
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
