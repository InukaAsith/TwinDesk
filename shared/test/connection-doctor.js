// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../ui-connection-doctor.js'), 'utf8');

function mount(platform) {
  const byLabel = new Map();
  let show;
  const UI = {
    el: (_tag, props, children) => ({ ...props, children }),
    row(label) {
      const row = { hint: '', hidden: false, setHint(hint) { this.hint = hint; } };
      byLabel.set(label, row);
      return row;
    },
    button(textContent, onClick) {
      show = { textContent, click: onClick, setAttribute() {} };
      return show;
    },
    card: (title, children) => ({ title, children }),
    onBle: s => s.net?.transport === 'ble',
    via: s => s.net.transport === 'ble' ? 'Bluetooth' : s.net.lan || 'Wi-Fi Direct',
  };
  vm.runInNewContext(script, { UI, window: { I18n: { t: (key, vars) => key.replace(/\{(\w+)\}/g, (m, k) => vars?.[k] ?? m) } } });
  return {
    card: UI.connectionDoctor(platform),
    hint: label => byLabel.get(label).hint,
    visible: label => !byLabel.get(label).hidden,
    toggle: () => show.click(),
  };
}

const peer = { id: 'phone', os: 'android', rttMs: 21 };
const stats = { width: 2560, height: 1440, fps: 30, mbps: 8 };
const phone = { connected: { ...peer, usb: true }, bridge: { state: 'ready' } };
const permissions = { screen: 'granted', accessibility: true };
const discovery = { on: true, localNetwork: true };
const link = { state: 'connected', rtt: 21 };
const pcScreen = { mode: 'mirror', status: 'live', sending: true, stats, deviceId: peer.id };

function showsObservedPlatformState() {
  const mac = mount('mac');
  mac.card.update({ client: peer, sharing: { on: true }, stream: { status: 'live', ...stats }, phone, permissions, discovery });
  assert.equal(mac.card.el.children[0].hidden, true, 'Doctor starts collapsed');
  mac.toggle();
  assert.match(mac.hint('Transport'), /USB cable.+21 ms/);
  assert.equal(mac.hint('Local Network'), 'Allowed');
  assert.equal(mac.hint('Screen Recording'), 'Allowed');
  assert.equal(mac.hint('Wireless debugging'), 'Ready');
  assert.equal(mac.hint('Screen sharing'), '2560 × 1440 · 30 fps · 8 Mb/s');
  mac.toggle();
  mac.card.update({ link: { state: 'reconnecting' } });
  assert.equal(mac.card.el.children[0].hidden, true, 'connection updates leave Doctor collapsed');
  mac.toggle();
  assert.equal(mac.hint('Screen sharing'), 'Not connected', 'reopening uses the latest state');


  const windows = mount('windows');
  windows.toggle();
  windows.card.update({ link, session: peer, mesh: {}, pcScreen, firewall: { ok: true }, net: { lan: 'Ethernet' } });
  assert.match(windows.hint('Transport'), /Ethernet.+21 ms/);
  assert.equal(windows.hint('Firewall'), 'Ready');
  assert.match(windows.hint('Screen sharing'), /2560 × 1440/);
  assert.equal(windows.visible('Wireless debugging'), false, 'unobserved ADB state stays hidden');

  const linux = mount('linux');
  linux.toggle();
  linux.card.update({ link, peerSession: peer, mesh: {}, pcScreen, firewall: { ok: false, tool: 'ufw' },
    session: { type: 'wayland', access: { uinput: false } }, net: { transport: 'ble' } });
  assert.match(linux.hint('Transport'), /Bluetooth.+21 ms/);
  assert.equal(linux.hint('Desktop session'), 'Wayland');
  assert.equal(linux.hint('Input'), 'Not allowed');
  assert.equal(linux.hint('Firewall'), 'Problem');
}

function refusesUnobservedAndUnselectedFacts() {
  const windows = mount('windows');
  windows.toggle();
  windows.card.update({ link, session: { id: 'other', os: 'win' }, mesh: {}, phone, pcScreen,
    firewall: { ok: true, unread: true } });
  assert.match(windows.hint('Transport'), /^IP/);
  assert.equal(windows.visible('Wireless debugging'), false);
  assert.equal(windows.hint('Screen sharing'), 'Unknown');
  assert.equal(windows.hint('Firewall'), 'Unknown');

  const mac = mount('mac');
  mac.toggle();
  mac.card.update({ client: peer, sharing: { on: true }, stream: { status: 'live', width: 1920, height: 1080 },
    permissions: { screen: 'denied', accessibility: false }, discovery: { on: false, localNetwork: false } });
  assert.equal(mac.hint('Screen Recording'), 'Not allowed');
  assert.equal(mac.hint('Discovery'), 'Off');
  assert.equal(mac.hint('Screen sharing'), 'Ready', 'requested size is not a measurement');
  mac.card.update({ client: peer, sharing: { on: true }, stream: { deviceId: 'other', status: 'live', ...stats } });
  assert.equal(mac.hint('Screen sharing'), 'Waiting for the picture…', 'another peer’s frames are excluded on direct links');
  mac.card.update({ client: peer, sharing: { on: false } });
  assert.equal(mac.hint('Screen sharing'), 'Off');
  mac.card.update({ sharing: { on: true }, stream: { status: 'live', ...stats } });
  assert.equal(mac.hint('Screen sharing'), 'Not connected');
}

showsObservedPlatformState();
refusesUnobservedAndUnselectedFacts();
console.log('connection doctor: observed desktop state and selected-peer scoping passed');
