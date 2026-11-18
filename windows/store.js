// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// JSON files in Electron's userData folder, written atomically (temp file + rename).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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

function write(name, obj) {
  const f = file(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

function remove(name) {
  try {
    fs.unlinkSync(file(name));
  } catch (e) {
    /* already gone */
  }
}

module.exports = { read, write, remove, filePath: file };
