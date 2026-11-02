// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');

// Exercise each real IPC module, with only Electron's transport replaced.
for (const mode of ['windows', 'windows/mesh']) {
  const handlers = new Map();
  const filename = path.join(ROOT, mode, 'ipc.js');
  const localRequire = createRequire(filename);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => name === 'electron' ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } } : localRequire(name),
    module: mod, __dirname: path.dirname(filename), console, process: { env: {} },
  }, { filename });
  const model = localRequire('./settings');
  let stored = null, reloads = 0, pushes = 0;
  const ctx = {
    settings: model.normalize({ ui: { tab: 'general' } }),
    save() { stored = JSON.parse(JSON.stringify(this.settings)); },
    push() { pushes++; },
    onLanguage() { reloads++; },
  };
  mod.exports(ctx);
  assert.ok(handlers.has('setLanguage'), `${mode} has the language action`);
  const set = (value) => handlers.get('setLanguage')({}, value);
  for (const bad of [null, {}, 'fr', '../zh-CN', 'zh-cn']) set(bad);
  assert.strictEqual(stored, null, 'unsupported values do not write settings');
  set('zh-CN');
  assert.strictEqual(stored.ui.language, 'zh-CN');
  assert.strictEqual(stored.ui.tab, 'general', 'switching languages keeps the selected page');
  assert.strictEqual(reloads, 1);
  assert.strictEqual(pushes, 1);
  set('zh-CN');
  assert.strictEqual(reloads, 1, 'the same preference does not reload again');
  set('en');
  assert.strictEqual(stored.ui.language, 'en');
  assert.strictEqual(reloads, 2);
}

// Run the installer's actual resource-copy logic in a temporary staging directory.
const source = fs.readFileSync(path.join(ROOT, 'windows/installer/build.js'), 'utf8');
const copyCode = source.slice(source.indexOf('function copy('), source.indexOf('// Runtime dependencies'));
assert.ok(copyCode.startsWith('function copy('), 'found the actual staging copy function');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-i18n-stage-'));
try {
  const context = vm.createContext({ fs, path });
  vm.runInContext(copyCode, context);
  const copyShared = source.match(/copy\(path.join\(ROOT, 'shared'\), path.join\(STAGE, 'shared'\),[^;]+;/);
  assert.ok(copyShared, 'found the shared resource copy rule');
  context.ROOT = ROOT;
  context.STAGE = temp;
  vm.runInContext(copyShared[0], context);
  for (const filename of ['i18n.js', 'lang/en.js', 'lang/zh-CN.js']) {
    assert.ok(fs.existsSync(path.join(temp, 'shared', filename)), `${filename} is in the installed app`);
  }
  const installed = require(path.join(temp, 'shared/i18n.js'));
  assert.strictEqual(installed.create('zh-CN').t('General'), require('../i18n.js').create('zh-CN').t('General'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('i18n-integration: both IPC modes and installed translation resources passed');
