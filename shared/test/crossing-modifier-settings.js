// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const store = require('../../mac/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-crossing-modifier-'));
try {
  store.init(dir);
  const settings = store.loadSettings();
  assert.equal(settings.kvm.crossingModifier, '', 'automatic crossing remains the default');
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }],
  });
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return { screen, ipcMain: { handle() {}, on() {} } };
    return load.call(this, name, ...args);
  };
  const { Kvm } = require('../../mac/kvm');
  const { setupIpc } = require('../../mac/ipc');
  const server = Object.assign(new EventEmitter(), {
    current: { deviceId: 'peer', name: 'Peer', os: 'mac' }, sent: [], sendToClient(msg) { this.sent.push(msg); },
  });
  const helper = Object.assign(new EventEmitter(), {
    commands: [], send(cmd, args) { this.commands.push({ cmd, args }); }, request(cmd, args) { this.commands.push({ cmd, args }); return Promise.resolve({}); },
  });
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false });
  const drop = { dragIn: { onDriven() {}, cancel() {} }, cancelDrag() {} };
  const kvm = new Kvm({ server, helper, getSettings: () => settings, clipboard: { sendIfChanged() {} }, input: { releaseAll() {} }, drop, fileSend });
  const actions = setupIpc({ settings, pushState() {}, state: { connect: {} }, server, kvm });
  actions.setKvm({ crossingModifier: 'Command' });
  assert.equal(store.loadSettings().kvm.crossingModifier, 'Command', 'the selected modifier survives a restart');
  assert.equal(helper.commands.filter((command) => command.cmd === 'kvmConfig').at(-1).args.crossingModifier, 'Command',
    'the selected modifier reaches the native input helper');
  actions.setKvm({ crossingModifier: 'invalid' });
  assert.equal(store.loadSettings().kvm.crossingModifier, '', 'an invalid choice restores the default');
  settings.kvm.crossingModifier = 'invalid';
  store.saveSettings(settings);
  assert.equal(store.loadSettings().kvm.crossingModifier, '', 'invalid saved settings cannot block crossing');
  actions.setKvm({ crossingModifier: 'Command' });
  server.emit('t:kvm.take', { route: 1, mouse: true, keyboard: true });
  assert.equal(helper.commands.filter((command) => command.cmd === 'armReturn').at(-1).args.requireModifier, false,
    'an older peer cannot trap the pointer at the return edge');
  server.emit('t:kvm.take', { route: 2, mouse: true, keyboard: false, crossingModifierV1: true });
  assert.equal(helper.commands.filter((command) => command.cmd === 'armReturn').at(-1).args.requireModifier, true,
    'a compatible peer can gate the return even with keyboard sharing disabled');
  server.emit('t:k.mod', { t: 'k.mod', flags: 1 });
  assert.deepEqual(helper.commands.filter((command) => command.cmd === 'crossingFlags').at(-1)?.args, { flags: 1 },
    'the physical modifier state reaches the return edge independently of injected keys');
  server.emit('t:k.mod', { t: 'k.mod', flags: 0 });
  assert.deepEqual(helper.commands.filter((command) => command.cmd === 'crossingFlags').at(-1)?.args, { flags: 0 },
    'releasing the physical modifier also updates the return edge');
  server.emit('t:kvm.release', { route: 2 });
  actions.setKvm({ mouse: true });
  helper.emit('event', 'edge', { offset: 0.5, crossingFlags: 1 });
  const take = server.sent.filter((msg) => msg.t === 'kvm.take').at(-1);
  assert.equal(take.crossingFlags, 1, 'a key held before crossing is included in the handover');
  assert.equal(take.crossingModifierV1, true);
  server.emit('t:kvm.accept', { route: take.route });
  assert.equal(helper.commands.filter((command) => command.cmd === 'crossingWatch').length, 0,
    'the sender does not send new modifier events to older peers');
  server.emit('t:kvm.accept', { route: take.route, crossingModifierV1: true });
  assert.equal(helper.commands.filter((command) => command.cmd === 'crossingWatch').length, 1,
    'a compatible peer starts tracking physical keys, including the existing hotkey');
  helper.emit('event', 'ev', { ev: { t: 'k.mod', flags: 1 } });
  assert.deepEqual(server.sent.filter((msg) => msg.t === 'k.mod').at(-1), { t: 'k.mod', flags: 1 },
    'modifier state is sent separately from normal keys');
  kvm.goHome('');
  clearInterval(kvm.ticker);
  Module._load = load;
  console.log('crossing modifier settings: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
