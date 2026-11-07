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

// Whether an interface is a USB-C link straight to the other device (TwinDesk Web, #web): a phone or
// tablet sharing its connection through the cable (iPhone USB, Android USB tethering over RNDIS/NCM)
// or a Thunderbolt/USB4 bridge. A USB Ethernet adapter is not one: that's a cable to a network.
//   Mac:     the hardware port (iPhone USB, iPad USB, the phone's own name for Android, Thunderbolt Bridge).
//   Linux:   the driver (ipheth, rndis_host, cdc_ncm, thunderbolt-net) or usb0/rndis0.
//   Windows: the adapter's description (Apple Mobile Device Ethernet, Remote NDIS, UsbNcm), read once.
// An iPhone's Personal Hotspot over the cable also always hands out 172.20.10.x on a wired port.
const PHONE_PORT = /iphone|ipad|android|rndis|\bncm\b|pixel|galaxy|samsung|xiaomi|redmi|oneplus|motorola|huawei|honor|oppo|vivo|realme|nothing|sony|xperia|thunderbolt bridge/i;
const USB_DESC = /apple mobile device|remote ndis|rndis|usbncm|ncm|android|thunderbolt.*network/i;
let winDesc = null, winAt = 0;
function readWinDesc() {
  if (winAt && Date.now() - winAt < 60000) return;
  winAt = Date.now();
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetAdapter | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress'], { timeout: 8000, windowsHide: true }, (err, out) => {
    if (err) return;
    try {
      const j = JSON.parse(String(out));
      const map = {};
      for (const a of Array.isArray(j) ? j : [j]) if (a && a.Name) map[a.Name] = String(a.InterfaceDescription || '');
      winDesc = map;
    } catch (_) {}
  });
}
function isUsbLink(name, address = '', platform = process.platform) {
  if (!name) return false;
  if (platform === 'darwin') {
    readMacPorts();
    const port = (macPorts && macPorts[name]) || '';
    if (/wi-?fi|airport/i.test(port)) return false;
    if (PHONE_PORT.test(port)) return true;
    return /^172\.20\.10\./.test(address) && /^en\d/.test(name);
  }
  if (platform === 'linux') {
    if (/^(usb|rndis)\d/.test(name)) return true;
    try {
      if (fs.existsSync(`/sys/class/net/${name}/wireless`)) return false;
      const drv = require('path').basename(fs.readlinkSync(`/sys/class/net/${name}/device/driver`));
      if (/^(ipheth|rndis_host|cdc_ncm|cdc_ether|thunderbolt[-_]net)$/.test(drv)) return true;
    } catch (_) {}
    return /^172\.20\.10\./.test(address);
  }
  if (/wi-?fi|wlan|wireless/i.test(name)) return false;
  readWinDesc();
  if (winDesc && USB_DESC.test(winDesc[name] || '')) return true;
  return /^172\.20\.10\./.test(address);
}

// A new interface came up (a cable plugged in): read the port names again on the next ask.
function refreshPorts() { macAt = 0; winAt = 0; if (process.platform === 'darwin') readMacPorts(); else if (process.platform === 'win32') readWinDesc(); }

module.exports = { lanType, ifaceFor, kindOf, isUsbLink, refreshPorts, v4 };
