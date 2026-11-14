// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Removing saved portals must remain possible when displays are disconnected.
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { ipcMain: { handle() {}, on() {} } };
  if (name === './store') return { saveSettings() {} };
  return load.call(this, name, ...args);
};
const { setupIpc } = require('../../mac/ipc');
Module._load = load;

const target = { display: '3', side: 'bottom', from: 0, to: 1 };
const rule = (id, display) => ({ id, source: { display, side: 'left', from: 0, to: 1 }, target, modifiers: ['Command'], key: '' });
const saved = [rule('first', '1'), rule('second', '2')];
const settings = { kvm: { portalsByPeer: { peer: saved } } };
const server = Object.assign(new EventEmitter(), { current: { deviceId: 'peer' } });
const kvm = { mode: 'home', map: { mine: [], theirs: [] }, config() {} };
const actions = setupIpc({ settings, server, kvm, state: { connect: {} }, pushState() {} });

actions.setPortals([saved[1]]);
assert.deepEqual(settings.kvm.portalsByPeer.peer, [saved[1]], 'one unavailable portal can be removed while another remains');
actions.setPortals([saved[1], rule('new', '9')]);
assert.deepEqual(settings.kvm.portalsByPeer.peer, [saved[1]], 'a new unavailable portal cannot be added');
actions.setPortals([]);
assert.deepEqual(settings.kvm.portalsByPeer.peer, [], 'the last unavailable portal can be removed');
console.log('cursor portals: removing unavailable displays passed');
