// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One module page script, loaded only when a module it serves is on (shared/modules.js):
//   <script src="../shared/modload.js" data-src="ui-terminal.js"></script>
// in place of <script src="ui-terminal.js">. document.write keeps the scripts' order: the page
// script runs right here, before the parser goes on (a script added with createElement would run
// after ui-start.js / app.js).
'use strict';

(function () {
  const me = document.currentScript;
  const src = me && me.dataset.src;
  if (!src || !window.TdModules) return;
  if (!TdModules.scriptOn(TdModules.off || [], src)) {
    TdModules.skipped.push(...(TdModules.SCRIPTS[src.split('/').pop()] || [])); // General › Modules still lists them
    return;
  }
  document.write(`<script src="${src.replace(/[^\w./-]/g, '')}"></` + 'script>');
})();
