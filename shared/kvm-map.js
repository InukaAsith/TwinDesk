// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The crossing map in main (one-to-one, every platform): reports this computer's monitors
// (kvm.displays, on connect and when they change), keeps the other computer's, and turns the
// arrangement ({side, along}, shared/kvm-geom.js) into what the helper needs: the zones where the
// monitors touch, and offsets mapped to the other side. Without the other computer's monitors (an
// older TwinDesk) zones are null (the whole side, as before) and offsets pass through unchanged.
//
// Identify: a big number on each monitor for a moment (kvm.identify asks the other computer too).
//
// Events: 'change' — the monitors on either side changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('./protocol.js');
const G = require('./kvm-geom.js');
// Loaded when first needed: the one-to-one app loads nothing of Multi-device at start (switch.test.js).
const normalizeDisplays = (list) => require('./screen-mesh.js').normalizeDisplays(list);

class KvmMap extends EventEmitter {
  // electron: { screen, BrowserWindow }. send(msg): to the other computer (false when not connected).
  // side(): the side of this computer the other one is on (null: not set). getAlong / setAlong: the
  // saved `along` (null = centred).
  constructor({ electron, send, side, getAlong, setAlong }) {
    super();
    Object.assign(this, { electron, send, side, getAlong, setAlong });
    this.theirs = [];
    this.mine = this._read();
    this.timer = null;
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.mine = this._read();
        this.sendDisplays();
        this.emit('change');
      }, 300);
    };
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) electron.screen.on(ev, changed);
  }

  _read() {
    const { screen } = this.electron;
    const primary = screen.getPrimaryDisplay().id;
    return normalizeDisplays(screen.getAllDisplays().map((d) => ({
      id: String(d.id), x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height,
      scale: d.scaleFactor, primary: d.id === primary, name: d.label || '',
    })));
  }

  sendDisplays() {
    this.send({ t: P.T.KVM_DISPLAYS, displays: this.mine });
  }

  // kvm.displays from the other computer.
  onDisplays(m) {
    this.theirs = normalizeDisplays(m && m.displays);
    this.emit('change');
  }

  // A new connection: the other computer's monitors come again (an older one never sends them).
  reset() {
    this.theirs = [];
    this.emit('change');
  }

  get arrange() {
    const side = this.side();
    return side ? G.normalize({ side, along: this.getAlong() }, this.mine, this.theirs) : null;
  }

  // For kvmConfig / armReturn: where the edge crosses (null: anywhere on the side).
  zones() {
    const a = this.arrange;
    return a ? G.zonesText(this.mine, this.theirs, a) : null;
  }

  // Our helper's offset to the other computer's.
  toPeer(offset) {
    const a = this.arrange;
    return a && typeof offset === 'number' ? G.mapOffset(this.mine, this.theirs, a, offset) : offset;
  }

  // The Cursor tab dragged the other computer: snapped and saved. Returns the saved value.
  move(along) {
    const side = this.side();
    if (!side || typeof along !== 'number' || !Number.isFinite(along)) return null;
    const v = this.theirs.length ? G.snap(this.mine, this.theirs, side, along) : Math.round(along);
    this.setAlong(v);
    return v;
  }

  // Identify: our numbers here, and ask the other computer to show its own.
  identify(tell = true) {
    if (tell) this.send({ t: P.T.KVM_IDENTIFY });
    const { screen, BrowserWindow } = this.electron;
    const order = G.numbered(this.mine);
    for (const d of screen.getAllDisplays()) {
      const n = order.indexOf(String(d.id)) + 1;
      if (!n) continue;
      const size = 200;
      const w = new BrowserWindow({
        x: Math.round(d.bounds.x + (d.bounds.width - size) / 2), y: Math.round(d.bounds.y + (d.bounds.height - size) / 2),
        width: size, height: size, frame: false, ...(process.platform === 'linux' ? { roundedCorners: false } : {}), transparent: true, resizable: false, movable: false, focusable: false,
        skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000', webPreferences: { javascript: false },
      });
      w.setIgnoreMouseEvents(true);
      w.setAlwaysOnTop(true, 'screen-saver');
      const html = '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;'
        + 'font:600 120px -apple-system,system-ui,Segoe UI,sans-serif;color:#fff;background:rgba(0,0,0,.55);border-radius:36px;'
        + `overflow:hidden">${n}</body>`;
      w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      w.once('ready-to-show', () => w.showInactive());
      setTimeout(() => !w.isDestroyed() && w.close(), 1800);
    }
  }

  // For the Cursor tab.
  get view() {
    const a = this.arrange;
    return { mine: this.mine, theirs: this.theirs, along: a ? a.along : null, contact: a ? G.contact(this.mine, this.theirs, a) : [] };
  }
}

module.exports = { KvmMap };
