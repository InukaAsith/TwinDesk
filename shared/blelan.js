// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { isIPv4 } = require('net');
const os = require('os');
const P = require('./protocol.js');

const MAX_ADDRESSES = 4;
const CHECK_MS = 5000;

function localAddresses(interfaces) {
  const privateIps = new Set();
  const linkLocal = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const { family, internal, address } of entries || []) {
      if ((family !== 'IPv4' && family !== 4) || internal || !isIPv4(address)) continue;
      const [a, b, c] = address.split('.').map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) privateIps.add(address);
      else if (a === 169 && b === 254 && c >= 1 && c <= 254) linkLocal.add(address);
    }
  }
  return [...privateIps, ...linkLocal].slice(0, MAX_ADDRESSES);
}

// All desktop modes share BleHost. `client` follows welcome and the existing RTT events let us
// notice address changes while on Bluetooth without starting another timer.
function advertiseBleLan(server) {
  const sent = new WeakMap();
  const offer = (ctx, requested = false) => {
    const ws = ctx.ws;
    if (!ctx.authed || ctx.released || ctx.os !== P.OS.ANDROID || ctx.transport !== 'ble' ||
        ws?.transport !== 'ble' || ws.readyState !== ws.OPEN) return;
    if ((server.clients ? server.clients.get(ctx.deviceId) : server.current) !== ctx) return;
    const port = server.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;

    const last = sent.get(ctx);
    const at = Date.now();
    if (last?.ws === ws && at - (requested ? last.sentAt : last.checkedAt) < CHECK_MS) return;
    let addresses;
    try { addresses = localAddresses(os.networkInterfaces()); } catch { return; }
    const key = `${port}:${addresses.join(',')}`;
    const send = requested || last?.ws !== ws || last.key !== key;
    sent.set(ctx, { ws, key, checkedAt: at, sentAt: send ? at : last.sentAt });
    // Use the physical BLE socket. Cursor-over-Bluetooth can route ordinary sends elsewhere.
    if (send) ws.send(JSON.stringify({ t: P.T.NET_LAN, addresses, port }));
  };
  server.on('client', offer);
  server.on('rtt', offer);
  server.on('transport', (ctx) => { if (ctx.transport !== 'ble') sent.delete(ctx); });
  server.on('closed', (ctx) => sent.delete(ctx));
  // Android may still be on IP when we first fall back to Bluetooth and send the offer again.
  server.on('message', (msg, ctx, ws) => {
    if (msg.t === P.T.NET_LAN && msg.ask === true && ws === ctx.ws) offer(ctx, true);
  });
}

module.exports = { advertiseBleLan };
