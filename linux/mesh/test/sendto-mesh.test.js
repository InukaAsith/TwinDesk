// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/sendto.js in Multi-device: one "Send to <name> (TwinDesk)" per paired computer in every installed
// file manager, each with --send-to=<id>, written only when the computers change, and a Send to sends to
// that device (the FileDropSet's unit), not to whichever is selected (#313).
// Run: node linux/mesh/test/sendto-mesh.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sendto-mesh-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
for (const cmd of ['nautilus', 'nemo', 'dolphin', 'thunar']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\n', { mode: 0o755 });
process.env.PATH = bin;
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
delete process.env.APPIMAGE;

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { isPackaged: true, getAppPath: () => '/opt/app' } };
  return load.call(this, id, ...args);
};
const SendTo = require('../../sendto.js');
Module._load = load;

const read = (f) => fs.readFileSync(f, 'utf8');
const data = (...p) => path.join(process.env.XDG_DATA_HOME, ...p);
const config = (...p) => path.join(process.env.XDG_CONFIG_HOME, ...p);

try {
  const welcome = [];
  const bus = { onPeer: (ev, fn) => ev === 'welcome' && welcome.push(fn), connectedIds: () => connected };
  let connected = ['r9'];
  const sentTo = [];
  const unit = (id) => ({ sendBatch: (paths) => { sentTo.push([id, paths]); return { items: paths, name: path.basename(paths[0]) }; } });
  const fileDrop = { unit, sendBatch: () => { throw new Error('not the selected device'); } };
  const popups = [];
  const s = new SendTo({ link: { on() {} }, bus, nameOf: (id) => ({ r9: 'Ryzen9', mb: 'MacBook' }[id]), fileDrop, peerName: () => 'selected', popup: (...a) => popups.push(a) });

  s.sync([{ id: 'r9', name: 'Ryzen9' }, { id: 'mb', name: 'MacBook' }]);
  const scripts = fs.readdirSync(data('nautilus', 'scripts')).sort();
  assert.deepStrictEqual(scripts, ['Send to MacBook (TwinDesk)', 'Send to Ryzen9 (TwinDesk)', 'Share folder (TwinDesk)']);
  // Share folder on folders, in each file manager (shared/foldermenu.js: --td share <folder>)
  assert.match(read(data('nautilus', 'scripts', 'Share folder (TwinDesk)')), /exec '[^']+' --td share "\$f"/);
  assert.match(read(data('nemo', 'actions', 'twindesk-share.nemo_action')), /Exec=\S+ --td share %f\nIcon-Name=folder-remote\nSelection=s\nExtensions=dir;/);
  assert.match(read(data('kio', 'servicemenus', 'twindesk-share.desktop')), /MimeType=inode\/directory;[\s\S]*Exec=\S+ --td share %f/);
  assert.match(read(config('Thunar', 'uca.xml')), /<unique-id>twindesk-share-folder<\/unique-id>\n\t<command>\S+ --td share %f<\/command>[\s\S]*<directories\/>\n<\/action>/);
  assert.match(read(data('nautilus', 'scripts', 'Send to Ryzen9 (TwinDesk)')), /--send-files '--send-to=r9' "\$@"/);
  assert.deepStrictEqual(fs.readdirSync(data('nemo', 'actions')).sort(), ['twindesk-send-1.nemo_action', 'twindesk-send.nemo_action', 'twindesk-share.nemo_action']);
  const dolphin = read(data('kio', 'servicemenus', 'twindesk-send.desktop'));
  assert.match(dolphin, /Actions=twindeskSend0;twindeskSend1;/);
  assert.match(dolphin, /Name=Send to MacBook \(TwinDesk\)\nIcon=document-send\nExec=\S+ --send-files --send-to=mb %F/);
  const uca = read(config('Thunar', 'uca.xml'));
  assert.strictEqual((uca.match(/<unique-id>twindesk-send-files(-1)?<\/unique-id>/g) || []).length, 2);

  // Called with every state push: unchanged, nothing is rewritten.
  const at = fs.statSync(data('nemo', 'actions', 'twindesk-send.nemo_action')).mtimeMs;
  fs.utimesSync(data('nemo', 'actions', 'twindesk-send.nemo_action'), new Date(0), new Date(0));
  s.sync([{ id: 'r9', name: 'Ryzen9' }, { id: 'mb', name: 'MacBook' }]);
  assert.strictEqual(fs.statSync(data('nemo', 'actions', 'twindesk-send.nemo_action')).mtimeMs, 0, 'not written again');
  void at;

  // The MacBook unpaired: its entries go, Ryzen9's stay, Thunar keeps one action.
  s.sync([{ id: 'r9', name: 'Ryzen9' }]);
  assert.deepStrictEqual(fs.readdirSync(data('nautilus', 'scripts')).sort(), ['Send to Ryzen9 (TwinDesk)', 'Share folder (TwinDesk)']);
  assert.deepStrictEqual(fs.readdirSync(data('nemo', 'actions')).sort(), ['twindesk-send.nemo_action', 'twindesk-share.nemo_action']);
  assert.strictEqual((read(config('Thunar', 'uca.xml')).match(/<unique-id>twindesk-send/g) || []).length, 1);
  assert.strictEqual((read(config('Thunar', 'uca.xml')).match(/<unique-id>twindesk-share-folder/g) || []).length, 1, 'Share folder kept once');

  // A Send to Ryzen9 goes to Ryzen9's FileDrop, whichever device is selected.
  const file = path.join(root, 'photo.jpg');
  fs.writeFileSync(file, 'x');
  assert.strictEqual(s.handle(['/opt/app/twindesk', '--send-files', '--send-to=r9', file]), true);
  assert.deepStrictEqual(sentTo.pop(), ['r9', [file]]);
  // To the MacBook while it isn't connected: kept, and sent when it is (its own welcome, not another's).
  s.handle(['/opt/app/twindesk', '--send-files', '--send-to=mb', file]);
  assert.strictEqual(sentTo.length, 0);
  connected = ['r9', 'mb'];
  for (const fn of welcome) fn('r9');
  assert.strictEqual(sentTo.length, 0, 'Ryzen9 connecting doesn’t send the MacBook’s');
  for (const fn of welcome) fn('mb');
  assert.deepStrictEqual(sentTo.pop(), ['mb', [file]]);

  // Nothing paired: every Send to goes; Share folder stays (phones can get folders too).
  s.sync([]);
  assert.deepStrictEqual(fs.readdirSync(data('nautilus', 'scripts')), ['Share folder (TwinDesk)']);
  assert.ok(!fs.existsSync(data('kio', 'servicemenus', 'twindesk-send.desktop')));
  assert.ok(fs.existsSync(data('kio', 'servicemenus', 'twindesk-share.desktop')));
  assert.ok(!/<unique-id>twindesk-send/.test(read(config('Thunar', 'uca.xml'))));
  console.log('sendto-mesh: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
