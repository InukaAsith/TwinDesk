// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const I18n = require('../i18n.js');
const { normalize, apply } = require('../../windows/settings.js');
const mesh = require('../../windows/mesh/settings.js');

assert.strictEqual(I18n.resolveLanguage('', 'zh-CN'), 'zh-CN');
assert.strictEqual(I18n.resolveLanguage('', 'zh_Hans_SG'), 'zh-CN');
assert.strictEqual(I18n.resolveLanguage('', 'zh-SG'), 'zh-CN');
assert.strictEqual(I18n.resolveLanguage('', 'zh-TW'), 'en');
assert.strictEqual(I18n.resolveLanguage('', 'fr-FR'), 'en');
assert.strictEqual(I18n.resolveLanguage('en', 'zh-CN'), 'en');
assert.strictEqual(I18n.resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
assert.strictEqual(I18n.resolveLanguage('../evil', 'en-US'), 'en');
assert.strictEqual(I18n.resolveLanguage(null, null), 'en');
for (const system of ['pt-BR', 'pt_BR', 'pt', 'pt-PT']) assert.strictEqual(I18n.resolveLanguage('', system), 'pt-BR', `${system} selects Brazilian Portuguese`);
assert.strictEqual(I18n.resolveLanguage('pt-BR', 'en-US'), 'pt-BR');
assert.strictEqual(I18n.resolveLanguage('', 'ptx'), 'en');
assert.strictEqual(I18n.savedLanguage('pt-br'), '', 'saved preferences are exact');

const catalogs = { en: { hello: 'Hello {name}', missing: 'English fallback', empty: 'English empty' }, 'zh-CN': { hello: '你好，{name}', empty: '' } };
const zh = I18n.create('zh-CN', catalogs);
assert.strictEqual(zh.t('hello', { name: '电脑 A' }), '你好，电脑 A');
assert.strictEqual(zh.t('missing'), 'English fallback');
assert.strictEqual(zh.t('empty'), 'English empty');
assert.strictEqual(zh.t('Untranslated text'), 'Untranslated text');
assert.strictEqual(zh.t('hello'), '你好，{name}');
assert.strictEqual(zh.t('hello', { name: '$& {name} <script>' }), '你好，$& {name} <script>');
assert.strictEqual(zh.t('{value}', { value: 0 }), '0');
assert.strictEqual(zh.t('{constructor}'), '{constructor}');
assert.strictEqual(zh.t('toString'), 'toString');
assert.strictEqual(I18n.create('en', catalogs).t('hello', { name: 'PC' }), 'Hello PC');
assert.strictEqual(I18n.create('unknown', catalogs).locale, 'en');

for (const settings of [normalize({}), mesh.normalize({})]) {
  assert.strictEqual(settings.ui.language, '', 'a new profile follows the system language');
}
for (const model of [{ normalize, apply }, mesh]) {
  const settings = model.normalize({ ui: { language: 'zh-CN' } });
  assert.strictEqual(settings.ui.language, 'zh-CN');
  model.apply(settings, 'ui', { tab: 'general' });
  assert.strictEqual(settings.ui.language, 'zh-CN', 'unrelated UI changes preserve the preference');
  assert.strictEqual(model.normalize({ ui: { language: 'xx' } }).ui.language, '');
  assert.strictEqual(model.normalize({ ui: { language: { toString: () => 'zh-CN' } } }).ui.language, '');
}

const en = require('../lang/en.js');
assert.ok(Object.keys(en).length > 50, 'the first pages have real translations');
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();
for (const locale of I18n.LANGUAGES.filter((l) => l !== 'en')) {
  const catalog = require(`../lang/${locale}.js`);
  assert.deepStrictEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${locale} has exactly the English keys`);
  for (const [key, text] of Object.entries(en)) {
    assert.ok(typeof catalog[key] === 'string' && catalog[key].trim(), `${locale} translation for ${key}`);
    assert.deepStrictEqual(placeholders(catalog[key]), placeholders(text), `${locale} placeholders for ${key}`);
  }
}

const browser = vm.createContext({});
for (const name of [...I18n.LANGUAGES.map((l) => `lang/${l}.js`), 'i18n.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), browser);
}
for (const locale of I18n.LANGUAGES.filter((l) => l !== 'en')) {
  assert.strictEqual(browser.TwinDeskI18n.create(locale).t('General'), I18n.create(locale).t('General'), `${locale} loads in a browser`);
  assert.notStrictEqual(I18n.create(locale).t('General'), 'General', `${locale} translates General`);
}
assert.strictEqual(I18n.create('pt-BR').t('Connected to {name}', { name: 'PC {me} $&' }), 'Conectado a PC {me} $&');

// A translated sentence may already contain literal braces supplied by a device or clipboard.
const kitWindow = { MacShareProtocol: require('../protocol.js') };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../windows/ui-kit.js'), 'utf8'), {
  window: kitWindow, I18n: I18n.create('zh-CN'),
  document: { createElement: () => ({ dataset: {}, append() {}, setAttribute() {}, classList: { add() {} } }) },
});
kitWindow.UI.state = { device: { name: 'Local' }, peer: { name: 'Peer', os: 'win' } };
const literal = kitWindow.UI.row('Work {me}', 'literal {name}', [], { literal: true });
assert.strictEqual(literal.label.textContent, 'Work {me}');
assert.strictEqual(literal.hint.textContent, 'literal {name}');
assert.strictEqual(literal.label.dataset.peer, undefined);
literal.setHint('C:\\{me}\\Downloads');
assert.strictEqual(literal.hint.textContent, 'C:\\{me}\\Downloads');
const note = kitWindow.UI.note('warn', 'Work {me}', { literal: true });
assert.strictEqual(note.textContent, 'Work {me}');
note.set('Problem with {name} $&');
assert.strictEqual(note.textContent, 'Problem with {name} $&');
assert.strictEqual(kitWindow.UI.monitorLabel('Built-in screen, 1920 × 1080 (main)'), '内置屏幕, 1920 × 1080（主屏幕）');
assert.strictEqual(kitWindow.UI.monitorLabel('Monitor 2, 2560 × 1440'), '显示器 2, 2560 × 1440');
assert.strictEqual(kitWindow.UI.monitorLabel('Dell $& {name}, 1920 × 1080 (main)'), 'Dell $& {name}, 1920 × 1080（主屏幕）');
console.log(`i18n: language selection, fallback, interpolation, settings and ${Object.keys(en).length} catalog entries passed`);
