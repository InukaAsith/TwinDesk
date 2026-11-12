// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for windows/identity.js: DPAPI-backed passphrase storage and legacy migration.
// Run with: node --test windows/test/identity.test.js
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let available = true;
let decryptFails = false;
let encryptCalls = 0;
let decryptCalls = 0;
const MAGIC = Buffer.from([0x01, 0x00, 0x00, 0x00]);

const mockSafeStorage = {
  isEncryptionAvailable: () => available,
  encryptString: (str) => {
    encryptCalls++;
    return Buffer.concat([MAGIC, Buffer.from(str, 'utf8')]);
  },
  decryptString: (buf) => {
    decryptCalls++;
    if (decryptFails) throw new Error('Decryption failed');
    if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length || !buf.subarray(0, 4).equals(MAGIC)) {
      throw new Error('Not encrypted with safeStorage');
    }
    return buf.subarray(4).toString('utf8');
  }
};

let tempDir;
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') {
    return {
      app: { getPath: () => tempDir },
      safeStorage: mockSafeStorage
    };
  }
  return load.call(this, id, ...args);
};
const { readPass, writePass } = require('../identity');
Module._load = load;

function fixture(t) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-identity-'));
  const passFile = path.join(tempDir, 'identity.pass');
  available = true;
  decryptFails = false;
  encryptCalls = 0;
  decryptCalls = 0;
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { dir: tempDir, passFile };
}

test('DPAPI encryption and decryption: writePass seals data and readPass decrypts it', (t) => {
  const f = fixture(t);
  const pass = '0123456789abcdef0123456789abcdef0123456789abcdef';

  writePass(f.passFile, pass);
  assert.equal(encryptCalls, 1);

  const rawDisk = fs.readFileSync(f.passFile);
  assert.ok(Buffer.isBuffer(rawDisk));
  assert.ok(rawDisk.subarray(0, 4).equals(MAGIC), 'file on disk should contain DPAPI/safeStorage header');
  assert.notEqual(rawDisk.toString('utf8'), pass, 'file on disk must not be plain text');

  const decrypted = readPass(f.passFile);
  assert.equal(decryptCalls, 1);
  assert.equal(decrypted, pass);
});

test('DPAPI readPass trims whitespace and trailing newlines from decrypted passphrase', (t) => {
  const f = fixture(t);
  const pass = '0123456789abcdef0123456789abcdef0123456789abcdef';

  // Simulate an encrypted passphrase saved with surrounding whitespace/newline
  fs.writeFileSync(f.passFile, Buffer.concat([MAGIC, Buffer.from(`  ${pass}\r\n`, 'utf8')]));

  const decrypted = readPass(f.passFile);
  assert.equal(decrypted, pass);
});

test('legacy plaintext migration: 48-char hex plaintext is read and re-sealed with DPAPI', (t) => {
  const f = fixture(t);
  const legacyPass = 'fedcba9876543210fedcba9876543210fedcba9876543210';

  // Write plain text file as older TwinDesk versions did
  fs.writeFileSync(f.passFile, legacyPass, 'utf8');

  // readPass should attempt decrypt, fail, catch, verify 48-hex, re-seal, and return the passphrase
  const result = readPass(f.passFile);
  assert.equal(result, legacyPass);
  assert.equal(encryptCalls, 1, 'writePass should have re-sealed the passphrase');

  // Verify the file on disk is now encrypted
  const onDisk = fs.readFileSync(f.passFile);
  assert.ok(onDisk.subarray(0, 4).equals(MAGIC), 'file on disk should now be encrypted');
  assert.equal(mockSafeStorage.decryptString(onDisk), legacyPass);

  // Subsequent read should decrypt directly without throwing
  encryptCalls = 0;
  const subsequent = readPass(f.passFile);
  assert.equal(subsequent, legacyPass);
  assert.equal(encryptCalls, 0, 'subsequent read should not re-write or re-seal');
});

test('legacy plaintext migration: trims newlines before re-sealing', (t) => {
  const f = fixture(t);
  const legacyPass = 'aabbccddeeff00112233445566778899aabbccddeeff0011';

  fs.writeFileSync(f.passFile, `${legacyPass}\r\n`, 'utf8');

  const result = readPass(f.passFile);
  assert.equal(result, legacyPass);
  assert.equal(encryptCalls, 1);

  // Disk now holds the sealed trimmed passphrase
  const onDisk = fs.readFileSync(f.passFile);
  assert.equal(mockSafeStorage.decryptString(onDisk), legacyPass);
});

test('safeStorage unavailable fallback: writes and reads plaintext when encryption is disabled', (t) => {
  const f = fixture(t);
  available = false;
  const pass = '0123456789abcdef0123456789abcdef0123456789abcdef';

  writePass(f.passFile, pass);
  assert.equal(encryptCalls, 0, 'encryptString must not be called when encryption is unavailable');

  const rawDisk = fs.readFileSync(f.passFile, 'utf8');
  assert.equal(rawDisk, pass, 'file should be plain text on disk');

  const readResult = readPass(f.passFile);
  assert.equal(decryptCalls, 0, 'decryptString must not be called when encryption is unavailable');
  assert.equal(readResult, pass);
});

test('safeStorage unavailable fallback: trims newlines from plaintext', (t) => {
  const f = fixture(t);
  available = false;
  const pass = '0123456789abcdef0123456789abcdef0123456789abcdef';

  fs.writeFileSync(f.passFile, `  ${pass}\n`, 'utf8');

  const readResult = readPass(f.passFile);
  assert.equal(readResult, pass);
});

test('handling invalid encrypted data safely: unreadable sealed data is never overwritten', (t) => {
  const f = fixture(t);
  const pass = '0123456789abcdef0123456789abcdef0123456789abcdef';

  // Write a valid encrypted file
  writePass(f.passFile, pass);
  const originalBytes = fs.readFileSync(f.passFile);
  encryptCalls = 0;

  // Simulate safeStorage failing to decrypt (e.g. key unavailable or another user)
  decryptFails = true;

  const result = readPass(f.passFile);
  assert.equal(encryptCalls, 0, 'writePass must never be called on unreadable sealed data');

  const currentBytes = fs.readFileSync(f.passFile);
  assert.ok(currentBytes.equals(originalBytes), 'file on disk must remain unchanged to prevent data loss');
});

test('handling invalid encrypted data safely: corrupted non-hex content is not re-sealed', (t) => {
  const f = fixture(t);
  // An invalid payload that is not 48 hex characters
  const invalidContent = 'not-a-valid-48-hex-passphrase';
  fs.writeFileSync(f.passFile, invalidContent, 'utf8');

  const result = readPass(f.passFile);
  assert.equal(result, invalidContent);
  assert.equal(encryptCalls, 0, 'non-hex content must not be sealed over disk');

  const onDisk = fs.readFileSync(f.passFile, 'utf8');
  assert.equal(onDisk, invalidContent, 'disk content should remain as it was');
});

test('handling invalid encrypted data safely: random binary data is never overwritten', (t) => {
  const f = fixture(t);
  const corruptedBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(f.passFile, corruptedBinary);

  readPass(f.passFile);
  assert.equal(encryptCalls, 0, 'writePass must not be called');

  const onDisk = fs.readFileSync(f.passFile);
  assert.ok(onDisk.equals(corruptedBinary), 'binary data on disk must remain intact');
});
