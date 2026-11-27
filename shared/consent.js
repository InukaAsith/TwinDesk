// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Per-pair consent, step 5 of docs/mesh-graph.md: one answer to "does this device take <feature> from
// us, do we take it from it" for every device of the mesh, not just the selected one.
//
// The two-way switches (pairsync.js FEATURES) are one setting per pair, kept by shared/pairsync-mesh.js: the
// settings hold the SELECTED device's pair (the pages show it), every other device's is settings.pairSync[id]
// (told from this side: out = our things there, in = theirs here). Features that serve every device at
// once (the clipboard and notification pools, files from each device) read the flat switch for all of
// them, so every device got the selected pair's switches: clipboard off for one device was off for
// whichever device was selected. Here each asks for the device it serves.
//
//   consent({ features, settings(), selectedId(), send(id, msg), save() })
//     get(id, feature, dir)  the pair's switch: the settings for the selected device (or no device),
//                            else its saved pair, else the settings (a device never paired before)
//     any(ids, feature, dir) on for one of them
//     set(id, feature, dir, on)  a device that isn't selected: its pair saved and told to it
//                            (pair.sync, as PairSync tells the selected one); false for the selected
//                            device (its switch is the settings: set those)
//     changed(id)            PairSync stashed a pair for a device: 'change' (id)
//   Events: 'change' (id | null): a pair changed; null = the settings (the selected device's pair).
'use strict';

const { EventEmitter } = require('events');
const P = require('./protocol.js');

const T = P.T;

class Consent extends EventEmitter {
  constructor({ features, settings, selectedId, send = () => false, save = () => {} }) {
    super();
    Object.assign(this, { features, settings, selectedId, send, save });
  }

  // The settings' switch (the selected device's pair); undefined where this app has none that way.
  flat(feature, dir) {
    const d = this.features[feature];
    const p = d && d[dir];
    const sec = p && this.settings()[p[0]];
    return sec && typeof sec === 'object' ? !!sec[p[1]] : undefined;
  }

  saved(id, feature) {
    const all = this.settings().pairSync;
    const f = id && all && all[id] && all[id][feature];
    return f && typeof f === 'object' ? f : null;
  }

  get(id, feature, dir) {
    const cur = this.flat(feature, dir);
    if (!id || id === this.selectedId()) return !!cur;
    const f = this.saved(id, feature);
    return f && typeof f[dir] === 'boolean' ? f[dir] : !!cur;
  }

  any(ids, feature, dir) {
    return ids.some((id) => this.get(id, feature, dir));
  }

  set(id, feature, dir, on) {
    if (!id || id === this.selectedId() || !this.features[feature] || !this.features[feature][dir]) return false;
    const s = this.settings();
    if (!s.pairSync || typeof s.pairSync !== 'object') s.pairSync = {};
    const cur = s.pairSync[id] || { values: {} };
    cur[feature] = { ...(cur[feature] || {}), [dir]: !!on };
    s.pairSync[id] = cur;
    this.save();
    this.send(id, { t: T.PAIR_SYNC, feature, dir, on: !!on }); // told from our side; it flips the direction
    this.emit('change', id);
    return true;
  }

  changed(id) {
    this.emit('change', id || null);
  }
}

module.exports = { Consent, consent: (opts) => new Consent(opts) };
