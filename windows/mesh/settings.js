// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Multi-device settings: ../settings.js as it is, plus what only the mesh uses (the cursor edges, the
// shared layout and Join every device automatically). Loaded with Multi-device on only; the one-to-one
// app never sees these keys.
const base = require('../settings.js');
const E = require('../../shared/kvm-edges.js');
const L = require('../../shared/layout.js');

const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function normalize(s) {
  s = s || {};
  const out = base.normalize(s);
  const kvm = s.kvm || {};
  const ms = s.mesh || {};
  out.kvm.edges = E.normalizeEdges(kvm.edges); // each side of this screen -> the paired device behind it (shared/kvm-edges.js)
  out.layout = storedLayout(s.layout); // the mesh's shared layout (mesh/layout-sync.js); null until one was edited
  // The other devices' monitors (the monitor map, #225), checked again by layout-sync.js.
  out.layoutDisplays = s.layoutDisplays && typeof s.layoutDisplays === 'object' && !Array.isArray(s.layoutDisplays) ? s.layoutDisplays : null;
  // Joining everyone (docs/mesh.md): on unless switched off in the Multi-device tab, so every computer
  // the mouse goes through is connected to the others; a paired device can add others without a code.
  out.mesh = { autoJoin: bool(ms.autoJoin, true) };
  return out;
}

// The stored shared layout: a valid layout with at least one edit (rev >= 1), else null.
function storedLayout(v) {
  const l = L.normalize(v);
  return l.rev > 0 ? l : null;
}

// ../settings.js's apply() over this normalize(), which keeps the mesh's keys (kvm.edges, layout, mesh).
function apply(settings, section, partial) {
  if (!partial || typeof partial !== 'object' || !(section in settings)) return false;
  const next = normalize({ ...settings, [section]: { ...settings[section], ...partial } });
  const changed = JSON.stringify(next[section]) !== JSON.stringify(settings[section]);
  settings[section] = next[section];
  return changed;
}

// Settings from before the edges (kvm.pcSide): with exactly one paired device, its edge is set.
// Returns true when settings changed (the caller saves). pcSide stays for the one-to-one app.
function migrateKvm(settings, deviceIds) {
  const k = settings.kvm;
  const next = E.migrateEdges(k, deviceIds);
  if (JSON.stringify(next) === JSON.stringify(E.normalizeEdges(k.edges))) return false;
  settings.kvm = { ...k, edges: next };
  return true;
}

// Where they live: settings.json holds what the one-to-one app has too (the same choices in both),
// multi.json what only the mesh has (docs/multi-device.md, rule 4), so the one-to-one app never sees
// or drops it. store: ../store.js.
const MULTI = 'multi.json';

function load(store) {
  const s = store.read('settings.json', {}) || {};
  const m = store.read(MULTI, {}) || {};
  // Join every device automatically is off only when switched off here: saved with `chosen`. Before 2.2.0
  // it was off by default and every save wrote that false, which isn't anyone's choice.
  const ms = m.mesh || {};
  const mesh = ms.autoJoin === false && ms.chosen !== true ? {} : ms;
  return normalize({ ...s, kvm: { ...(s.kvm || {}), edges: (m.kvm || {}).edges }, layout: m.layout, layoutDisplays: m.layoutDisplays, mesh });
}

function save(store, settings) {
  const { layout, layoutDisplays, mesh, ...rest } = settings;
  const { edges, ...kvm } = settings.kvm;
  store.write('settings.json', { ...rest, kvm });
  const off = mesh && mesh.autoJoin === false;
  store.write(MULTI, { ...store.read(MULTI, {}), kvm: { edges }, layout, layoutDisplays, mesh: off ? { autoJoin: false, chosen: true } : { autoJoin: true } });
}

module.exports = { normalize, apply, migrateKvm, load, save };
