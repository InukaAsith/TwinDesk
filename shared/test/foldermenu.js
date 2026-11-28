// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/foldermenu.js: Share folder from a file manager's menu. The argument (--td share) and the
// Mac's link (hex path) give back only real absolute folders; it opens the Share <folder> with… sheet
// (shared/folders-host.js), whose Share adds the folder with its devices; mac/finder.js writes its
// Quick Action once.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../foldermenu.js');
const finder = require('../../mac/finder.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foldermenu-'));
const dir = path.join(root, 'My “photos” & $stuff');
fs.mkdirSync(dir);
const file = path.join(root, 'a.txt');
fs.writeFileSync(file, 'x');

(async () => {
  assert.strictEqual(F.fromArgv(['TwinDesk.exe', '--td', 'share', dir]), dir);
  assert.strictEqual(F.fromArgv(['TwinDesk.exe', '--td', 'share', `${dir}"`]), dir, 'Explorer’s stray quote');
  assert.strictEqual(F.fromArgv(['x', '--td', 'share', file]), '', 'a file isn’t a folder');
  assert.strictEqual(F.fromArgv(['x', '--td', 'share', 'relative']), '');
  assert.strictEqual(F.fromArgv(['x', '--td', 'import', dir]), null, 'Import from phone is explorer.js’s');
  assert.strictEqual(F.fromArgv(['x', '--send-files', dir]), null);

  const hex = Buffer.from(dir, 'utf8').toString('hex');
  assert.strictEqual(F.fromUrl(`macshare://share-folder?h=${hex}`), dir);
  assert.strictEqual(F.fromUrl('macshare://share-folder?h=zz'), '');
  assert.strictEqual(F.fromUrl(`macshare://share-folder?h=${Buffer.from('rel').toString('hex')}`), '');
  assert.strictEqual(F.fromUrl('macshare://send?p=/tmp'), null);
  assert.strictEqual(F.fromUrl('not a url'), null);

  // Share folder opens the sheet (shared/folders-host.js); Share adds the folder with the devices picked
  const { foldersHost } = require('../folders-host.js');
  const app = { drive: { on: false, folder: '' } };
  let saved = 0, shown = 0, told = 0, loaded = 0;
  const fh = foldersHost({
    settings: () => app, save: () => saved++, push() {}, getDrive: () => null, loadDrive: () => { loaded++; return null; },
    phoneShare: () => ({ host: async () => told++ }), devices: () => [{ id: 'PHONE', name: 'Pixel', os: 'android' }, { id: 'PC', name: 'Desk', os: 'windows' }],
    show: () => shown++,
  });
  fh.ask(dir);
  assert.strictEqual(shown, 1);
  assert.deepStrictEqual(fh.view().sheet, { path: dir, name: path.basename(dir), shared: null });
  await fh.actions.folderShare({ path: dir, devices: ['PHONE'] });
  assert.strictEqual(fh.view().sheet, null, 'answered: the sheet goes');
  assert.strictEqual(app.drive.folders.length, 1);
  assert.deepStrictEqual(app.drive.folders[0].devices, ['PHONE']);
  assert.strictEqual(app.drive.folders[0].path, dir);
  assert.strictEqual(loaded, 0, 'phones only: the Drive engine stays unloaded');
  assert.strictEqual(told, 1, 'the phone share is told at once');
  await fh.actions.folderShare({ path: dir, devices: ['PHONE', 'PC'] });
  assert.strictEqual(app.drive.folders.length, 1, 'the same folder again: its devices change');
  assert.strictEqual(loaded, 1, 'a computer among them: the engine is loaded');
  await fh.actions.folderShare({ path: 'relative', devices: 'all' });
  assert.strictEqual(app.drive.folders.length, 1);
  await fh.actions.folderRemove(app.drive.folders[0].id);
  assert.strictEqual(app.drive.folders.length, 0, 'Stop sharing: gone from the list (the files stay)');
  assert.ok(fs.existsSync(dir));
  assert.ok(saved >= 3);

  // FolderShare's act('folder'): this folder, shared
  const { FolderShare } = require('../foldershare.js');
  const s = { shareServe: false, shareFolder: '' };
  const fsh = Object.create(FolderShare.prototype);
  Object.assign(fsh, { hub: { save: () => saved++ }, host: async () => {}, emit() {} });
  Object.defineProperty(fsh, 'settings', { get: () => s });
  await fsh.act('folder', { path: dir });
  assert.deepStrictEqual(s, { shareServe: true, shareFolder: dir });

  // Finder's Quick Action: written once, its script finds the folder by hex
  const qa = path.join(root, 'Q.workflow', 'Contents');
  assert.strictEqual(finder.install({ dir: qa }), true);
  assert.strictEqual(finder.install({ dir: qa }), false, 'unchanged: not written again');
  const wf = fs.readFileSync(path.join(qa, 'document.wflow'), 'utf8');
  assert.ok(wf.includes('/usr/bin/open -g "macshare://share-folder?h='));
  assert.ok(fs.readFileSync(path.join(qa, 'Info.plist'), 'utf8').includes('<string>public.folder</string>'));
  if (process.platform !== 'win32') {
    const out = require('child_process').execFileSync('/bin/sh', ['-c', finder.script('echo'), 'sh', dir, file], { encoding: 'utf8' }).trim().split('\n');
    assert.strictEqual(out.length, 1, 'folders only');
    assert.strictEqual(F.fromUrl(out[0]), dir);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('foldermenu: ok');
})().catch((e) => { console.error(e); process.exit(1); });
