// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The main process resolves the system/saved preference before loading this window.
'use strict';
const I18n = TwinDeskI18n.create(new URLSearchParams(window.location.search).get('language'));
window.I18n = I18n;
document.documentElement.lang = I18n.locale;
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = I18n.t(element.dataset.i18n || element.textContent);
}
for (const element of document.querySelectorAll('[data-i18n-label]')) {
  element.setAttribute('aria-label', I18n.t(element.dataset.i18nLabel));
}
for (const element of document.querySelectorAll('[data-i18n-title]')) {
  element.title = I18n.t(element.dataset.i18nTitle);
}
