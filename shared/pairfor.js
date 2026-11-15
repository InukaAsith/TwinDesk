// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One two-way switch (pairsync.js FEATURES) for one device of the mesh (#245). The settings hold the
// switches of the SELECTED device's pair: PairSync applies them on the facade's welcome, and the pages
// show them. Every other device keeps its own pair, the one PairSync remembers for it
// (settings.pairSync[id], told from this side: out = this device's things there, in = theirs here).
// Sound that stays on its device and a pointer that crosses to a device that isn't selected read that
// device's pair, so selecting a device (a crossing does) never turns off what runs with another one.
'use strict';

// settings: the app's; selectedId: the hub's; id: the device asked about; feature: 'audio', 'cursor', …;
// dir: 'out' | 'in'; current: the switch in the settings (the selected device's pair).
function pairFor(settings, selectedId, id, feature, dir, current) {
  if (!id || id === selectedId) return current;
  const saved = settings && settings.pairSync && settings.pairSync[id];
  const f = saved && saved[feature];
  return f && typeof f[dir] === 'boolean' ? f[dir] : current;
}

module.exports = { pairFor };
