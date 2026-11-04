// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's host identity (PC ↔ PC): a self-signed TLS certificate made once by
// PowerShell (New-SelfSignedCertificate, exported to userData\identity.pfx with a random
// passphrase kept next to it, then removed from the certificate store) and its fingerprint.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const P = require('../shared/protocol.js');
const { script } = require('./ps');

const dir = () => path.join(app.getPath('userData'), 'identity');

async function makePfx(pfx, pass) {
  fs.mkdirSync(path.dirname(pfx), { recursive: true });
  await script('identity-make', { Pfx: pfx, Pass: pass }, 60000);
}

// The certificate (DER) inside a PKCS#12 file, for its fingerprint. Node can't read PKCS#12, so
// a short-lived TLS context hands it back.
function certOf(pfx, passphrase) {
  const tls = require('tls');
  const sock = new tls.TLSSocket(null, { secureContext: tls.createSecureContext({ pfx, passphrase }) });
  const der = sock.getCertificate() && sock.getCertificate().raw;
  sock.destroy();
  return der;
}

// The passphrase on disk: DPAPI-sealed (safeStorage) so a local process running as this user
// can't just read it; plain text only where sealing isn't available.
function writePass(passFile, pass) {
  fs.writeFileSync(passFile, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(pass) : pass);
}

function readPass(passFile) {
  const raw = fs.readFileSync(passFile);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw).trim();
    } catch {
      // Plain text: an older version wrote it (24 random bytes as hex). Seal it going forward. Never
      // a sealed one that didn't open: writing it back as "plain text" would lose the passphrase.
      const pass = raw.toString('utf8').trim();
      if (/^[0-9a-f]{48}$/.test(pass)) writePass(passFile, pass);
      return pass;
    }
  }
  return raw.toString('utf8').trim();
}

// Returns {pfx, passphrase, fp}; makes the certificate the first time.
async function load() {
  const pfxFile = path.join(dir(), 'identity.pfx');
  const passFile = path.join(dir(), 'identity.pass');
  if (!fs.existsSync(pfxFile) || !fs.existsSync(passFile)) {
    const pass = crypto.randomBytes(24).toString('hex');
    await makePfx(pfxFile, pass);
    writePass(passFile, pass);
  }
  const pfx = fs.readFileSync(pfxFile);
  const passphrase = readPass(passFile);
  const der = certOf(pfx, passphrase);
  if (!der) throw new Error('could not read the certificate');
  const fp = P.normFingerprint(new crypto.X509Certificate(der).fingerprint256);
  return { pfx, passphrase, fp };
}

module.exports = { load };
