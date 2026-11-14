// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A window reads English (the fallback) and the language it was opened in (?language=), not every
// catalog: each is about 200 KB to parse. Written in while the page parses, so it runs before the
// page's own scripts. Changing the language restarts TwinDesk, so a window never needs another.
(function () {
  'use strict';
  var language = new URLSearchParams(location.search).get('language');
  if (['zh-CN', 'ru', 'tr', 'pt-BR'].indexOf(language) < 0) return;
  var src = document.currentScript.src.replace(/pick\.js([?#].*)?$/, language + '.js');
  document.write('<script src="' + src + '"></' + 'script>');
})();
