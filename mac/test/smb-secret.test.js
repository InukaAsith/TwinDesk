// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/smb.js: the share's password is decrypted asynchronously, once, never on a session's start. The
// synchronous decrypt waited for the keychain's prompt on the main thread (a new build asks again):
// a session starting froze the whole Mac app until someone answered, and an update never came back.
// Run: node mac/test/smb-secret.test.js
'use strict';

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

let asyncCalls = 0;
let answer = null; // resolves the keychain's "prompt"
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') {
    return {
      shell: {},
      safeStorage: {
        decryptString: () => { throw new Error('the synchronous decrypt blocks the main thread'); },
        decryptStringAsync: () => { asyncCalls++; return new Promise((r) => { answer = () => r({ result: 'pw-123', shouldReEncrypt: false }); }); },
        encryptString: (s) => Buffer.from('enc:' + s),
      },
    };
  }
  return load.call(this, id, ...args);
};
const { Smb } = require('../smb.js');
Module._load = load;

(async () => {
  const server = new EventEmitter();
  server.current = { name: 'nitro' };
  server.sent = [];
  server.sendToClient = (m) => server.sent.push(m);
  const settings = { smb: { sharing: true, folder: '/tmp/x', secret: Buffer.from('sealed').toString('base64'), connectPc: false } };
  const smb = new Smb({ server, helper: { on() {}, request: async () => ({}) }, getSettings: () => settings, saveSettings: () => {} });

  // A session starts: nothing blocks; the offer waits for the keychain.
  server.emit('client', { name: 'nitro' });
  server.emit('client', { name: 'nitro' });
  assert.strictEqual(server.sent.length, 0, 'not sent before the password is known');
  assert.strictEqual(smb.password(), '', 'the Web page gets nothing yet, and nothing blocks');
  assert.strictEqual(asyncCalls, 1, 'decrypted once, however many ask');
  answer();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(server.sent.map((m) => m.password), ['pw-123', 'pw-123'], 'both offers go once it is known');
  assert.strictEqual(smb.password(), 'pw-123');
  server.emit('client', { name: 'nitro' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(asyncCalls, 1, 'kept in memory');
  assert.strictEqual(server.sent.length, 3);
  console.log('smb-secret: ok');
})().catch((e) => { console.error(e); process.exit(1); });
