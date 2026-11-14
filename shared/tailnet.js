// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tailscale (#161): reaching a paired computer away from its network, e.g. a phone on mobile data.
// Each computer tells the device that dials it its own Tailscale addresses (welcome.tail); the device
// keeps them with the computer and, when local discovery doesn't see that computer, every other
// attempt dials one of them instead of the last address. Only when this device is on Tailscale
// itself (it has an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48), and only with
// settings.net.tailscale on (on by default: without Tailscale nothing here ever runs a dial).
// Nothing else changes: same port, same pinned certificate and token as on the local network.
'use strict';
const os = require('os');

const MAX = 2; // addresses kept per computer
let enabled = () => true; // General › Tailscale (main.js: use)
function use(fn) { if (typeof fn === 'function') enabled = fn; }

function isTailnet(a) {
  if (typeof a !== 'string') return false;
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m) return +m[1] >= 64 && +m[1] <= 127 && +m[2] <= 255 && +m[3] <= 255;
  return /^fd7a:115c:a1e0:/i.test(a);
}

// This device's Tailscale addresses (IPv4 first); read again after a few seconds at most.
let cached = null, cachedAt = 0;
function mine() {
  if (cached && Date.now() - cachedAt < 5000) return cached;
  cachedAt = Date.now();
  return (cached = read());
}
function read() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (!n.internal && isTailnet(n.address) && !out.includes(n.address)) out.push(n.address);
    }
  } catch {}
  return out.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))).slice(0, MAX);
}

// welcome.tail from the other side: Tailscale addresses only, at most MAX.
function clean(list) {
  return Array.isArray(list) ? [...new Set(list.filter(isTailnet))].slice(0, MAX) : [];
}

const same = (a, b) => (a || []).join(',') === (b || []).join(',');

// The address for this attempt. seen: discovery found it (always wins). tail: its stored Tailscale
// addresses. attempt: the reconnect count (odd ones go through Tailscale). on: the setting.
function pick({ address, seen, tail, attempt, on = enabled(), here = mine }) {
  if (seen || !on) return address;
  const t = clean(tail).filter((a) => !a.includes(':'))[0] || clean(tail)[0];
  if (!t || t === address || attempt % 2 === 0 || !here().length) return address;
  return t;
}

module.exports = { isTailnet, mine, clean, same, pick, use, MAX };
