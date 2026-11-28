// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Another computer's apps here in Multi-device (step 5 of docs/mesh-graph.md): a PeerApps (Windows, Linux)
// or PcApps (the Mac) per device, each on that device's own link. On the facade one followed the selected
// device: every window from the device left closed on each crossing (the facade's 'closed', windows moved
// here with Move windows too), and the device left still believed we take its windows (papp.policy has
// no goodbye), so it kept capturing them for nobody. Here windows from several computers stay open at
// once, each unit talking to its own device.
//
// The set is the single object the rest of the app grew up with:
//   all       methods for every unit (a switch changed, ReZume, shutdown)
//   selected  methods for the selected device's unit (the Apps tab: its list, open one)
//   any       methods that are true for one unit (a window going home: whichever has it)
//   anyGet    getters true for one unit (an app window is focused)
//   view      the selected unit's view, with every unit's windows (merge(selected view, all views))
//
//   appsSet({ selectedId(), viewAs: 'method' | 'getter', merge, all, selected, any, anyGet })
//     ensure(id, make(id) → unit)   once a device; its events ('change', 'popup') come from the set
'use strict';

const { EventEmitter } = require('events');

class AppsSet extends EventEmitter {
  constructor({ selectedId, viewAs = 'method', empty = {}, merge = (v) => v, all = [], selected = [], any = [], anyGet = [] }) {
    super();
    Object.assign(this, { selectedId, merge, empty });
    this.byId = new Map(); // device id -> unit
    for (const name of all) this[name] = (...a) => { for (const u of this.units) u[name](...a); };
    for (const name of selected) this[name] = (...a) => { const u = this.selected; return u ? u[name](...a) : undefined; };
    for (const name of any) this[name] = (...a) => this.units.some((u) => u[name](...a));
    for (const name of anyGet) Object.defineProperty(this, name, { get: () => this.units.some((u) => u[name]) });
    const viewOf = (u) => (viewAs === 'getter' ? u.view : u.view());
    const view = () => {
      const u = this.selected;
      return this.merge(u ? viewOf(u) : typeof this.empty === 'function' ? this.empty() : { ...this.empty }, this.units.map(viewOf));
    };
    if (viewAs === 'getter') Object.defineProperty(this, 'view', { get: view });
    else this.view = view;
  }

  ensure(id, make) {
    if (!id || this.byId.has(id)) return this.byId.get(id) || null;
    const u = make(id);
    for (const ev of ['change', 'popup']) if (typeof u.on === 'function') u.on(ev, (...a) => this.emit(ev, ...a));
    this.byId.set(id, u);
    return u;
  }

  get units() {
    return [...this.byId.values()];
  }

  get selected() {
    return this.byId.get(this.selectedId()) || null;
  }
}

// This computer's apps and windows on the other devices (Windows, Linux: PcApps), one per device, each on its
// own link and sender: Move windows sends windows to several devices at once (one device's windows had to
// come back before another could take any: one PcApps on a sticky link), and each device lists and opens
// this computer's apps by itself. The single API besides AppsSet's: moved (every device's), bringBack() (all
// home), input.release(), unit(id) (the device a window goes to).
function pcAppsSet({ hub, make, empty }) {
  const { eachDevice } = require('./scoped-link.js');
  const set = new AppsSet({
    selectedId: () => hub.selectedId, empty,
    merge: (v, all) => ({ ...v, moved: all.reduce((n, x) => n + (x.moved || 0), 0), streaming: all.reduce((n, x) => n + (x.streaming || 0), 0) }),
    all: ['apply', 'shutdown'],
  });
  Object.defineProperty(set, 'moved', { get: () => ({ size: set.units.reduce((n, u) => n + u.moved.size, 0) }) });
  set.bringBack = () => { for (const u of set.units) u.bringBack(); };
  set.input = { release: () => { for (const u of set.units) u.input.release(); } };
  set.unit = (id) => (id && set.byId.get(id)) || null;
  eachDevice(hub, (id, link) => set.ensure(id, () => make(link, id)));
  return set;
}

module.exports = { AppsSet, appsSet: (opts) => new AppsSet(opts), pcAppsSet };
