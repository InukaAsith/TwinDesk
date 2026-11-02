// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Player text updates are independent of the running media session.
(function () {
  'use strict';
  let current = window.TwinDeskI18n.create(new URLSearchParams(location.search).get('language'));
  const bindings = new Map();
  const listeners = new Set();
  const t = (key, vars) => current.t(key, vars);

  function translate(root = document) {
    const elements = [...(root.matches && root.matches('[data-i18n], [data-i18n-title], [data-i18n-label], [data-i18n-placeholder]') ? [root] : []), ...root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-label], [data-i18n-placeholder]')];
    for (const element of elements) {
      if (element.hasAttribute('data-i18n')) {
        const key = element.getAttribute('data-i18n') || element.textContent;
        element.setAttribute('data-i18n', key);
        element.textContent = t(key);
      }
      for (const [attribute, marker] of [['title', 'data-i18n-title'], ['aria-label', 'data-i18n-label'], ['placeholder', 'data-i18n-placeholder']]) {
        if (element.hasAttribute(marker)) element.setAttribute(attribute, t(element.getAttribute(marker)));
      }
    }
  }

  function text(element, key, vars) {
    element.removeAttribute('data-i18n');
    if (key) bindings.set(element, { key, vars });
    else bindings.delete(element);
    element.textContent = key ? t(key, vars) : '';
  }

  function literal(element, value) {
    element.removeAttribute('data-i18n');
    bindings.delete(element);
    element.textContent = value == null ? '' : String(value);
  }

  function change(language) {
    if (!window.TwinDeskI18n.savedLanguage(language) || language === current.locale) return;
    current = window.TwinDeskI18n.create(language);
    document.documentElement.lang = current.locale;
    translate();
    for (const [element, binding] of bindings) element.textContent = t(binding.key, binding.vars);
    for (const listener of listeners) listener();
  }

  window.PlayerI18n = { t, text, literal, translate, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, get locale() { return current.locale; } };
  document.documentElement.lang = current.locale;
  translate();
  if (window.playerLanguage) window.playerLanguage.onChange(change);
})();
