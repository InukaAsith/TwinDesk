// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The host side of going to sleep (every computer). Going to sleep (powerMonitor 'suspend') ends the
// session with `asleep` (server.sleep): legacy phone guests stop reconnecting on their own. Until a real wake
// ('resume') sessions are refused: a sleeping Mac wakes for a few seconds now and then (Power Nap,
// network upkeep), and a guest let in then only went silent again, reconnecting every ~20 s. Waking
// lets them in again and invites eligible former guests when discovery sees them on the network.
'use strict';

const INVITE_FOR_MS = 60000; // after waking: look for it this long
const INVITE_EVERY_MS = 2000; // … inviting it each time it's seen (UDP may drop one) until it's back

// server() / discovery(): ours (either may not exist yet); powerMonitor: Electron's.
function sleepWake({ powerMonitor, server, discovery, canInvite = () => true }) {
  let guests = []; // the device ids connected when we went to sleep
  let timer = null;
  powerMonitor.on('suspend', () => {
    clearInterval(timer);
    const s = server();
    const ids = s && s.sleep(true);
    const ended = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (ended.length) guests = ended;
    console.log(`[sleep] going to sleep${ended.length ? ': the session ends (asleep)' : ''}`);
  });
  powerMonitor.on('resume', () => {
    const s = server();
    if (s) s.sleep(false);
    let waiting = guests;
    guests = [];
    console.log('[sleep] awake');
    if (!waiting.length) return;
    const wokeAt = Date.now();
    const until = wokeAt + INVITE_FOR_MS;
    clearInterval(timer);
    timer = setInterval(() => {
      const host = server();
      // A session that sleep ended can still be here while its socket closes: that one doesn't count.
      const live = (ctx) => !!ctx && ctx.ws.readyState === ctx.ws.OPEN;
      // One session at a time: an invite makes a computer take the session over, so once anyone
      // holds it nobody is invited. Multi-device: only the guests that aren't back yet.
      if (host && !host.clients) waiting = live(host.current) ? [] : waiting;
      else waiting = waiting.filter((id) => !live(host?.clients?.get(id)));
      if (!waiting.length || Date.now() > until) return clearInterval(timer);
      const disc = discovery();
      for (const id of waiting) {
        const d = disc?.get(id);
        if (d && d.address && !String(d.address).startsWith('ble:') && canInvite(d, wokeAt)) disc.invite(d.address);
      }
    }, INVITE_EVERY_MS);
  });
}

module.exports = { sleepWake };
