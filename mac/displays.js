// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The TwinDesk virtual display (via mac-helper), the display list, and which display is shared.
// settings.sharing.displayId: null = the TwinDesk virtual display (falls back to the main
// display when it is off), otherwise an Electron display id (= CGDirectDisplayID).
//
// Events: 'change' — displays were added/removed/resized or the virtual display changed.
'use strict';

const { screen } = require('electron');
const { EventEmitter } = require('events');

const WAIT_DISPLAY_MS = 5000;

class Displays extends EventEmitter {
  constructor(helper, getSettings) {
    super();
    this.helper = helper;
    this.getSettings = getSettings;
    this.virtualId = null; // CGDirectDisplayID of our virtual display, when it exists
    this.virtualError = null;
    this.applying = null;
    this.changeTimer = null;
    const changed = () => this._changed();
    screen.on('display-added', changed);
    screen.on('display-removed', changed);
    screen.on('display-metrics-changed', changed);
    helper.on('event', (name) => {
      if (name === 'displayTerminated') {
        this.virtualId = null;
        this._changed();
      }
    });
    helper.on('exit', () => {
      this.virtualId = null;
      this._changed();
    });
  }

  _changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('change'), 300);
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
      try {
        // The virtual display exists only while this Mac's screen is shared (no empty extra monitor).
        if (!v.enabled || !this.getSettings().sharing.on) {
          if (this.virtualId !== null) await this.helper.request('destroyDisplay');
          this.virtualId = null;
          return;
        }
        const size = this.override || v;
        const r = await this.helper.request('createDisplay', {
          width: size.width, height: size.height, hiDPI: !!size.hiDPI, hz: v.hz || 60, name: 'TwinDesk',
        });
        this.virtualId = r.displayId;
        console.log(`[displays] virtual display ${r.displayId}: ${size.width}x${size.height} pt, ${r.pixelWidth}x${r.pixelHeight} px`);
        await this._waitForDisplay(r.displayId);
      } catch (e) {
        this.virtualId = null;
        this.virtualError = e.message;
        console.error(`[displays] virtual display: ${e.message}`);
      } finally {
        this._changed();
      }
    };
    this.applying = (this.applying || Promise.resolve()).then(run);
    return this.applying;
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
    return screen.getAllDisplays().map((d) => ({
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

  byId(id) {
    return this.list().find((d) => d.id === Number(id)) || null;
  }

  virtualTarget() {
    return this.list().find((d) => d.virtual) || null;
  }

  // This Mac's displays as the screen-mesh model (shared/screen-mesh.js): physical pixels, positions
  // relative to the main display (negative x and y are normal).
  model() {
    const all = this.list();
    const main = all.find((d) => d.primary) || all[0];
    if (!main) return [];
    return all.map((d) => {
      const k = d.width ? d.pixelWidth / d.width : 1;
      return { id: String(d.id), name: d.label, x: Math.round((d.bounds.x - main.bounds.x) * k), y: Math.round((d.bounds.y - main.bounds.y) * k), w: d.pixelWidth, h: d.pixelHeight, scale: k, primary: d.primary };
    });
  }

  // The display to share right now (an entry of list()), or null.
  target() {
    const all = this.list();
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
