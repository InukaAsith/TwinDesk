// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The TwinDesk virtual display (via mac-helper), the display list, and which display is shared.
// settings.sharing.displayId: null = the TwinDesk virtual display (falls back to the main
// display when it is off), otherwise an Electron display id (= CGDirectDisplayID).
//
// Events: 'change' — displays were added/removed/resized or the virtual display changed.
'use strict';

const { screen, systemPreferences, desktopCapturer } = require('electron');
const { EventEmitter } = require('events');

const WAIT_DISPLAY_MS = 5000;

class Displays extends EventEmitter {
  constructor(helper, getSettings) {
    super();
    this.helper = helper;
    this.getSettings = getSettings;
    this.virtualId = null; // CGDirectDisplayID of our virtual display, when it exists
    this.holds = new Set(); // reasons it is needed without screen sharing ('apps': app windows streamed from it)
    this.virtualError = null;
    this.applying = null;
    this.changeTimer = null;
    this.captureUsers = new Set();
    this.dead = new Set();
    this.sourceProbes = 0;
    this.fallbackTries = 0;
    this.headlessApplied = false;
    screen.on('display-added', (_event, d) => { if (d) this.dead.delete(d.id); this._changed(); });
    screen.on('display-removed', () => this._changed());
    screen.on('display-metrics-changed', () => this._changed());
    helper.on('event', (name) => {
      if (name === 'displayTerminated') {
        clearTimeout(this.fallbackStableTimer);
        this.virtualId = null;
        this.virtualKey = '';
        this._changed();
      }
    });
    helper.on('exit', () => {
      clearTimeout(this.fallbackStableTimer);
      this.virtualId = null;
      this.virtualKey = '';
      this._changed();
    });
  }

  _changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => { this._reconcile(); this.emit('change'); }, 300);
  }

  _usable(d) {
    return d.id > 0 && d.size.width > 0 && d.size.height > 0 && !this.dead.has(d.id);
  }

  _headless() {
    return !screen.getAllDisplays().some((d) => d.id !== this.virtualId && this._usable(d));
  }

  fallbackOnly() {
    return this.headlessApplied && !this.getSettings().virtual.enabled && !this.holds.size;
  }

  _fallback() {
    return this.getSettings().sharing.on && this.captureUsers.size > 0 &&
      systemPreferences.getMediaAccessStatus('screen') === 'granted' && this._headless();
  }

  captureWanted(owner, on) {
    const hadUsers = this.captureUsers.size > 0;
    if (on) this.captureUsers.add(owner);
    else this.captureUsers.delete(owner);
    if (!this.captureUsers.size) {
      clearTimeout(this.sourceProbeTimer); this.sourceProbeTimer = null;
      clearTimeout(this.fallbackStableTimer); this.fallbackTries = 0;
      if (hadUsers) {
        const hadDead = this.dead.size > 0;
        this.dead.clear(); this.sourceProbes = 0;
        if (hadDead) this._changed();
      }
    }
    this._reconcile();
  }

  uncapturable(id) {
    this.dead.add(id);
    this._probeSources();
    this._changed();
  }

  // Capture-source enumeration can briefly lag screen events. Recheck it without tearing down
  // the fallback; topology changes remain the recovery signal after this bounded startup window.
  _probeSources() {
    if (this.sourceProbeTimer || this.sourceProbes >= 3 || !this.captureUsers.size ||
        !this.getSettings().sharing.on || systemPreferences.getMediaAccessStatus('screen') !== 'granted') return;
    this.sourceProbeTimer = setTimeout(async () => {
      this.sourceProbeTimer = null;
      this.sourceProbes++;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (!this.captureUsers.size || !this.getSettings().sharing.on || systemPreferences.getMediaAccessStatus('screen') !== 'granted') return;
        let restored = false;
        for (const id of this.dead) if (sources.some((source) => source.display_id === String(id))) {
          this.dead.delete(id);
          restored = true;
        }
        if (restored) this._changed();
      } catch (_) {}
      if (this.dead.size) this._probeSources();
    }, 2000 * (1 << this.sourceProbes));
  }

  _reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    Promise.resolve(this.applying).then(() => {
      this.reconciling = false;
      const ids = new Set(screen.getAllDisplays().map((d) => d.id));
      for (const id of this.dead) if (!ids.has(id)) this.dead.delete(id);
      const headless = this._fallback();
      if (!this._headless()) this.fallbackTries = 0;
      if (!this.dead.size) { this.sourceProbes = 0; clearTimeout(this.sourceProbeTimer); this.sourceProbeTimer = null; }
      const missing = !screen.getAllDisplays().some((d) => d.id === this.virtualId && this._usable(d));
      if ((headless !== this.headlessApplied && (!headless || this.fallbackTries < 3)) ||
          (headless && missing && this.fallbackTries < 3)) this.applyVirtual();
    });
  }

  // A phone viewing Extend: the virtual display takes the phone's shape (its pixels at 2x, HiDPI),
  // in place of settings.virtual's size. null = settings.virtual again.
  setOverride(o) {
    const next = o && o.width > 0 && o.height > 0
      ? { width: Math.max(480, Math.round(o.width / 2)), height: Math.max(360, Math.round(o.height / 2)), hiDPI: true } : null;
    if (JSON.stringify(next) === JSON.stringify(this.override || null)) return;
    this.override = next;
    const v = this.getSettings().virtual;
    if (v.enabled && this.getSettings().sharing.on) this.applyVirtual();
  }

  // Create, re-create or remove the virtual display to match settings.virtual. Serialized.
  applyVirtual() {
    const run = async () => {
      const v = this.getSettings().virtual;
      this.virtualError = null;
      const headless = this._fallback();
      this.headlessApplied = headless;
      try {
        // The virtual display exists only while this Mac's screen is shared in Extend mode (no empty
        // extra monitor), or while something holds it, in Mirror mode too: this Mac's apps open on
        // the other computer ('apps-open'), windows moved there ('apps').
        if (!headless && !this.holds.size && !(v.enabled && this.getSettings().sharing.on)) {
          clearTimeout(this.fallbackStableTimer);
          if (this.virtualId !== null) await this.helper.request('destroyDisplay');
          this.virtualId = null;
          this.virtualKey = '';
          return;
        }
        const size = this.override || v;
        // Already there as asked: keep it (re-creating it pulls it from under a capture that just
        // started on it; several callers apply at once when sharing starts).
        const key = JSON.stringify([size.width, size.height, !!size.hiDPI, v.hz || 60]);
        if (this.virtualId !== null && key === this.virtualKey && screen.getAllDisplays().some((d) => d.id === this.virtualId && this._usable(d))) return;
        if (headless) this.fallbackTries++;
        const r = await this.helper.request('createDisplay', {
          width: size.width, height: size.height, hiDPI: !!size.hiDPI, hz: v.hz || 60, name: 'TwinDesk',
        });
        this.dead.delete(r.displayId);
        this.virtualId = r.displayId;
        this.virtualKey = key;
        console.log(`[displays] virtual display ${r.displayId}: ${size.width}x${size.height} pt, ${r.pixelWidth}x${r.pixelHeight} px`);
        await this._waitForDisplay(r.displayId);
        if (headless && screen.getAllDisplays().some((d) => d.id === r.displayId && this._usable(d))) {
          clearTimeout(this.fallbackStableTimer);
          this.fallbackStableTimer = setTimeout(() => {
            if (this.virtualId === r.displayId && screen.getAllDisplays().some((d) => d.id === r.displayId && this._usable(d))) this.fallbackTries = 0;
          }, 10000);
        }
      } catch (e) {
        this.virtualId = null;
        this.virtualKey = '';
        this.virtualError = e.message;
        console.error(`[displays] virtual display: ${e.message}`);
      } finally {
        this._changed();
      }
    };
    this.applying = (this.applying || Promise.resolve()).then(run);
    return this.applying;
  }

  // Needed (or not any more) without screen sharing. Resolves once it is applied.
  hold(reason, on) {
    if (this.holds.has(reason) === !!on) return this.applying || Promise.resolve();
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    return this.applyVirtual();
  }

  // The virtual display's bounds (points), or null.
  virtualBounds() {
    const d = this.virtualId !== null && screen.getAllDisplays().find((x) => x.id === this.virtualId);
    return d ? d.bounds : null;
  }

  _waitForDisplay(id) {
    if (screen.getAllDisplays().some((d) => d.id === id)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        screen.removeListener('display-added', onAdded);
        resolve();
      };
      const onAdded = (_e, d) => d.id === id && done();
      const timer = setTimeout(() => {
        console.error(`[displays] display ${id} did not appear within ${WAIT_DISPLAY_MS} ms`);
        done();
      }, WAIT_DISPLAY_MS);
      screen.on('display-added', onAdded);
    });
  }

  list() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().filter((d) => this._usable(d)).map((d) => ({
      id: d.id,
      label: d.id === this.virtualId ? 'TwinDesk (virtual)' : d.label || (d.internal ? 'Built-in display' : `Display ${d.id}`),
      width: d.size.width,
      height: d.size.height,
      pixelWidth: Math.round(d.size.width * d.scaleFactor),
      pixelHeight: Math.round(d.size.height * d.scaleFactor),
      bounds: d.bounds,
      virtual: d.id === this.virtualId,
      primary: d.id === primary,
      hz: d.displayFrequency || 60,
    }));
  }

  // The display to share right now (an entry of list()), or null.
  target() {
    const all = this.list();
    // This Mac's apps open on the other computer: they live on the virtual display, so it is the one
    // shared, in Mirror mode too (back to mirroring once they are closed).
    if (this.holds.has('apps-open')) {
      const v = all.find((d) => d.virtual);
      if (v) return v;
    }
    const want = this.getSettings().sharing.displayId;
    return (
      (want != null && all.find((d) => d.id === want)) ||
      all.find((d) => d.virtual) ||
      all.find((d) => d.primary) ||
      all[0] ||
      null
    );
  }
}

module.exports = { Displays };
