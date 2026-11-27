// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/lanaddrs.js (#287): the computer's LAN addresses a phone on Bluetooth may dial: private IPv4 of
// real adapters only.
'use strict';
const assert = require('assert');
const { mine, isPrivate } = require('../lanaddrs.js');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });
assert.deepStrictEqual(mine({
  lo: [v4('127.0.0.1', true)],
  'Wi-Fi': [v4('192.168.100.15'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  'vEthernet (WSL (Hyper-V firewall))': [v4('172.30.80.1')],
  docker0: [v4('172.17.0.1')],
  Tailscale: [v4('100.127.208.104')],
  eth0: [v4('10.15.49.221'), v4('169.254.10.2')],
}), ['192.168.100.15', '10.15.49.221'], 'real adapters, private, no link-local, no virtual ones');
assert.ok(isPrivate('172.16.0.1') && isPrivate('172.31.255.1') && !isPrivate('172.32.0.1') && !isPrivate('8.8.8.8'));
assert.strictEqual(mine({ a: [v4('10.0.0.1'), v4('10.0.0.2'), v4('10.0.0.3'), v4('10.0.0.4')] }).length, 3, 'at most 3');
assert.ok(Array.isArray(mine()), 'this computer: never throws');
console.log('lanaddrs: ok');
