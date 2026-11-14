// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The mesh's files in userData (docs/multi-device.md, rule 4). Everything goes through ../store.js,
// except what the one-to-one app keeps, which the mesh starts from but never writes:
//   hosts.json     read and written as hosts-mesh.json, the hosts this Mac dials (links.js); each host
//                  of the one-to-one app (hosts.json) joins the list
//   paired.json    read and written as paired-mesh.json, the devices that dial this Mac (pairing.js);
//                  each device paired in the one-to-one app (paired.json) joins the list
//   settings       settings.json holds what the one-to-one app has too (the same choices in both),
//                  multi.json what only the mesh has (layout, mesh)
// Each joins once (multi.json `imported`): one forgotten here stays forgotten, and one paired again in
// the one-to-one app (a new token) joins again.
'use strict';

const store = require('../store');

const MULTI = 'multi.json';
const MINE = { 'hosts.json': 'hosts-mesh.json', 'paired.json': 'paired-mesh.json' };
const KEY = { 'hosts.json': (e) => e.token, 'paired.json': (e) => e.tokenHash }; // what makes an entry new
const ID = (e) => e.macId || e.id;

function imported(name) {
  const im = store.read(MULTI, {}).imported || {};
  return Array.isArray(im[name]) ? im[name] : [];
}

function remember(name, keys) {
  const m = store.read(MULTI, {});
  const im = { ...(m.imported || {}) };
  im[name] = [...imported(name), ...keys].slice(-50);
  store.write(MULTI, { ...m, imported: im });
}

// The mesh's list, and the one-to-one app's entries that are new to it.
function merged(name, fallback) {
  const mine = store.read(MINE[name], null);
  let list = Array.isArray(mine) ? mine : [];
  const seen = imported(name);
  const took = [];
  for (const e of store.read(name, [])) {
    const k = e && KEY[name](e);
    if (typeof k !== 'string' || !k || seen.includes(k)) continue;
    if (!list.some((x) => x && ID(x) === ID(e))) list = [...list, e];
    took.push(k);
  }
  if (took.length) {
    store.write(MINE[name], list);
    remember(name, took);
  }
  return Array.isArray(mine) || took.length ? list : fallback;
}

function read(name, fallback) {
  return MINE[name] ? merged(name, fallback) : store.read(name, fallback);
}

function write(name, data) {
  store.write(MINE[name] || name, data);
}

function loadSettings() {
  const out = store.loadSettings();
  const m = store.read(MULTI, {});
  out.layout = m.layout; // the shared layout (layout-sync.js); none until one was edited
  out.layoutDisplays = m.layoutDisplays || null; // the other devices' monitors (the monitor map, #225)
  // Join every device automatically: on unless switched off in the Multi-device tab, so every computer the
  // mouse goes through is connected to the others; a paired device can add others without a pairing code.
  out.mesh = { autoJoin: !switchedOff(m.mesh) };
  return out;
}

// Off only when switched off here: saved with `chosen`. Before 2.2.0 it was off by default and every save
// wrote that false, which isn't anyone's choice.
function switchedOff(mesh) {
  return !!mesh && mesh.autoJoin === false && mesh.chosen === true;
}

function saveSettings(s) {
  const { layout, layoutDisplays, mesh, ...rest } = s;
  store.saveSettings(rest);
  const join = !mesh || mesh.autoJoin !== false;
  store.write(MULTI, { ...store.read(MULTI, {}), layout, layoutDisplays, mesh: join ? { autoJoin: true } : { autoJoin: false, chosen: true } });
}

module.exports = { init: store.init, filePath: store.filePath, read, write, loadSettings, saveSettings };
