// Throwaway TLS certificate for the tests: made once per test process with openssl into a temp
// folder, which is deleted when the process exits. No key material is kept in the repository.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../../../shared/protocol.js');

let cached = null;

// Returns {pfx: Buffer, passphrase, fp} (fp: normalized sha256 fingerprint).
function loadTestCert() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-test-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const pfx = path.join(dir, 't.pfx');
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=Test'], { env, stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-out', pfx, '-inkey', key, '-in', cert, '-passout', 'pass:x'], { env, stdio: 'ignore' });
  const fp = P.normFingerprint(new crypto.X509Certificate(fs.readFileSync(cert, 'utf8')).fingerprint256);
  cached = { pfx: fs.readFileSync(pfx), passphrase: 'x', fp };
  return cached;
}

module.exports = { loadTestCert };
