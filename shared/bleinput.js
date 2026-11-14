// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor › Mouse and keyboard over Bluetooth (#158, settings.net.bleInput, off by default): for
// crowded Wi-Fi where the pointer stutters, the pointer and keys ride the session's Bluetooth socket
// while everything else (screens, files, clipboard) stays on Wi-Fi.
//   - The Bluetooth link stays up beside the Wi-Fi: General's Turn off Bluetooth on Wi-Fi connections
//     stands aside (main.js), and the computer that dials connects through Bluetooth first when the
//     other one is near, then moves to Wi-Fi (link.js), which keeps that socket as the session's other one.
//   - With both sockets open, cursor-sharing messages (k.*, kvm.*) go on the Bluetooth one, the rest on
//     the Wi-Fi one (server.js send, link.js send), and the input lane (UDP) is left alone (peer.js lane),
//     so moves, clicks, keys and crossings keep one order on one path.
//   - Either socket gone: everything on the one left, as without this.
// Both computers need it on. Loaded only while it's on (peer.js useBleInput), so nobody else runs it.
'use strict';

const OPEN = 1; // WebSocket.OPEN
const isInput = (t) => typeof t === 'string' && (t.startsWith('k.') || t.startsWith('kvm.'));

// The session's Bluetooth socket while it also has a network one, both open; else null.
function bleOf(a, b) {
  const ble = a && a.transport === 'ble' ? a : b && b.transport === 'ble' ? b : null;
  const ip = ble === a ? b : a;
  return ble && ip && ble.readyState === OPEN && ip.readyState === OPEN && ip.transport !== 'ble' ? ble : null;
}

// The socket for one message: input on Bluetooth, the rest on the network one.
function route(primary, alt, msg) {
  const ble = bleOf(primary, alt);
  if (!ble) return primary;
  if (isInput(msg && msg.t)) return ble;
  return primary === ble ? alt : primary;
}

// Input goes through Bluetooth now (the input lane steps aside).
function ready(primary, alt) {
  return !!bleOf(primary, alt);
}

module.exports = { route, ready, isInput, bleOf };
