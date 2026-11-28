// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared folders (phase 3 of the 2026-11-28 plan): up to MAX folders besides TwinDesk Drive's own, each
// shared with its own devices. Plain rules, no I/O, light enough for the settings sanitizers (the Drive
// engine, shared/drive-host.js, loads only while Drive is on):
//   settings.drive.folders = [{id, name, path, devices}]   devices: 'all' or [device ids]
// Computers keep them the same with Drive (each folder its own engine); phones are served the ones
// shared with them by shared/foldershare.js, as top-level folders of what the phone sees.
'use strict';

const os = require('os');
const path = require('path');

const MAX = 10;
const ID = /^[0-9a-f]{8,40}$/;

const safeName = (n) => String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 60) || 'Folder';
const cleanDevices = (d) => (Array.isArray(d) ? [...new Set(d.filter((x) => typeof x === 'string' && x && x.length <= 64))].slice(0, 32) : 'all');
const defaultPath = (name) => path.join(os.homedir(), 'TwinDesk Folders', safeName(name));

function cleanFolders(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object' || !ID.test(String(f.id)) || out.some((x) => x.id === f.id)) continue;
    out.push({ id: f.id, name: safeName(f.name), path: typeof f.path === 'string' && path.isAbsolute(f.path) ? f.path.slice(0, 1024) : '', devices: cleanDevices(f.devices) });
    if (out.length >= MAX) break;
  }
  return out;
}

// What settings.drive keeps of them (the sanitizers): the main folder's devices and the extra folders.
function clean(dr) {
  const d = dr && typeof dr === 'object' ? dr : {};
  return { devices: cleanDevices(d.devices), folders: cleanFolders(d.folders), declined: Array.isArray(d.declined) ? d.declined.filter((x) => typeof x === 'string' && ID.test(x)).slice(-64) : [] };
}

const pathOf = (f) => (f.path || defaultPath(f.name));
const sharedWith = (f, id) => !Array.isArray(f.devices) || f.devices.includes(id);

// The folders a phone is served (foldershare.js): [{name, path}], each name once.
function forDevice(settings, id) {
  const list = cleanFolders(settings && settings.drive && settings.drive.folders).filter((f) => sharedWith(f, id));
  const seen = new Set();
  return list.map((f) => {
    let n = f.name, i = 2;
    while (seen.has(n.toLowerCase())) n = `${f.name} ${i++}`;
    seen.add(n.toLowerCase());
    return { name: n, path: pathOf(f) };
  });
}

module.exports = { MAX, ID, safeName, cleanDevices, cleanFolders, clean, defaultPath, pathOf, sharedWith, forDevice };
