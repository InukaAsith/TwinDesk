// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which pages belong to which kind of device (Mac, PC and Linux windows, both modes). Loaded right
// after the UI kit (ui-kit.js / control.js) and before the pages.
//   UI.deviceKind(s): the device in session: 'android', 'ios' (an iPhone or iPad) or 'computer'
//     (also with nothing connected: the computer pages are this computer's own settings then).
//   A page's `for: ['computer', 'android', 'ios']`: the kinds it is for (left out: every kind). Its
//     own hidden(s) still applies on top.
//   A page's `variantOf: 'overview'`: its kind's own version of that page. It takes the same place
//     in the sidebar (the shells' order and group, UI.baseOf) and the same introduction
//     (shared/feature-art.js). Asking for any page of a family (UI.pick) gives the one for the
//     device in session, so 'overview' from the tray, a popup, a saved tab or another page opens
//     an iPhone's own Overview while an iPhone is connected.
// TwinDesk Web devices have their own pages the same way (shared/ui-web.js, def.web).
'use strict';

(function () {
  UI.DEVICE_KINDS = ['computer', 'android', 'ios'];
  UI.deviceKind = (s) => (UI.isIphone && UI.isIphone(s) ? 'ios' : UI.isPhone && UI.isPhone(s) ? 'android' : 'computer');
  UI.baseOf = (def) => (def ? def.variantOf || def.id : '');

  const register = UI.tab;
  UI.tab = function (def) {
    if (Array.isArray(def.for)) {
      const own = def.hidden;
      def.hidden = (s) => !def.for.includes(UI.deviceKind(s)) || !!(own && own(s));
    }
    return register.call(UI, def);
  };

  // The page of id's family that is shown for s: id itself when it is, else a sibling that is.
  UI.pick = (id, s = UI.state) => {
    const def = UI.tabs.find((d) => d.id === id);
    if (!def || !s) return id;
    const base = UI.baseOf(def);
    const shown = (d) => !(d.hidden && d.hidden(s));
    if (shown(def)) return id;
    const sibling = UI.tabs.find((d) => d !== def && UI.baseOf(d) === base && shown(d));
    return sibling ? sibling.id : id;
  };
})();
