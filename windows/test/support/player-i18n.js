// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// For renderer tests run in a vm: window.PlayerI18n (shared/player-i18n.js) in English, without a
// page: t() fills {vars}, text()/literal() set an element's text, translate() and onChange() do nothing.
'use strict';

const fill = (key, vars = {}) => String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

module.exports = {
  t: fill,
  text(el, key, vars) { if (el) el.textContent = fill(key, vars); },
  literal(el, value) { if (el) el.textContent = String(value == null ? '' : value); },
  translate() {},
  onChange() { return () => {}; },
  locale: 'en',
};
