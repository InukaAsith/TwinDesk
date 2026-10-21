// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The host side of going to sleep (every computer). Going to sleep (powerMonitor 'suspend') ends the
// session with `asleep` (server.sleep): the guest stops reconnecting on its own. Until a real wake
// ('resume') sessions are refused: a sleeping Mac wakes for a few seconds now and then (Power Nap,
// network upkeep), and a guest let in then only went silent again, reconnecting every ~20 s. Waking
// lets them in again and invites the device that was connected back, as soon as discovery sees it
// on the network (its address may have changed while we slept).
'use strict';

const INVITE_FOR_MS = 60000; // after waking: look for it this long
const INVITE_EVERY_MS = 2000; // … inviting it each time it's seen (UDP may drop one) until it's back

// server() / discovery(): ours (either may not exist yet); powerMonitor: Electron's.
function sleepWake({ powerMonitor, server, discovery }) {
  let guest = ''; // the device id that was connected when we went to sleep
  let timer = null;
  powerMonitor.on('suspend', () => {
    clearInterval(timer);
    const s = server();
    const id = s ? s.sleep(true) : '';
    if (id) guest = id;
    console.log(`[sleep] going to sleep${id ? ': the session ends (asleep)' : ''}`);
  });
  powerMonitor.on('resume', () => {
    const s = server();
    if (s) s.sleep(false);
    const id = guest;
    guest = '';
    console.log('[sleep] awake');
    if (!id) return;
    const until = Date.now() + INVITE_FOR_MS;
    clearInterval(timer);
    timer = setInterval(() => {
      const d = discovery() && discovery().get(id);
      if ((s && s.current) || Date.now() > until) return clearInterval(timer);
      if (d && d.address && !String(d.address).startsWith('ble:')) discovery().invite(d.address);
    }, INVITE_EVERY_MS);
  });
}

module.exports = { sleepWake };
