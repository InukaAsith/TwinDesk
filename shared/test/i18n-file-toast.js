// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. Executes real transfer UI callbacks, no files or native calls.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const I18n = require('../i18n');
const literal = 'Work {name} $& <raw>';
for (const file of ['windows/main.js', 'windows/mesh/main.js']) {
  for (const locale of ['en', 'zh-CN']) {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    const block = source.slice(source.indexOf('  const pct = '), source.indexOf('  wake = new Wake('));
    const messages = [], hud = [], link = new EventEmitter(), t = I18n.create(locale).t;
    let now = 10000;
    const context = { t, Date: { now: () => now }, AUMID: 'test', helper: { send: (...args) => messages.push(args) }, hud: { show: (...args) => hud.push(args) }, peerName: () => literal, fileRecv: {}, fileDrop: {}, fileClip: { pasted() {} }, rezume: null, link };
    vm.runInNewContext(block, context);
    context.fileRecv.onBatchProgress({ at: 0, total: 100, got: 50, count: 1, kind: 'paste' });
    assert.equal(messages.at(-1)[0], 'toastProgress');
    assert.equal(messages.at(-1)[1].title, t('Pasting {count} file from {name}', { count: 1, name: literal }));
    if (locale === 'zh-CN') assert.match(messages.at(-1)[1].title, /^正在从 .* 粘贴/, 'native notification has real Chinese text, not a fallback key');
    assert.equal(messages.at(-1)[1].value, 0.5, 'progress semantics unchanged');
    assert.equal(hud.at(-1)[1].key, 'Pasting {count} file from {name} · {percent} %', 'singular English remains singular');
    now += 1000;
    const batch = { name: '2 items', itemCount: 2, bytes: 6000000, sent: 3000000 };
    context.fileDrop.onBatchProgress(batch);
    const group = t('{count} items', { count: 2 });
    assert.equal(messages.at(-1)[1].title, t('Sending {file}', { file: group }), 'generated group label is translated');
    assert.deepEqual(JSON.parse(JSON.stringify(hud.at(-1)[1].vars.file)), { key: '{count} items', vars: { count: 2 } });
    now += 1000;
    context.fileDrop.onBatchProgress({ ...batch, done: true, ok: true });
    assert.equal(messages.at(-1)[1].title, t('Sent {file}', { file: group }));
    assert.equal(messages.at(-1)[1].text, t('On {name}', { name: literal }));
    now += 1000;
    context.fileDrop.onBatchProgress({ ...batch, name: literal, itemCount: 1 });
    assert.equal(messages.at(-1)[1].title, t('Sending {file}', { file: literal }), 'real filename is literal');
    link.emit('closed');
    assert.equal(messages.at(-1)[1].title, t('Files stopped'));
    assert.equal(messages.at(-1)[1].text, t('{name} disconnected', { name: literal }));
  }
}
console.log('i18n-file-toast: both Windows modes/locales translate real progress/completion callbacks, retaining names, counts and progress values');
