// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's language, before web/app.js runs: the one chosen in General (kept in this browser),
// else the browser's own (Simplified Chinese, Russian, Turkish, any Portuguese; the rest English), as
// the apps decide. Only that catalog is written in; English needs none.
(function () {
  'use strict';
  var KNOWN = ['zh-CN', 'ru', 'tr', 'pt-BR'];
  var lang = '';
  try { lang = localStorage.getItem('twindesk.web.lang') || ''; } catch (_) {}
  if (lang !== 'en' && KNOWN.indexOf(lang) < 0) {
    var b = String((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
    lang = /^zh/.test(b) ? (/hant|-tw$|-hk$|-mo$/.test(b) ? 'en' : 'zh-CN') : /^ru/.test(b) ? 'ru' : /^tr/.test(b) ? 'tr' : /^pt/.test(b) ? 'pt-BR' : 'en';
  }
  if (KNOWN.indexOf(lang) < 0) return;
  document.write('<script src="/lang/' + lang + '.js"></' + 'script>');
})();
