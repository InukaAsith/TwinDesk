// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/apkinstall.js (Phone › Apps › Install Apps): .apk files go to adb one by one, the state and
// popups say how it went, the app list is asked for again; nothing runs without wireless debugging.
// Run with: node shared/test/apkinstall.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../apkinstall.js');

function fakeBridge(answers, over = {}) {
  const ran = [], popups = [], sent = [];
  const b = {
    serial: 'phone:5555', state: 'ready', ran, popups, sent,
    adb: { run: async (args) => { ran.push(args); return answers.shift() || { out: 'Success', err: '' }; } },
    server: { sendToClient: (m) => sent.push(m) },
    emit: (name, kind, p) => name === 'popup' && popups.push([kind, p]),
    ...over,
  };
  return b;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-'));
  const a = path.join(dir, 'Notes.apk'), b = path.join(dir, 'Game.APK'), txt = path.join(dir, 'readme.txt');
  for (const f of [a, b, txt]) fs.writeFileSync(f, 'x');

  // One app: installed, its name in the popup, the list asked for again.
  let br = fakeBridge([]);
  await A.install(br, [a]);
  assert.deepStrictEqual(br.ran, [['-s', 'phone:5555', 'install', '-r', a]]);
  assert.strictEqual(br.appInstall.state, 'done');
  assert.deepStrictEqual(br.popups[0], ['driven', { key: 'Installed {app} on the phone', vars: { app: 'Notes' } }]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(br.sent[0].t, 'phone.apps.list');

  // Two, one fails: only .apk files go, the reason in words.
  br = fakeBridge([{ out: 'Success' }, { out: '', err: 'adb: failed to install: Failure [INSTALL_FAILED_OLDER_SDK: Requires newer sdk version]' }]);
  await A.install(br, [a, txt, b, 'relative.apk', path.join(dir, 'missing.apk')]);
  assert.strictEqual(br.ran.length, 2, 'only the two .apk files there');
  assert.strictEqual(br.appInstall.state, 'failed');
  assert.deepStrictEqual(br.popups[0], ['home', { key: 'Couldn’t install {app} ({error})', vars: { app: 'Game', error: { key: 'This app needs a newer Android.' } } }]);
  assert.strictEqual(A.reason('Failure [INSTALL_FAILED_WHATEVER]'), 'INSTALL_FAILED_WHATEVER');

  // Without wireless debugging nothing runs.
  br = fakeBridge([], { state: 'connecting' });
  await A.install(br, [a]);
  assert.strictEqual(br.ran.length, 0);
  assert.deepStrictEqual(br.popups[0], ['home', { key: 'Set up wireless debugging first.' }]);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('apkinstall: ok');
})().catch((e) => { console.error(e); process.exit(1); });
