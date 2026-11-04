// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/lantype.js (#140): the interface on the other device's subnet, and its kind.
// Run with: node shared/test/lantype.js
'use strict';

const assert = require('assert');
const { ifaceFor, kindOf } = require('../lantype.js');

const ifs = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  enp3s0: [{ family: 'IPv4', address: '192.168.1.5', netmask: '255.255.255.0', internal: false }],
  wlan0: [{ family: 'IPv4', address: '10.0.0.7', netmask: '255.255.0.0', internal: false }],
};
assert.strictEqual(ifaceFor('192.168.1.200', ifs), 'enp3s0');
assert.strictEqual(ifaceFor('::ffff:10.0.4.4', ifs), 'wlan0');
assert.strictEqual(ifaceFor('8.8.8.8', ifs), ''); // routed, not on a subnet here
assert.strictEqual(ifaceFor('ble:aa:bb', ifs), ''); // Bluetooth
assert.strictEqual(kindOf('Ethernet 2', 'win32'), 'Ethernet');
assert.strictEqual(kindOf('Wi-Fi', 'win32'), 'Wi-Fi');
assert.strictEqual(kindOf('WLAN', 'win32'), 'Wi-Fi');
assert.strictEqual(kindOf('vEthernet (WSL)', 'win32'), 'Ethernet');
assert.strictEqual(kindOf('', 'win32'), '');
console.log('lantype: ok');
