// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Keep the display awake (#240), as the Mac has had: while another computer is connected,
// this one's display doesn't turn off and it doesn't go to sleep (Electron's powerSaveBlocker
// 'prevent-display-sleep'), so the screen you cross to is there. Let go as soon as nothing is
// connected, the switch is off or the app quits. want() is looked at every few seconds and on
// update(); outside Electron's main process (tests) it does nothing.
'use strict';

const LOOK_MS = 4000;

function keepAwake(want, psb) {
  if (psb === undefined) {
    try { psb = require('electron').powerSaveBlocker || null; } catch (_) { psb = null; }
  }
  let id = null;
  const update = () => {
    let on = false;
    try { on = !!want(); } catch (_) { /* not ready yet */ }
    if (!psb) return;
    if (on && id === null) id = psb.start('prevent-display-sleep');
    else if (!on && id !== null) { psb.stop(id); id = null; }
  };
  const timer = setInterval(update, LOOK_MS);
  if (timer.unref) timer.unref();
  update();
  return {
    update,
    get on() { return id !== null; },
    stop() { clearInterval(timer); if (psb && id !== null) psb.stop(id); id = null; },
  };
}

module.exports = { keepAwake };
