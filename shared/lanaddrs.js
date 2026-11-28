// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's addresses on its local networks, told to the device that dials it (welcome.lan, with
// welcome.lanPort), so a phone that came through Bluetooth can move the session onto the Wi-Fi without
// finding the computer there first (#287: on a campus or office network that drops broadcasts, discovery
// never sees it, and the session stayed on Bluetooth's 1–3 Mb/s). IPv4 in the private ranges first, then
// usable link-local ones (169.254.1.0–169.254.254.255, RFC 3927: two devices on a network with no DHCP
// server, from PR #294), never Tailscale's (welcome.tail has those), and not the adapters of virtual
// machines, containers and VPNs (Hyper-V and WSL's vEthernet, docker, libvirt, VMware, VirtualBox): the
// phone would only dial them in vain.
'use strict';
const os = require('os');

const MAX = 3;
const VIRTUAL = /docker|^br-|^veth|vethernet|virbr|vmnet|virtualbox|vbox|tailscale|^zt|^utun|^tun|^tap|wsl|hyper-v/i;

function isPrivate(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a || ''));
  if (!m) return false;
  const [b1, b2] = [+m[1], +m[2]];
  return b1 === 10 || (b1 === 172 && b2 >= 16 && b2 <= 31) || (b1 === 192 && b2 === 168);
}

// 169.254.1.0 to 169.254.254.255: the first and last 256 are reserved (RFC 3927 2.1).
function isLinkLocal(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a || ''));
  if (!m) return false;
  return +m[1] === 169 && +m[2] === 254 && +m[3] >= 1 && +m[3] <= 254 && +m[4] <= 255;
}

// ifaces: os.networkInterfaces()'s shape (tests give their own).
function mine(ifaces = null) {
  const out = [];
  try {
    for (const [name, list] of Object.entries(ifaces || os.networkInterfaces())) {
      if (VIRTUAL.test(name)) continue;
      for (const n of list || []) {
        const v4 = n.family === 'IPv4' || n.family === 4;
        if (!n.internal && v4 && (isPrivate(n.address) || isLinkLocal(n.address)) && !out.includes(n.address)) out.push(n.address);
      }
    }
  } catch {}
  // Private addresses first: a link-local one only fills a place none of them takes.
  return [...out.filter(isPrivate), ...out.filter(isLinkLocal)].slice(0, MAX);
}

module.exports = { mine, isPrivate, isLinkLocal, MAX };
