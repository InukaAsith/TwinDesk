// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. No native Bluetooth or call operations are performed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const I18n = require('../i18n.js');
const backendPath = path.resolve(__dirname, '../../windows/callaudio.js');
const localRequire = createRequire(backendPath);
const noNative = () => { throw new Error('Unexpected native operation'); };
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(backendPath, 'utf8'), {
  module: mod, __dirname: path.dirname(backendPath), console: { log() {} },
  require: (name) => name === './ps' ? { script: noNative } : name === 'child_process' ? { spawn: noNative } : localRequire(name),
  setTimeout: noNative, clearTimeout: noNative,
});
const audio = mod.exports.create({ device: () => '', save: noNative });
const rendererSource = fs.readFileSync(path.resolve(__dirname, '../ui-calls.js'), 'utf8');
function renderer(language) {
  const window = language ? { I18n: I18n.create(language) } : {};
  const prefix = rendererSource.slice(0, rendererSource.indexOf('UI.tab({'));
  vm.runInNewContext(prefix + '\nwindow.test = { audioStatus, audioPairHow };\n})();', { window });
  return window.test;
}
const raw = renderer(), en = renderer('en'), zh = renderer('zh-CN');
const phone = 'Phone $& {name}', target = 'Headset $& {me}';
audio.phoneName = phone;
audio.id = 'test-phone';
audio.devices = [{ id: audio.id, name: target }];
for (const [state, expected] of [
  ['starting', 'Starting…'],
  ['off', 'Off'],
  ['needs-pair', `Not paired with ${phone} over classic Bluetooth: pair them in Bluetooth settings, as below`],
  ['choose', `Which one is ${phone}? Pick it, or pair it below if it isn’t there`],
  ['connecting', `Connecting to ${target}…`],
  ['ready', `Connected to ${target} over Bluetooth: calls play on this PC`],
]) {
  audio.state = state;
  const view = audio.view;
  assert.strictEqual(view.message, expected, 'the existing English view contract stays unchanged');
  assert.strictEqual(raw.audioStatus(view), expected);
  assert.strictEqual(en.audioStatus(view), expected);
  assert.match(zh.audioStatus(view), /[\u4e00-\u9fff]/);
}
assert.ok(zh.audioStatus(audio.view).includes(target), 'device-name braces and dollars stay literal');
assert.ok(zh.audioPairHow(audio.view).includes(phone));
assert.strictEqual(raw.audioPairHow(audio.view), audio.view.pairHow);
audio.state = 'failed';
audio.error = 'native <0x123> $& {name}';
assert.ok(zh.audioStatus(audio.view).includes(audio.error), 'native diagnostics stay literal');
audio._line(JSON.stringify({ ev: 'state', state: 'disconnected', access: 'DeniedByUser' }));
assert.strictEqual(audio.view.ui.denial, 'privacy');
assert.ok(zh.audioStatus(audio.view).includes('隐私'));
audio._line(JSON.stringify({ ev: 'state', state: 'disconnected', error: 'unregistered' }));
assert.strictEqual(audio.view.ui.denial, 'unregistered');
assert.ok(zh.audioStatus(audio.view).includes(phone));
const otherPlatform = { state: 'ready', message: 'Other platform message', pairHow: 'Other platform pairing' };
assert.strictEqual(zh.audioStatus(otherPlatform), otherPlatform.message);
assert.strictEqual(zh.audioPairHow(otherPlatform), otherPlatform.pairHow);
console.log('i18n-callaudio: English compatibility, Chinese states, denial reasons and literal user/native data passed');
