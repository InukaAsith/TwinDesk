// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps › Move windows in Multi-device (#250, #251): the window goes to the device the pointer went
// to, and that device's "I take windows" (papp.policy) is known even when it was said while another
// device was selected.
// Moving works on the facade (the selected device): PcApps / AppSend hear papp.policy only from it,
// and forget it on every selection change. So each device's answer is kept here, off the bus, and a
// move first selects the device it goes to (the driven side's way home went to its own selection,
// or nowhere), then tells the facade's PcApps what that device said.
//   const mm = meshMoves(hub, T);
//   kvm.onMoveWindow = (m, to) => { if (!mm.ready(to, (v) => { pcApps.macAccepts = v; })) return; … }
'use strict';

function meshMoves(hub, T) {
  const accepts = new Map(); // device id -> its last papp.policy {accept}
  hub.bus.on(T.PAPP_POLICY, (m, from) => accepts.set(from, m.accept === true));
  hub.bus.onPeer('closed', (id) => accepts.delete(id));
  return {
    accepts: (id) => accepts.get(id) === true,
    // to: the device the pointer crossed to (null: the selected one). Selects it when it isn't,
    // then setAccepts(what it said). False: it isn't connected, nothing to move to.
    ready(to, setAccepts) {
      const id = to || hub.selectedId;
      if (!id) return false;
      if (id !== hub.selectedId && !hub.select(id)) return false;
      if (accepts.has(id)) setAccepts(accepts.get(id));
      return true;
    },
  };
}

module.exports = { meshMoves };
