// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const I18n = TwinDeskI18n.create(new URLSearchParams(window.location.search).get('language'));
window.I18n = I18n;
document.documentElement.lang = I18n.locale;
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = I18n.t(element.dataset.i18n || element.textContent);
}
for (const [attribute, marker] of [['aria-label', 'data-i18n-label'], ['title', 'data-i18n-title'], ['placeholder', 'data-i18n-placeholder']]) {
  for (const element of document.querySelectorAll('[' + marker + ']')) {
    element.setAttribute(attribute, I18n.t(element.getAttribute(marker)));
  }
}
