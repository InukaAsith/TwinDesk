// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const ipcMain = new EventEmitter();
const handles = new Map();
ipcMain.handle = (name, fn) => handles.set(name, fn);
const revealed = [], dragged = [];
let windowId = 0;
class Window extends EventEmitter {
  constructor(opts) {
    super(); this.opts = opts; this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, { id: ++windowId, mainFrame: {}, send() {}, setWindowOpenHandler() {}, startDrag(item) { dragged.push(item); } });
  }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  focus() {}
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
const original = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { BrowserWindow: Window, ipcMain,
    screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    nativeImage: { createFromPath: () => ({ resize() { return this; }, isEmpty: () => false }) },
    shell: { showItemInFolder: p => revealed.push(p) } };
  return original.apply(this, arguments);
};
const { FileShelf } = require('../file-shelf.js');
Module._load = original;
const event = shelf => ({ sender: shelf.win.webContents, senderFrame: shelf.win.webContents.mainFrame });
const read = shelf => handles.get('file-shelf:read')(event(shelf));
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'twindesk-shelf-test-'));

// The production class handles this end to end, while Electron effects are captured.
test('shelf presents bounded saved files and native drag or reveal only for its own items', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  drop.recent = [];
  try {
    for (let i = 0; i < 12; i++) { const file = path.join(dir, `file-${i}.txt`); fs.writeFileSync(file, 'fixture'); drop.recent.push({ path: file, ok: true }); }
    const shelf = new FileShelf({ drop, latestPhoto: () => ({ path: drop.recent[0].path }) });
    assert.equal(drop.listenerCount('change'), 0);
    shelf.show();
    assert.equal(drop.listenerCount('change'), 1);
    const state = read(shelf);
    assert.equal(state.items.length, 8);
    assert.equal(state.items[0].kind, 'photo');
    assert.equal(new Set(state.items.map(x => x.name)).size, 8, 'latest photo deduplicates Recent');
    assert.ok(state.items.every(item => !('path' in item)));
    const id = state.items[0].id;
    assert.equal(read(shelf).items[0].id, id, 'ordinary refresh retains focus identity');
    ipcMain.emit('file-shelf:drag', event(shelf), id);
    assert.equal(dragged.at(-1).file, drop.recent[0].path);
    ipcMain.emit('file-shelf:reveal', event(shelf), id);
    assert.equal(revealed.at(-1), drop.recent[0].path);
    shelf.refresh();
    assert.equal(read(shelf).items[0].id, id, 'same authorized local file retains focus across refresh');
    shelf.shutdown();
    assert.equal(drop.listenerCount('change'), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shelf refuses foreign frames, revoked photo and replaced or symlinked local files', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  const file = path.join(dir, 'file.txt'), link = path.join(dir, 'link.txt');
  fs.writeFileSync(file, 'original'); fs.symlinkSync(file, link);
  drop.recent = [{ path: link, ok: true }];
  let photo = { path: file };
  const shelf = new FileShelf({ drop, latestPhoto: () => photo });
  const oldDrags = dragged.length, oldReveals = revealed.length;
  try {
    shelf.show();
    const state = read(shelf);
    assert.equal(state.items.length, 1, 'symlink is omitted');
    const id = state.items[0].id;
    const ownEvent = event(shelf);
    ipcMain.emit('file-shelf:drag', { ...ownEvent, senderFrame: {} }, id);
    ipcMain.emit('file-shelf:reveal', { ...ownEvent, sender: { id: -1 } }, id);
    fs.renameSync(file, path.join(dir, 'old.txt')); fs.writeFileSync(file, 'replacement');
    ipcMain.emit('file-shelf:drag', ownEvent, id);
    const replacementId = read(shelf).items[0].id;
    photo = null;
    ipcMain.emit('file-shelf:reveal', ownEvent, replacementId);
    assert.equal(dragged.length, oldDrags);
    assert.equal(revealed.length, oldReveals);
    assert.equal(read(shelf).items.length, 0, 'revoked item leaves the shelf');
    shelf.shutdown();
    assert.equal(handles.get('file-shelf:read')(ownEvent), null, 'retired contents cannot read shelf');
  } finally { shelf.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
