// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Whether a session on the local network goes through this computer's Wi-Fi or a cable (#140):
// the interface on the other device's subnet, and what kind it is. Overview and the sidebar say
// "Ethernet" for a cable (UI.via, state.net.lan), "Wi-Fi" otherwise, as before.
//   Linux:   /sys/class/net/<dev>/wireless is there for Wi-Fi.
//   Mac:     networksetup -listallhardwareports names each device's port (Wi-Fi, Ethernet,
//            Thunderbolt Ethernet, USB 10/100/1000 LAN…), read once and every few minutes after.
//   Windows: the adapter's own name (Wi-Fi, WLAN, Ethernet 2…), as os.networkInterfaces gives it.
'use strict';

const os = require('os');
const fs = require('fs');

const v4 = (a) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(a || '').replace(/^::ffff:/, ''));
  return m ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : null;
};

// The name of the local interface on the same subnet as `address` ('' none: Bluetooth, a route).
function ifaceFor(address, ifaces = os.networkInterfaces()) {
  const peer = v4(address);
  if (peer == null) return '';
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal) continue;
      const a = v4(i.address), m = v4(i.netmask);
      if (a == null || m == null || !m) continue;
      if (((a & m) >>> 0) === ((peer & m) >>> 0)) return name;
    }
  }
  return '';
}

// Mac: device -> hardware port name, from networksetup (async; '' until it's read).
let macPorts = null, macAt = 0;
function readMacPorts() {
  if (macAt && Date.now() - macAt < 5 * 60000) return;
  macAt = Date.now();
  require('child_process').execFile('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 5000 }, (err, out) => {
    if (err) return;
    const map = {};
    let port = '';
    for (const line of String(out).split('\n')) {
      const p = /^Hardware Port:\s*(.+)$/.exec(line);
      if (p) port = p[1].trim();
      const d = /^Device:\s*(\S+)/.exec(line);
      if (d && port) map[d[1]] = port;
    }
    macPorts = map;
  });
}

// What an interface is: 'Wi-Fi', 'Ethernet', or '' (not known).
function kindOf(name, platform = process.platform) {
  if (!name) return '';
  if (platform === 'linux') {
    try { return fs.existsSync(`/sys/class/net/${name}/wireless`) ? 'Wi-Fi' : /^(en|eth|em|eno|ens|enp|usb)/.test(name) ? 'Ethernet' : ''; } catch { return ''; }
  }
  if (platform === 'darwin') {
    readMacPorts();
    const port = macPorts && macPorts[name];
    if (!port) return '';
    return /wi-?fi|airport/i.test(port) ? 'Wi-Fi' : /ethernet|lan|thunderbolt/i.test(port) && !/bridge/i.test(port) ? 'Ethernet' : '';
  }
  return /wi-?fi|wlan|wireless/i.test(name) ? 'Wi-Fi' : /ethernet|^lan\b|local area connection/i.test(name) ? 'Ethernet' : '';
}

// The session's link to `address`: 'Wi-Fi', 'Ethernet' or ''. Kept 10 s (the state is built often).
let last = { address: null, at: 0, kind: '' };
function lanType(address) {
  const now = Date.now();
  if (address === last.address && now - last.at < 10000) return last.kind;
  let kind = '';
  try { kind = kindOf(ifaceFor(address)); } catch { kind = ''; }
  last = { address, at: now, kind };
  return kind;
}

module.exports = { lanType, ifaceFor, kindOf, v4 };
