// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A page script of another edition, loaded only in that edition (shared/edition.js):
//   <script src="../shared/edload.js" data-src="../shared/fullkvm/ui-fullkvm.js"></script>
// The Full KVM build's own preload gives window.tdFullKvm; the normal build has neither the preload
// nor the script, and this does nothing. document.write keeps the scripts' order (as modload.js).
'use strict';

(function () {
  const me = document.currentScript;
  const src = me && me.dataset.src;
  if (!src || !window.tdFullKvm) return;
  document.write(`<script src="${src.replace(/[^\w./-]/g, '')}"></` + 'script>');
})();
