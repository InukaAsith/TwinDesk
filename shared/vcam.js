// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Where a running camera's picture goes (Windows, Mac and Linux). Its window (the other computer's
// camera, or a phone's) is hidden and sends the picture on (shared/vcam-feed.js): to the Camera tab
// ('vcam:preview', a small JPEG, passed to ui()), and while Virtual camera is on to a camera every
// app on this computer can pick ("TwinDesk Camera": NV12, 1280×720, on 'vcam:frame', to the
// driver's feed process; black without frames). The windows say hello and are told what to do
// ('vcam:set' {vcam, rotate}). Virtual camera is off until turned on; turning it on installs the
// camera the first time (each platform's driver: windows/vcam.js, linux/vcam.js, mac/vcam.js).
// Camera › Rotate (settings.camera.rotate, quarter turns) turns the picture everywhere.
//
// driver: {name, always?, check() → {supported, installed, message}, install(say), remove(), feed(onExit) → ChildProcess}
//   targets?: [{value, label}], cameras it can feed (the Mac: TwinDesk Camera or OBS Virtual Camera),
//   chosen in settings.camera.target and passed to check, install, remove and feed as their last
//   argument; nameOf(target), removable(target).
//   say(text): what installing waits for now (the Mac: the person allowing it in System Settings).
//   always: the feed runs all the while it's on (Linux: an apps sees the camera only while
//   something writes to it), not only while frames come.
// cfg() → settings.camera; save(); onChange(); onReady(ready): it's ready (on and installed) or not;
// ui() → the main window (the tab's picture goes there).
'use strict';

const FRAME = 1280 * 720 * 3 / 2;
const IDLE_MS = 5000; // no frames this long: the feed process goes (it starts again with the next one)
const LIVE_MS = 2000;

class VirtualCam {
  constructor({ driver, cfg, save, onChange, onReady, ui = () => null }) {
    Object.assign(this, { driver, cfg, save, onChange, onReady, ui });
    this.state = { checked: false, supported: !!driver, installed: false, busy: '', message: '' };
    this.proc = null;
    this.blocked = false; // the feed's pipe is full: frames drop until it drains
    this.lastFrame = 0;
    this.idle = null;
    this.wasReady = false;
    this.sources = new Set(); // the camera windows' webContents
    this.lastPreview = 0;
    const { ipcMain } = require('electron');
    ipcMain.on('vcam:frame', (_e, buf) => this.frame(buf));
    ipcMain.on('vcam:hello', (e) => {
      const wc = e.sender;
      this.sources.add(wc);
      wc.once('destroyed', () => this.sources.delete(wc));
      this._tell(wc);
    });
    ipcMain.on('vcam:preview', (_e, buf) => {
      const w = this.ui();
      if (!buf || buf.byteLength > 2e6) return;
      const was = this.lastPreview;
      this.lastPreview = Date.now();
      if (this.lastPreview - was > LIVE_MS) this.onChange(); // the tab's picture came
      clearTimeout(this.pictureTimer);
      this.pictureTimer = setTimeout(() => this.onChange(), LIVE_MS + 100); // …or stopped
      if (w && !w.isDestroyed() && w.isVisible()) w.webContents.send('vcam:preview', buf);
    });
  }

  get rotate() {
    const r = this.cfg().rotate;
    return [0, 90, 180, 270].includes(r) ? r : 0;
  }

  get mirror() {
    return this.cfg().mirror === true;
  }

  // Camera › Mirror: left and right swapped, here, in its window and in the virtual camera.
  setMirror(on) {
    this.cfg().mirror = !!on;
    this.save();
    this._tellAll();
    this.onChange();
  }

  // Camera › Rotate: a quarter turn clockwise.
  turn() {
    this.cfg().rotate = (this.rotate + 90) % 360;
    this.save();
    this._tellAll();
    this.onChange();
  }

  _tell(wc) {
    if (!wc.isDestroyed()) wc.send('vcam:set', { vcam: this.ready, rotate: this.rotate, mirror: this.mirror });
  }

  _tellAll() {
    for (const wc of this.sources) this._tell(wc);
  }

  // The camera it feeds (driver.targets), the first unless another is chosen.
  get target() {
    const t = this.driver && this.driver.targets;
    if (!t || !t.length) return undefined;
    return t.some((x) => x.value === this.cfg().target) ? this.cfg().target : t[0].value;
  }

  // Camera › Virtual camera › Send to: another camera (it's checked, and fed from the next frame).
  async setTarget(target) {
    const t = this.driver && this.driver.targets;
    if (!t || !t.some((x) => x.value === target) || target === this.target || this.state.busy) return;
    this.cfg().target = target;
    this.save();
    this._stopFeed();
    this._set({ installed: false, message: '' });
    await this.check();
  }

  get on() {
    return this.cfg().virtual === true;
  }

  // On and installed: Show feeds the camera.
  get ready() {
    return this.on && this.state.installed;
  }

  async check() {
    if (!this.driver) return this._set({ checked: true, supported: false, message: 'Not on this computer' });
    try {
      const r = await this.driver.check(this.target);
      this._set({ checked: true, supported: r.supported !== false, installed: !!r.installed, message: r.message || '' });
    } catch (e) {
      this._set({ checked: true, message: 'Couldn’t check the virtual camera: ' + e.message });
    }
    if (this.on && this.state.supported && !this.state.installed && !this.state.busy) await this.install();
  }

  async setOn(on) {
    this.cfg().virtual = !!on;
    this.save();
    if (on && !this.state.checked) return this.check();
    if (on && this.state.supported && !this.state.installed) return this.install();
    this._set({ message: on ? this.state.message : '' });
  }

  async install() {
    if (this.state.busy || !this.driver) return;
    this._set({ busy: 'install', message: '' });
    try {
      await this.driver.install((text) => this._set({ message: String(text || '') }), this.target);
      const r = await this.driver.check(this.target);
      this.state.installed = !!r.installed;
      this.state.message = r.installed ? '' : (r.message || 'It didn’t install');
    } catch (e) {
      this.state.message = e.message;
    }
    this._set({ busy: '' });
  }

  // Camera › Remove: the camera goes from this computer (the switch goes off).
  async remove() {
    if (this.state.busy || !this.driver) return;
    this.cfg().virtual = false;
    this.save();
    this._set({ busy: 'remove', message: '' });
    this._stopFeed();
    try {
      await this.driver.remove(this.target);
      this.state.installed = false;
    } catch (e) {
      this.state.message = 'Couldn’t remove it: ' + e.message;
    }
    try {
      const r = await this.driver.check(this.target);
      this.state.installed = !!r.installed;
    } catch {}
    this._set({ busy: '' });
  }

  frame(buf) {
    if (!this.ready || !buf || buf.byteLength !== FRAME) return;
    const was = this.lastFrame;
    this.lastFrame = Date.now();
    // The tab's "live" comes and goes with the frames.
    if (this.lastFrame - was > LIVE_MS) this.onChange();
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.onChange(), LIVE_MS + 100);
    this._startFeed();
    clearTimeout(this.idle);
    if (!this.driver.always) this.idle = setTimeout(() => this._stopFeed(), IDLE_MS);
    if (!this.proc || this.blocked) return;
    if (!this.proc.stdin.write(Buffer.from(buf))) {
      this.blocked = true;
      this.proc.stdin.once('drain', () => { this.blocked = false; });
    }
  }

  _startFeed() {
    if (this.proc || !this.ready) return;
    const p = this.proc = this.driver.feed(() => {
      if (this.proc !== p) return;
      this.proc = null;
      this.blocked = false;
      // Linux: it runs all the while it's on (again a moment after it stops).
      if (this.driver.always) setTimeout(() => this._sync(), 2000);
    }, this.target);
  }

  _stopFeed() {
    clearTimeout(this.idle);
    const p = this.proc;
    this.proc = null;
    this.blocked = false;
    if (p) {
      try { p.stdin.end(); } catch {}
      setTimeout(() => { try { p.kill(); } catch {} }, 1000);
    }
  }

  // The camera's windows feed the camera while it's ready; Linux's feed runs all that while.
  _sync() {
    const ready = this.ready;
    if (this.driver && this.driver.always) {
      if (ready) this._startFeed();
      else this._stopFeed();
    } else if (!ready) this._stopFeed();
    if (ready !== this.wasReady) {
      this.wasReady = ready;
      this._tellAll();
      if (this.onReady) this.onReady(ready);
    }
  }

  _set(p) {
    Object.assign(this.state, p);
    this._sync();
    this.onChange();
  }

  // For the Camera tab (state.vcam).
  view() {
    return {
      ...this.state,
      on: this.on,
      ready: this.ready,
      name: !this.driver ? '' : this.driver.nameOf ? this.driver.nameOf(this.target) : this.driver.name,
      targets: (this.driver && this.driver.targets) || null,
      target: this.target || '',
      removable: !this.driver || !this.driver.removable || this.driver.removable(this.target),
      live: this.ready && Date.now() - this.lastFrame < LIVE_MS, // the virtual camera gets frames
      picture: Date.now() - this.lastPreview < LIVE_MS, // the tab gets its picture
      rotate: this.rotate,
      mirror: this.mirror,
    };
  }

  stop() {
    this._stopFeed();
  }
}

module.exports = { VirtualCam, FRAME };
