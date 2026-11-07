// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's certificates, kept in <userData>/web: the local authority (made once; the phone
// trusts it once, from the profile the page offers) and the server certificate it signs for this
// computer's .local name and its current addresses. The server certificate is made again when an
// address it doesn't name shows up, or a month before it runs out; the authority stays, so a phone
// that trusts it never has to do anything again.
//
// load(dir, host) → {ca: {keyPem, certPem}, leaf: {keyPem, certPem}, fresh: bool}
// mobileconfig(certPem, name) → the iOS profile (a .mobileconfig) that installs the authority.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeCa, makeLeaf, derOf } = require('./x509.js');
const { ipv4s } = require('./mdnshost.js');

const RENEW_MS = 30 * 24 * 3600 * 1000;

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function write(file, text, secret) {
  fs.writeFileSync(file, text, secret ? { mode: 0o600 } : undefined);
}

function load(dir, host) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let caKey = read(f('ca.key'));
  let caCert = read(f('ca.pem'));
  if (!caKey || !caCert) {
    const ca = makeCa({ cn: `TwinDesk on ${host.replace(/\.local$/, '')}` });
    write(f('ca.key'), ca.keyPem, true);
    write(f('ca.pem'), ca.certPem);
    caKey = ca.keyPem;
    caCert = ca.certPem;
  }
  const ca = { keyPem: caKey, certPem: caCert };
  const ips = ['127.0.0.1', ...ipv4s().map((i) => i.address)];
  const dns = [host]; // only names the authority may sign for (x509.js constraints): no 'localhost'
  let leafKey = read(f('server.key'));
  let leafCert = read(f('server.pem'));
  let fresh = false;
  const covers = () => {
    try {
      const c = new crypto.X509Certificate(leafCert);
      if (!c.checkIssued(new crypto.X509Certificate(caCert))) return false;
      if (Date.parse(c.validTo) - Date.now() < RENEW_MS) return false;
      const san = c.subjectAltName || '';
      return dns.every((d) => san.includes(`DNS:${d}`)) && ips.every((ip) => san.includes(`IP Address:${ip}`));
    } catch (_) {
      return false;
    }
  };
  if (!leafKey || !leafCert || !covers()) {
    // Keep the addresses it named before as well: a phone may still come back on one of them.
    let old = [];
    try { old = ((new crypto.X509Certificate(leafCert).subjectAltName || '').match(/IP Address:[\d.]+/g) || []).map((s) => s.slice(11)); } catch (_) {}
    const all = [...new Set([...ips, ...old])].slice(-24);
    const leaf = makeLeaf({ ca, cn: host, dns, ips: all });
    write(f('server.key'), leaf.keyPem, true);
    write(f('server.pem'), leaf.certPem);
    leafKey = leaf.keyPem;
    leafCert = leaf.certPem;
    fresh = true;
  }
  return { ca, leaf: { keyPem: leafKey, certPem: leafCert }, fresh };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A configuration profile with the authority in it (com.apple.security.root). Installed in Settings,
// then turned on in General › About › Certificate Trust Settings.
function mobileconfig(certPem, name) {
  const der = derOf(certPem).toString('base64');
  const fp = crypto.createHash('sha256').update(certPem).digest('hex');
  const uuid = (seed) => {
    const h = crypto.createHash('sha256').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>twindesk.cer</string>
      <key>PayloadContent</key><data>${der}</data>
      <key>PayloadDescription</key><string>Lets this device open TwinDesk on ${xml(name)} securely.</string>
      <key>PayloadDisplayName</key><string>TwinDesk on ${xml(name)}</string>
      <key>PayloadIdentifier</key><string>app.twindesk.web.ca.${fp.slice(0, 12)}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid('cert' + fp)}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>TwinDesk's certificate for ${xml(name)}. It is only good for names ending in .local and addresses on home networks.</string>
  <key>PayloadDisplayName</key><string>TwinDesk on ${xml(name)}</string>
  <key>PayloadIdentifier</key><string>app.twindesk.web.${fp.slice(0, 12)}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile' + fp)}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

module.exports = { load, mobileconfig };
