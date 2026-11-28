// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/foldermenu.js: Share this folder from a file manager's menu. The argument (--td share) and the
// Mac's link (hex path) give back only real absolute folders; sharing goes through the hub when it's
// loaded, else into the settings; and mac/finder.js writes its Quick Action once.
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

  // The hub loaded: it shares the folder now
  const acts = [];
  const popups = [];
  const tabs = [];
  await F.share(dir, { hub: () => ({ phone: {}, share: { act: async (a, r) => acts.push([a, r]) } }), settings: () => ({}), save() {}, goTab: (t) => tabs.push(t), popup: (...a) => popups.push(a), phoneOn: () => true });
  assert.deepStrictEqual(acts, [['folder', { path: dir }]]);
  assert.deepStrictEqual(tabs, ['pfiles']);
  assert.strictEqual(popups[0][1].vars.name, path.basename(dir));
  // Not loaded (no phone yet): into the settings, which the hub reads when the phone connects
  const settings = { hub: { calls: true, shareServe: false, shareFolder: '' } };
  let saved = 0;
  await F.share(dir, { hub: () => ({ act() {} }), settings: () => settings, save: () => saved++ });
  assert.deepStrictEqual(settings.hub, { calls: true, shareServe: true, shareFolder: dir });
  assert.strictEqual(saved, 1);
  assert.strictEqual(await F.share('', { settings: () => settings, save() {} }), false);

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
