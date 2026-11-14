// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const I18n = require('../i18n');
const root = path.resolve(__dirname, '../..');
const name = 'Work {me} $& <safe>';
const messages = {
  'Connection': '连接', 'Pairing…': '正在配对…', 'Connecting…': '正在连接…',
  'Not connected': '未连接', 'Allow': '允许', 'Deny': '拒绝', 'Cancel': '取消',
  '{name} wants to pair': '{name} 想要配对',
  'Check that {name} shows the same code.': '请确认 {name} 显示相同配对码。',
  'Switch on {name}’s hotspot': '开启 {name} 的热点',
  'Joining {ssid}…': '正在加入 {ssid}…',
  'Last seen {time}': '上次在线：{time}',
  'You’re using {name}': '你正在控制 {name}',
  'via {name}': '通过 {name}',
  'Waiting for it to connect': '等待对方连接',
  'Identity changed': '设备身份已变更',
  'Asked {name} to connect. Confirm on {name}.': '已请求连接 {name}。请在 {name} 上确认。',
  'Accessibility': '无障碍服务',
  'mac.accessibility': '辅助功能',
  'The pairing code has six digits.': '配对码为六位数字。',
  'Type the code the phone shows.': '输入手机上显示的配对码。',
  'Pairing didn’t work ({error}). Try a new code.': '配对失败（{error}）。请使用新的配对码重试。',
  'The phone connection stopped ({error}).': '手机连接已中断（{error}）。',
};
const t = I18n.create('zh-CN', { en: {}, 'zh-CN': messages }).t;
class Element {
  constructor(tag, opts = {}, children = []) {
    Object.assign(this, opts); this.tagName = tag; this.children = children.filter(Boolean);
    this.dataset = {}; this.style = { setProperty() {}, removeProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} }; this.parts = {};
  }
  append(...items) { this.children.push(...items.filter(Boolean)); }
  appendChild(item) { this.append(item); }
  setAttribute(key, value) { (this.attrs ||= {})[key] = value; }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items.filter(Boolean); }
  querySelector(key) { return this.parts[key] || (this.parts[key] = new Element('div')); }
  get textContent() { return this.text !== undefined ? this.text : this.children.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  set textContent(v) { this.text = v == null ? '' : String(v); this.children = []; }
}
const el = (tag, opts, children) => new Element(tag, opts, children);
for (const mode of ['mac', 'mac/mesh']) {
  const source = fs.readFileSync(path.join(root, mode, 'ui-start.js'), 'utf8');
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); };
  const context = { $, el, tr: t, UI: { via: () => 'Bluetooth' }, setTimeout() {} };
  vm.createContext(context);
  const start = source.indexOf('  let bannerMode = null;');
  const end = source.indexOf("  $('net-join').onclick", start);
  vm.runInContext(source.slice(start, end) + '\nthis.banner = renderBanner; this.net = renderNet;', context);
  context.banner({ pairing: { name, code: '123456' } });
  assert.strictEqual($('pair-title').textContent, name + ' 想要配对', mode + ': pairing title');
  assert.strictEqual($('pair-hint').textContent, '请确认 ' + name + ' 显示相同配对码。', mode + ': literal name');
  assert.strictEqual($('pair-allow').textContent, '允许');
  context.banner({ guest: { pairing: { name, phase: 'failed', error: 'Native {me} $& error' } } });
  assert.strictEqual($('pair-hint').textContent, 'Native {me} $& error');
  context.net({ client: { name }, net: { state: 'hotspot' } });
  assert.strictEqual($('net-title').textContent, '开启 ' + name + ' 的热点');
  context.net({ client: { name }, net: { state: 'joining', ssid: name } });
  assert.strictEqual($('net-title').textContent, '正在加入 ' + name + '…');
  context.net({ client: { name }, net: { state: 'failed', error: 'Native {me} $& error' } });
  assert.ok($('net-hint').textContent.includes('Native {me} $& error'));

  if (mode.endsWith('/mesh')) {
    const phoneStart = source.indexOf("  let phonesKey = '';");
    const phoneEnd = source.indexOf('  // Two kinds of pairing request:', phoneStart);
    const tileContext = { $, el, tr: t, UI: { via: () => 'Wi-Fi', osIcon: () => el('span') },
      M: require('../sidebar-model'), current: null, markTiles() {} };
    vm.createContext(tileContext);
    vm.runInContext(source.slice(phoneStart, phoneEnd) + '\nthis.phones = renderPhones;', tileContext);
    tileContext.phones({ phone: { assets: -1, nearby: [] }, peers: [
      { id: 'via', name, os: 'win', state: 'via', via: [name] },
      { id: 'waiting', name: 'Waiting device', os: 'win', state: 'waiting' },
      { id: 'identity', name: 'Identity device', os: 'win', state: 'identity_changed' },
    ] });
    const tiles = $('phones').children;
    assert.ok(tiles.some(tile => tile.textContent.includes('通过 ' + name)), 'mesh subtitle interpolates literal route name once');
    assert.ok(tiles.some(tile => tile.textContent.includes('等待对方连接')));
    assert.ok(tiles.some(tile => tile.textContent.includes('设备身份已变更')));
  }

  const built = [];
  let def;
  const UI = { el, api: {}, tab(d) { def = d; },
    button: (text) => el('button', { text }), switch: () => ({ set() {} }),
    row(label, hint, controls = [], options = {}) {
      const row = el('div', {}, controls); row.label = el('span', { text: label }); row.hint = el('span', { text: hint });
      row.append(row.label, row.hint); row.setHint = (v) => row.hint.textContent = v;
      row.querySelector = () => ({ prepend() {}, append() {} }); // shared/ui-adb.js puts its Show steps button there
      row.options = options; built.push(row); return row;
    },
    card: (_title, children) => el('div', {}, children), pair: (...children) => el('div', {}, children), dir: (_d, children) => el('div', {}, children),
    names: () => ({ Name: 'The other computer', name, me: 'Local {name} $&', os: 'win' }),
    peer: () => ({ name, me: 'Local {name} $&' }), fill: x => t(x, { name, me: 'Local {name} $&' }),
    osClass: () => 'pc', osIcon: () => el('span'), ago: () => '2 min', via: () => 'Wi-Fi', isPhone: () => false,
    adbCard: () => ({ el: el('div'), update() {} }), adbBle: () => false,
    note: () => Object.assign(el('div'), { set() {} }),
  };
  const pageContext = { UI, window: { I18n: { t } }, setTimeout() {}, Date, console };
  const adbSource = fs.readFileSync(path.join(root, 'shared/ui-adb.js'), 'utf8');
  // Multi-device's Connection page has the one-to-one app's wireless debugging card (all of shared/ui-adb.js).
  const adbPart = mode.endsWith('/mesh') ? adbSource : adbSource.slice(0, adbSource.indexOf('\nUI.adbCard ='));
  vm.runInNewContext(adbPart + '\n' + fs.readFileSync(path.join(root, mode, 'ui-overview.js'), 'utf8'), pageContext);
  assert.strictEqual(def.title, '连接', mode + ': connection title');
  const body = el('div'); const update = def.build(body);
  const state = { macName: 'Local {name} $&', addresses: ['192.0.2.10'], paired: [{ id: 'saved', name, lastSeen: 1 }],
    found: [{ id: 'found', name, address: '192.0.2.11', os: 'win' }],
    peers: [{ id: 'via', name, os: 'win', state: 'via', via: [name] }],
    guest: { status: {}, hosts: [] }, net: {}, phone: {},
    connect: { message: 'English interpolation should not be used', messageKey: 'Asked {name} to connect. Confirm on {name}.', messageVars: { name } },
  };
  update(state);
  const namedRows = built.filter(row => row.label.textContent === name);
  assert.ok(namedRows.length >= 2, mode + ': found and paired devices keep literal names');
  assert.ok(namedRows.every(row => row.options.literal), mode + ': device rows are excluded from peer filling');
  const ipRow = built.find(row => row.label.textContent === 'Connect by address');
  assert.strictEqual(ipRow.hint.textContent, '已请求连接 ' + name + '。请在 ' + name + ' 上确认。');
  assert.ok(ipRow.options.literal, mode + ': structured status preserves literal braces');
  state.client = { id: 'active', name, os: 'win' }; state.input = { where: 'driving' };
  state.connect = { error: true, message: 'Native {me} $& error' };
  update(state);
  assert.strictEqual(ipRow.hint.textContent, 'Native {me} $& error');
  const elements = (node) => [node, ...(node.children || []).filter(x => typeof x !== 'string').flatMap(elements)];
  const status = elements(body).find(node => node.class === 'hero-status');
  assert.strictEqual(status.textContent, '你正在控制 ' + name, mode + ': hero status fills names once');
  state.permissions = { screen: 'granted', accessibility: false, inputMonitoring: true };
  state.ui = { setupDone: true };
  update(state);
  assert.ok(built.some(row => row.label.textContent.includes('辅助功能')), mode + ': Mac permission uses the platform-specific label');
  assert.ok(!built.some(row => row.label.textContent.includes('无障碍服务')), mode + ': Android permission wording is excluded');
  if (mode.endsWith('/mesh')) {
    const adbRow = built.find(row => row.label.textContent === 'Wireless debugging');
    for (const [message, expected] of [
      ['The pairing code has six digits.', '配对码为六位数字。'],
      ['Type the code the phone shows.', '输入手机上显示的配对码。'],
      ['Pairing didn’t work (Native {me} $& error). Try a new code.', '配对失败（Native {me} $& error）。请使用新的配对码重试。'],
      ['The phone connection stopped (Native {me} $& error).', '手机连接已中断（Native {me} $& error）。'],
      ['Native {me} $& error', 'Native {me} $& error'],
    ]) {
      state.phone = { connected: { id: 'phone' }, bridge: { state: 'needsPair', message } };
      update(state);
      assert.strictEqual(adbRow.hint.textContent, expected, mode + ': wireless debugging message');
      assert.ok(adbRow.options.literal, mode + ': native debugging errors are excluded from peer filling');
    }
  }
}
console.log('i18n-mac-shell: pairing, hotspot, connection and literal names pass in both macOS modes');
