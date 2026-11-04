// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. Renderer-only: no native permission or update calls.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function render(locale) {
  const nodes = [], tabs = {}, calls = [];
  const t = (key, vars) => (key === 'mac.accessibility' ? locale === 'en' ? 'Accessibility' : '辅助功能' : locale === 'en' ? key : '译:' + key).replace(/\{(\w+)\}/g, (m, k) => vars && Object.hasOwn(vars, k) ? String(vars[k]) : m);
  function el(tag, options = {}, children = []) {
    const node = { tag, ...options, textContent: options.text || '', children: [...children],
      append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); },
      classList: { toggle() {} }, querySelector() { return this; } };
    nodes.push(node);
    return node;
  }
  const ui = {
    el, api: new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]) }),
    tab(def) { tabs[def.id] = def; },
    row(label, hint = '', controls = [], options = {}) {
      const row = el('row', { label, hint, options }, controls);
      row.setHint = (value) => { row.hint = value; };
      return row;
    },
    card: (label, children) => el('card', { label }, children),
    button: (label, click) => el('button', { label, click }),
    switch: (change, options) => ({ change, ...options, set(value) { this.value = value; }, disable() {} }),
    select: (options, change) => el('select', { options, change, set(value) { this.value = value; } }),
    mediaControlsRow: () => ({ el: el('media'), update() {} }),
    // shared/ui-look.js
    themeRow: () => Object.assign(el('row'), { render() {} }),
    accentRow: () => Object.assign(el('row'), { render() {} }),
    sections: (cards) => Object.assign(el('sections', {}, cards), { spy() {} }),
  };
  const ids = { content: el('content'), pages: el('pages') };
  const context = { UI: ui, I18n: { locale, t }, window: {}, document: { body: el('body'), getElementById: (id) => ids[id] } };
  for (const name of ['general', 'about', 'setup']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../mac/ui-' + name + '.js'), 'utf8'), context);
  }
  const general = tabs.general.build(el('general')), about = tabs.about.build(el('about'));
  const s = { permissions: { screen: 'granted', accessibility: true, inputMonitoring: true }, ui: {},
    net: { ble: true, blePc: true, radio: 'unauthorized' }, wake: {}, helper: { running: true }, macName: 'Allowed {name} $&',
    about: { app: { name: 'Native {name}', version: '1.2.3', thanks: 'Allowed {name}' }, pc: { cpu: 'CPU {name}', cores: 8 } },
    updates: { available: true, skipped: true, latest: '2.0', current: '1.2.3', download: { name: 'Allowed {name} $&.dmg' } } };
  general(s); about(s); ui.setup.render(s);
  const translated = (text) => t(text);
  const selectors = nodes.filter((n) => n.tag === 'select' && n.options.some((o) => o.value === 'en')); // the language pickers (Advanced has the input protocol's)
  assert.strictEqual(selectors.length, 2, 'General and Setup both expose the language selector');
  for (const selector of selectors) {
    assert.strictEqual(selector.value, locale);
    assert.deepStrictEqual(Array.from(selector.options, (o) => o.label), ['English', '简体中文', 'Русский', 'Türkçe']);
    selector.change(locale === 'en' ? 'zh-CN' : 'en');
  }
  assert.strictEqual(calls.filter(([key]) => key === 'setLanguage').length, 2);
  assert.ok(nodes.some((n) => n.label === translated('Screen Recording')));
  assert.strictEqual(nodes.filter((n) => n.tag === 'row' && n.label === t('mac.accessibility')).length, 2, 'both macOS permission lists use the contextual Accessibility label');
  assert.ok(nodes.some((n) => n.textContent === translated('Allowed by Accessibility')));
  for (const [screen, expected] of [['denied', 'Not allowed'], ['unknown', 'Unknown'], ['granted', 'Allowed']]) {
    general({ ...s, permissions: { ...s.permissions, screen } });
    assert.ok(nodes.some((n) => n.textContent === translated(expected)), 'permission status is translated: ' + expected);
  }
  assert.strictEqual(ui.setup.render(s), false, 'Setup closes after permissions are granted');
  const denied = { ...s, permissions: { screen: 'denied', accessibility: false, inputMonitoring: false } };
  assert.strictEqual(ui.setup.render(denied), true);
  nodes.find((n) => n.label === translated('Skip for now')).click();
  assert.ok(calls.some(([key, value]) => key === 'skipSetup' && value === 'screen,accessibility,inputMonitoring'));
  assert.strictEqual(ui.setup.render({ ...denied, ui: { setupSkipped: 'screen,accessibility,inputMonitoring' } }), false);
  assert.ok(nodes.some((n) => n.hint === translated('Allow TwinDesk in System Settings › Privacy & Security › Bluetooth')));
  assert.ok(nodes.some((n) => n.textContent === t('{version} is available (skipped)', { version: '2.0' })));
  assert.ok(nodes.some((n) => (n.hint || '').includes('Allowed {name} $&.dmg')), 'download filename stays literal');
  assert.ok(nodes.some((n) => n.textContent === s.macName && n.attrs['data-literal'] === ''), 'computer name is marked literal');
  const updateRow = nodes.find((n) => n.label === 'TwinDesk');
  assert.strictEqual(updateRow.options.literal, true, 'interpolated update text is not expanded again');
  const error = 'Native diagnostic {name} $&';
  about({ ...s, updates: { error } });
  assert.strictEqual(updateRow.hint, t('Couldn’t check: {error}', { error }));
  const allow = nodes.find((n) => n.label === translated('Allow'));
  allow.click();
  assert.ok(calls.some(([key, value]) => key === 'allowPermission' && value === 'screen'));
}
render('en');
render('zh-CN');
console.log('i18n-mac-general: General/About/Setup translate both locales and preserve native/user values');
