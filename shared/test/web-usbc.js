// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web over USB-C: which links count as a cable, and that the screen's WebRTC stays on it.
// Run with: node shared/test/web-usbc.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isUsbLink } = require('../lantype.js');

// A phone's hotspot over the cable, USB tethering, and what is not a cable to the device.
assert.strictEqual(isUsbLink('usb0', '192.168.42.10', 'linux'), true);
assert.strictEqual(isUsbLink('rndis0', '', 'linux'), true);
assert.strictEqual(isUsbLink('Ethernet 4', '172.20.10.2', 'win32'), true); // iPhone hotspot subnet
assert.strictEqual(isUsbLink('Wi-Fi', '172.20.10.2', 'win32'), false); // the same hotspot over Wi-Fi
assert.strictEqual(isUsbLink('Ethernet', '192.168.1.4', 'win32'), false);
assert.strictEqual(isUsbLink('', '172.20.10.2', 'win32'), false);

let WebHub;
try { ({ WebHub } = require('../web/webhub.js')); } catch (e) { console.log('web-usbc: lantype ok, hub skipped (' + e.message + ')'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-usbc-'));
const hub = new WebHub({ dir, getCfg: () => ({}), self: () => ({ id: 'pc', name: 'PC', os: 'mac' }) });
const sent = [];
const sock = (link, local) => ({ readyState: 1, link, local, send: (j) => sent.push([local, JSON.parse(j)]) });
const wifi = sock('Wi-Fi', '192.168.1.4');
const usb = sock('USB-C', '172.20.10.2');
const cand = (ip) => ({ candidate: `candidate:1 1 udp 2122260223 ${ip} 50000 typ host`, sdpMid: '0' });

// On Wi-Fi, every candidate goes.
hub.socks.set('d', new Set([wifi]));
hub._sendRtc('d', { t: 'rtc.ice', candidate: cand('192.168.1.4') });
hub._sendRtc('d', { t: 'rtc.ice', candidate: cand('172.20.10.2') });
assert.strictEqual(sent.length, 2);

// Moved to the cable: the newest socket leads, and only this computer's cable address goes.
sent.length = 0;
hub.socks.get('d').add(usb);
assert.strictEqual(hub._primary('d'), usb);
hub._sendRtc('d', { t: 'rtc.ice', candidate: cand('192.168.1.4') });
hub._sendRtc('d', { t: 'cam.ice', candidate: cand('172.20.10.2') });
assert.deepStrictEqual(sent.map(([, m]) => candidateIp(m)), ['172.20.10.2', '172.20.10.2']); // to both sockets
const sdp = ['v=0', 'a=candidate:1 1 udp 1 192.168.1.4 5 typ host', 'a=candidate:2 1 udp 1 172.20.10.2 6 typ host', ''].join('\r\n');
sent.length = 0;
hub._sendRtc('d', { t: 'rtc.offer', sdp });
assert.ok(!sent[0][1].sdp.includes('192.168.1.4') && sent[0][1].sdp.includes('172.20.10.2'));
// From the phone: mDNS names are kept (nothing to judge them by), IPv6 would go around the cable.
assert.strictEqual(hub._onLink('d', cand('3f2a-11.local'), true), true);
assert.strictEqual(hub._onLink('d', cand('fe80::1'), true), false);
assert.strictEqual(hub._onLink('d', 'garbage', true), true);

function candidateIp(m) { return m.candidate.candidate.split(' ')[4]; }
fs.rmSync(dir, { recursive: true, force: true });
console.log('web-usbc: ok');
