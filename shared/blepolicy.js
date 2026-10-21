// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// When Bluetooth runs (every computer; the phone's Ble.kt / BleServe.kt the same): it's only for a
// device that can't be reached any other way.
//   look — advertising and scanning, to find a device or be found: only while there's no session at
//          all, and TwinDesk's window is open (not from the tray or the menu bar alone) or a session
//          ended a moment ago (RECONNECT_MS: a dropout, Wi-Fi Direct ending, comes back by itself).
//          Not in the first SETTLE_MS after a session ends: one that comes straight back over its
//          link needs none of it, and switching advertising and scanning on and off with each
//          dropout hung a Realtek controller (LE Set Extended Advertising Enable timed out, USB reset);
//   keep — the session's own Bluetooth link: only while the session runs through it;
//   hold — links already up stay a while after a session ends (RECONNECT_MS), so it comes back over them.
// Once the session is on Wi-Fi (the same network or Wi-Fi Direct) or a USB cable, Bluetooth closes,
// its fallback too once that path has proven itself (FALLBACK_MS of the session on it, answering:
// peer.dropFallback): a Mac's Bluetooth shares its radio with its 2.4 GHz Wi-Fi, and a link kept up
// beside the Wi-Fi starved it (seconds of silence, the session flipping back and forth).
'use strict';

const RECONNECT_MS = 2 * 60 * 1000; // after a session ends: Bluetooth looks this long, window or not
const SETTLE_MS = 8000; // … from this long after it ended
const FALLBACK_MS = 5000; // the session on Wi-Fi this long, answering: its Bluetooth fallback goes
const ANSWERING_MS = 3000; // … answering = something came through it this recently

// enabled() -> the Bluetooth switch (General); windowOpen() -> TwinDesk's window is showing;
// current() -> the session {transport: 'ble'|'ip', …} or null; ended: when the last session ended (ms).
function blePolicy({ enabled, windowOpen, current, ended = 0 }) {
  const on = !!enabled();
  const c = current();
  return {
    look: on && !c && Date.now() - ended >= SETTLE_MS && (!!windowOpen() || Date.now() - ended < RECONNECT_MS),
    keep: on && !!c && c.transport === 'ble',
    hold: on && !c && Date.now() - ended < RECONNECT_MS,
  };
}

// The fallback may go: the session has been on this path FALLBACK_MS and it answers.
function provenPath(movedAt, lastRx) {
  const now = Date.now();
  return now - (movedAt || 0) >= FALLBACK_MS && now - (lastRx || 0) < ANSWERING_MS;
}

// General's "Turn off Bluetooth on Wi-Fi connections" (on unless switched off), every computer: once
// the session has run FALLBACK_MS on the same Wi-Fi network as the other device, phone or computer,
// Bluetooth goes altogether here: no advertising (a phone can't find this computer meanwhile), no
// scanning, no links, the session's Bluetooth fallback closed with them. It comes back when the
// session ends. Not on Bluetooth, a USB cable (the session on 127.0.0.1 through adb), or a Wi-Fi
// Direct group or hotspot netlink.js made (onGroup): those keep Bluetooth as the way back.
// Returns check({on, current, onGroup}) -> true while Bluetooth stays off; called every few seconds.
function wifiQuiet() {
  let since = 0;
  return ({ on, current, onGroup }) => {
    const c = on ? current() : null;
    const wifi = !!c && c.transport !== 'ble' && !onGroup() && !/^(127\.|::1$|::ffff:127\.)/.test(String(c.address || ''));
    if (!wifi) {
      since = 0;
      return false;
    }
    if (!since) since = Date.now();
    return Date.now() - since >= FALLBACK_MS;
  };
}

module.exports = { blePolicy, provenPath, wifiQuiet, RECONNECT_MS, SETTLE_MS, FALLBACK_MS };
