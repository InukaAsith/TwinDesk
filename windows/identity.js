// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's host identity (PC ↔ PC): a self-signed TLS certificate made once by
// PowerShell (New-SelfSignedCertificate, exported to userData\identity.pfx with a random
// passphrase kept next to it, then removed from the certificate store) and its fingerprint.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
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

// Returns {pfx, passphrase, fp}; makes the certificate the first time.
async function load() {
  const pfxFile = path.join(dir(), 'identity.pfx');
  const passFile = path.join(dir(), 'identity.pass');
  if (!fs.existsSync(pfxFile) || !fs.existsSync(passFile)) {
    const pass = crypto.randomBytes(24).toString('hex');
    await makePfx(pfxFile, pass);
    fs.writeFileSync(passFile, pass);
  }
  const pfx = fs.readFileSync(pfxFile);
  const passphrase = fs.readFileSync(passFile, 'utf8').trim();
  const der = certOf(pfx, passphrase);
  if (!der) throw new Error('could not read the certificate');
  const fp = P.normFingerprint(new crypto.X509Certificate(der).fingerprint256);
  return { pfx, passphrase, fp };
}

module.exports = { load };
