// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// JSON files in Electron's userData folder, written atomically (temp file + rename).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Windows refuses the rename for a moment while another process has the file open (antivirus,
// the search indexer, OneDrive): EPERM/EACCES/EBUSY. Tried again a few times, ~0.3 s in all.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_MS = [10, 20, 40, 80, 160];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function rename(tmp, f) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(tmp, f);
    } catch (e) {
      if (!BUSY.has(e.code) || i >= RETRY_MS.length) throw e;
      pause(RETRY_MS[i]);
    }
  }
}

// false when it couldn't be saved: logged, never thrown (a settings save in the middle of a message
// from another device took the app down: AMXLPDL, multi.json held by another process).
function write(name, obj) {
  const f = file(name);
  const data = JSON.stringify(obj, null, 2);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
      rename(tmp, f);
    } catch (e) {
      // Still held: written in place (not atomic, but saved), the temp file removed.
      fs.writeFileSync(f, data);
      try { fs.unlinkSync(tmp); } catch (_) { /* goes with the next save */ }
      console.warn(`[store] ${name}: the rename failed (${e.code}), written in place`);
    }
    return true;
  } catch (e) {
    console.error(`[store] ${name} not saved: ${e.message}`);
    return false;
  }
}

function remove(name) {
  try {
    fs.unlinkSync(file(name));
  } catch (e) {
    /* already gone */
  }
}

module.exports = { read, write, remove, filePath: file };
