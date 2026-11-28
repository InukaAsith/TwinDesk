// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/foldershare.js with shared folders (shared/drive-folders.js): the phone is served the folders
// shared with it as a top level by name, beside this computer's folder while that's on; a folder shared
// with other devices only isn't there; nothing above a folder is reachable; without any, as before.
// Run: node shared/test/foldershare-folders.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FolderShare } = require('../foldershare.js');

(async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'td-fsfolders-')));
  const mine = path.join(base, 'Mine'), photos = path.join(base, 'Photos'), work = path.join(base, 'Work');
  for (const d of [mine, photos, work]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(photos, 'cat.jpg'), 'meow');
  const app = { hub: { shareServe: false, shareFolder: mine }, drive: { folders: [
    { id: 'aaaaaaaaaaaaaaaa', name: 'Photos', path: photos, devices: ['PHONE'] },
    { id: 'bbbbbbbbbbbbbbbb', name: 'Work', path: work, devices: ['OTHER'] },
  ] } };
  const hub = { settings: app.hub, getSettings: () => app, phone: { deviceId: 'PHONE', address: '1.2.3.4' }, server: { sendToClient() {} }, save() {} };
  const fsh = new FolderShare(hub, { mounter: {}, defaultFolder: mine, tls: () => null });

  assert.strictEqual(fsh.serving, true, 'a shared folder: served though this computer’s folder is off');
  assert.deepStrictEqual((await fsh._local('')).roots.map((r) => r.name), ['Photos'], 'only what is shared with this phone');
  assert.deepStrictEqual(await fsh._local('Photos/cat.jpg'), { p: path.join(photos, 'cat.jpg'), root: photos });
  assert.strictEqual(await fsh._local('Work/x'), null, 'not shared with it');
  assert.strictEqual(await fsh._local('Photos/../Mine'), null);

  app.hub.shareServe = true;
  assert.deepStrictEqual((await fsh._local('/')).roots.map((r) => r.name), ['Mine', 'Photos'], 'this computer’s folder beside it');

  app.drive.folders[0].devices = 'all';
  app.drive.folders[1].devices = 'all';
  assert.deepStrictEqual((await fsh._local('')).roots.map((r) => r.name), ['Mine', 'Photos', 'Work']);

  app.drive.folders = [];
  assert.deepStrictEqual(await fsh._local('x.txt'), { p: path.join(mine, 'x.txt'), root: mine }, 'none: the folder itself, as before');
  app.hub.shareServe = false;
  assert.strictEqual(fsh.serving, false);

  fsh.stop();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('foldershare-folders: ok');
})().catch((e) => { console.error(e); process.exit(1); });
