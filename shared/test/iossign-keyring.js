// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk iPhone on Linux (shared/iossign-host.js): asking safeStorage anything opens the login
// keyring, an unlock prompt when it's locked. Nothing may ask it at start or while the feature is
// off; only once it's on (and Keep a copy wants the vault).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

Object.defineProperty(process, 'platform', { value: 'linux' });
const host = require('../iossign-host.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-iossign-'));
let asked = 0;
const safeStorage = {
  isEncryptionAvailable: () => { asked++; return true; },
  getSelectedStorageBackend: () => { asked++; return 'gnome_libsecret'; },
  encryptString: (s) => { asked++; return Buffer.from(s); },
  decryptString: (b) => { asked++; return b.toString(); },
};
const link = { on() {}, send() {}, current: null };
const app = { getPath: () => dir };

const sign = host.create({ app, safeStorage, link, near: null, usbSerials: () => [], onChange: () => {} });
const off = sign.view;
assert.strictEqual(asked, 0, 'starting with the feature off asks the keyring nothing');
assert.strictEqual(off.on, false);
sign.view; sign.view;
assert.strictEqual(asked, 0, 'the window showing its state asks nothing either');

// On: now the vault may be asked about (that's when Keep a copy is used).
fs.writeFileSync(path.join(dir, 'ios-signing.json'), JSON.stringify({ on: true }));
const on = host.create({ app, safeStorage, link, near: null, usbSerials: () => [], onChange: () => {} });
assert.strictEqual(asked, 0, 'creating it asks nothing even when on');
assert.strictEqual(on.view.canKeep, true, 'on, with a real keyring: Keep a copy is possible');
assert.ok(asked > 0, 'and only then the keyring was asked');

fs.rmSync(dir, { recursive: true, force: true });
console.log('iossign-keyring: ok');
