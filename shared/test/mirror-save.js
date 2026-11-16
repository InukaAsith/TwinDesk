// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/mirror-save.js: a screenshot is copied and saved in Pictures › TwinDesk (a non-PNG is
// ignored); a recording's parts go into Movies › TwinDesk in order, the file is shown when it ends,
// a second one never overwrites the first, a window closing keeps what it recorded, and a recording
// with nothing in it leaves no file.
// Run with: node shared/test/mirror-save.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MirrorSave } = require('../mirror-save.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-mirror-'));
const copied = [], shown = [], notes = [];
const electron = {
  // Electron's own names only (it throws on any other, as it did on 'movies').
  app: { getPath: (k) => { if (!['home', 'pictures', 'videos', 'music', 'documents', 'downloads', 'desktop'].includes(k)) throw new Error(`no path ${k}`); return path.join(dir, k); } },
  shell: { showItemInFolder: (p) => shown.push(p) },
  clipboard: { writeImage: (img) => copied.push(img) },
  nativeImage: { createFromBuffer: (b) => ({ isEmpty: () => b.length < 64, b }) },
};
const s = new MirrorSave({ electron, popup: (k) => notes.push(k), name: () => 'Pixel' });
const ls = (k) => { try { return fs.readdirSync(path.join(dir, k, 'TwinDesk')); } catch (_) { return []; } };

// Screenshot
const png = Buffer.alloc(100); png.writeUInt32BE(0x89504e47, 0);
assert.ok(s.handle('w', { t: 'shot', png: new Uint8Array(png), save: true }));
assert.strictEqual(copied.length, 1);
assert.strictEqual(ls('pictures').length, 1);
assert.ok(/^Pixel \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/.test(ls('pictures')[0]));
s.handle('w', { t: 'shot', png: new Uint8Array(100), save: true }); // not a PNG
assert.strictEqual(copied.length, 1);
// Without save: not ours (Windows' own copy-only path).
assert.strictEqual(s.handle('w', { t: 'shot', png: new Uint8Array(png) }), false);
assert.strictEqual(s.handle('w', { t: 'nav', key: 'home' }), false);

// Recording
s.handle('w', { t: 'rec', id: '1', begin: true, ext: 'mp4' });
s.handle('w', { t: 'rec', id: '1', seq: 0, part: new Uint8Array([1, 2, 3]) });
s.handle('w', { t: 'rec', id: 'other', seq: 1, part: new Uint8Array([9]) }); // not this one
s.handle('w', { t: 'rec', id: '1', seq: 1, part: new Uint8Array([4]) });
s.handle('w', { t: 'rec', id: '1', end: true });
const movies = ls('videos');
assert.strictEqual(movies.length, 1);
assert.ok(movies[0].endsWith('.mp4'));
assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'videos', 'TwinDesk', movies[0]))], [1, 2, 3, 4]);
assert.strictEqual(shown.length, 1);
// The same second again: a new name. Then the window closes mid-recording: kept.
s.handle('w2', { t: 'rec', id: '2', begin: true, ext: 'webm' });
s.handle('w2', { t: 'rec', id: '2', seq: 0, part: new Uint8Array([7]) });
s.closed('w2');
assert.strictEqual(ls('videos').length, 2);
assert.ok(ls('videos').some((n) => n.endsWith('.webm')));
// Nothing recorded: no file.
s.handle('w3', { t: 'rec', id: '3', begin: true, ext: 'mp4' });
s.handle('w3', { t: 'rec', id: '3', end: true });
assert.strictEqual(ls('videos').length, 2);

fs.rmSync(dir, { recursive: true, force: true });
console.log('mirror-save: ok');
