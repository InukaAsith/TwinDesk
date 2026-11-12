// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../i18n.js');
const I18n = runtime.create('zh-CN');

function load(file, language = I18n) {
  let tab;
  const rows = [];
  const nodes = [];
  const node = (tag, opts = {}, children = []) => {
    const n = { value: '', ...opts, tag, children, dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, toggle() {}, remove() {} },
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      prepend(...items) { this.children.unshift(...items); },
      querySelector() { return node('div'); }, set(v) { this.value = v; }, disable(v) { this.disabled = v; },
      setHint(v) { this.hint.textContent = v; }, options() {}, setAttribute() {} };
    n.textContent = opts.text || '';
    nodes.push(n);
    return n;
  };
  const UI = {
    tab(v) { tab = v; }, el: node, api: new Proxy({}, { get: () => () => {} }),
    row(label, hint, controls = [], opts) { const n = node('row', { literal: opts && opts.literal, literalHint: opts && opts.literalHint }, controls); n.label = node('label', { text: label }); n.hint = node('hint', { text: hint }); rows.push(n); return n; },
    note(kind, text, opts) { const n = node('note', { kind, text, literal: opts && opts.literal }); n.set = (v) => { n.textContent = v; }; return n; },
    button(text, click) { return node('button', { text, onclick: click }); },
    switch() { return node('switch'); }, select() { return node('select'); }, segmented() { const n = node('segment'); n.el = n; return n; },
    card(title, children) { return node('card', { title }, children); }, pair: (...children) => node('pair', {}, children), dir: (id, children) => node('dir', {}, children),
    slider: () => node('slider'), phoneAudioCard: () => ({ el: node('div'), update() {} }),
    historyCard: () => ({ el: node('div'), update() {} }), nowPlaying: () => ({ el: node('div'), update() {} }), adbBle: () => false, appIcon: () => node('img'),
    paceRow: () => ({ render() {} }), codecImpl: (name, hw) => I18n.t(hw ? 'Hardware' : 'Software') + ` (${name})`,
    peer: (s) => ({ name: s.client.name }), icon: () => node('icon'), fill: (s) => s, ago: () => '刚刚', bytes: (v) => String(v),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui-adb.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), { UI, I18n: language, window: { I18n: language, addEventListener() {} } }, { filename: file });
  const render = tab.build(node('body'), node('page'));
  return { tab, render(s) { UI.state = s; render(s); }, rows, nodes };
}

const audio = load('mac/ui-audio.js');
assert.strictEqual(audio.tab.title, I18n.t('Audio'));
assert.notStrictEqual(audio.tab.title, 'Audio');
const device = 'Work {name} $&';
const diagnostic = 'capture {me} $& failed';
audio.render({ client: { name: device }, audio: { send: true, receive: true, peerAccepts: true, sending: { status: 'live' }, receiving: { status: 'live' } } });
assert.ok(audio.rows.some((r) => r.hint.textContent === I18n.t('Playing on {device}', { device })));
audio.render({ client: { name: device }, audio: { send: true, receive: false, peerAccepts: true, error: diagnostic } });
assert.ok(audio.rows.some((r) => r.hint.textContent === I18n.t('Can’t capture sound: {error}', { error: diagnostic })));
const notifs = load('mac/ui-notifs.js');
notifs.render({ client: { name: device }, notifs: { send: true, receive: true, access: 'yes', apps: [{ app: 'test.id', appName: 'Ready {me}' }], muted: [] } });
const appRow = notifs.rows.find((r) => r.label.textContent === 'Ready {me}');
assert.ok(appRow && appRow.literal, 'application names are literal row data');

// Known application-owned messages interpolate diagnostics once; native text remains literal.
const messageLanguage = runtime.create('zh-CN', { en: {}, 'zh-CN': {
  'Couldn’t mount the phone: {error}': '无法挂载手机：{error}',
  'Pairing didn’t work ({error}). Try a new code.': '配对失败（{error}），请重试新配对码。',
  'Installing on {device}…': '正在 {device} 上安装…',
  'Last copy not sent: {reason}.': '上次复制未发送：{reason}。',
  'skipped {size} KB (over {limit} KB)': '跳过 {size} KB（超过 {limit} KB）',
  'files aren’t sent by ⌘C: copy them with {copy}, paste with {paste}': '⌘C 不发送文件：请用 {copy} 复制，再用 {paste} 粘贴',
  '{device} doesn’t take the clipboard': '{device} 不接收剪贴板',
} });
const mount = load('mac/ui-mount.js', messageLanguage);
mount.render({ mount: { on: true, message: `Couldn’t mount the phone: ${diagnostic}` } });
assert.ok(mount.rows.some((r) => r.hint.textContent === `无法挂载手机：${diagnostic}` && r.literalHint));
const phone = load('mac/ui-phone.js', messageLanguage);
phone.render({ client: { name: device }, phone: { connected: { name: device }, bridge: { state: 'needsPair', message: `Pairing didn’t work (${diagnostic}). Try a new code.`, fullApk: true, install: { state: 'installing', message: `Installing on ${device}…` } } } });
assert.ok(phone.rows.some((r) => r.hint.textContent === `配对失败（${diagnostic}），请重试新配对码。` && r.literalHint));
assert.ok(phone.rows.some((r) => r.hint.textContent === `正在 ${device} 上安装…` && r.literalHint));
const clipboard = load('mac/ui-clipboard.js', messageLanguage);
const copyState = { client: { name: device }, clipboard: { enabled: true, history: [], historySize: 10, lastSkip: 'skipped 50 KB (over 16 KB)' } };
clipboard.render(copyState);
assert.ok(clipboard.nodes.some((n) => n.tag === 'note' && n.literal && n.textContent === '上次复制未发送：跳过 50 KB（超过 16 KB）。'));
copyState.clipboard.lastSkip = `files aren’t sent by ⌘C: copy them with Copy {name}, paste with Paste {me}`;
clipboard.render(copyState);
assert.ok(clipboard.nodes.some((n) => n.textContent === '上次复制未发送：⌘C 不发送文件：请用 Copy {name} 复制，再用 Paste {me} 粘贴。'));
copyState.clipboard.lastSkip = `${device} doesn’t take the clipboard`;
clipboard.render(copyState);
assert.ok(clipboard.nodes.some((n) => n.textContent === `上次复制未发送：${device} 不接收剪贴板。`));
const receive = load('mac/ui-display-pc.js');
const receiveState = { client: { name: device }, receive: { status: 'live', stats: { decoder: 'VideoToolbox (hw)' } } };
receive.render(receiveState);
assert.ok(receive.nodes.some((n) => n.textContent === I18n.t('Hardware') + ' (VideoToolbox)'));
receiveState.receive.stats.decoder = 'Unknown decoder';
receive.render(receiveState);
assert.ok(receive.nodes.some((n) => n.textContent === 'Unknown decoder'), 'absent hardware metadata must not invent software decoding');
console.log('i18n-mac-features: audio, notifications, mount, phone and clipboard rendering with literal data passed');
