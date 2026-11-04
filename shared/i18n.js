// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// English source messages are keys; untranslated pages and platforms keep their English text.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      en: require('./lang/en.js'), 'zh-CN': require('./lang/zh-CN.js'),
      ru: require('./lang/ru.js'), tr: require('./lang/tr.js'),
    });
  } else {
    root.TwinDeskI18n = factory(root.TwinDeskLanguages || {});
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bundled) {
  'use strict';
  const LANGUAGES = ['en', 'zh-CN', 'ru', 'tr'];
  const own = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  const savedLanguage = (value) => LANGUAGES.includes(value) ? value : '';

  function resolveLanguage(preference, systemLanguage) {
    if (savedLanguage(preference)) return preference;
    const system = typeof systemLanguage === 'string' ? systemLanguage.replace(/_/g, '-').toLowerCase() : '';
    if (/^(zh|zh-cn|zh-sg|zh-hans(?:-[a-z]+)?)$/.test(system)) return 'zh-CN';
    if (/^ru(-|$)/.test(system)) return 'ru';
    if (/^tr(-|$)/.test(system)) return 'tr';
    return 'en';
  }

  function create(language, catalogs = bundled) {
    const locale = savedLanguage(language) || 'en';
    const messages = catalogs[locale] || {};
    const english = catalogs.en || {};
    const textAt = (dict, key) => own(dict, key) && typeof dict[key] === 'string' && dict[key] ? dict[key] : '';
    return {
      locale,
      t(key, vars) {
        const text = textAt(messages, key) || textAt(english, key) || key;
        // A single pass preserves literal dollars, markup and braces in names or paths.
        return String(text).replace(/\{(\w+)\}/g, (match, name) => own(vars, name) ? String(vars[name]) : match);
      },
    };
  }

  return { LANGUAGES, savedLanguage, resolveLanguage, create };
});
