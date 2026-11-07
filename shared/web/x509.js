// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The smallest X.509 writer TwinDesk Web needs, in plain Node (no openssl, no PowerShell), the same on
// the three computers: a local certificate authority (the one an iPhone trusts once) and the server
// certificate it signs (the names and addresses this computer is reached by). ECDSA P-256, SHA-256.
//
// makeCa({cn, days, constrain}) → {keyPem, certPem}
// makeLeaf({ca: {keyPem, certPem}, cn, dns: [names], ips: [addresses], days}) → {keyPem, certPem}
'use strict';

const crypto = require('crypto');

// ---- DER ----
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b) => tlv(0x04, b);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

function int(b) {
  if (typeof b === 'number') {
    const out = [];
    do { out.unshift(b & 0xff); b = Math.floor(b / 256); } while (b > 0);
    b = Buffer.from(out);
  }
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(s) {
  const p = s.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const stack = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
function time(d) {
  const z = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const rest = z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds()) + 'Z';
  return y < 2050 ? tlv(0x17, Buffer.from(z(y % 100) + rest)) : tlv(0x18, Buffer.from(z(y, 4) + rest));
}

const OID = {
  ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', ecdsaSha256: '1.2.840.10045.4.3.2',
  cn: '2.5.4.3', org: '2.5.4.10',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14', authorityKeyId: '2.5.29.35', nameConstraints: '2.5.29.30', serverAuth: '1.3.6.1.5.5.7.3.1',
};

const name = (cn) => seq(set(seq(oid(OID.org), utf8('TwinDesk'))), set(seq(oid(OID.cn), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
// keyUsage bits, as a BIT STRING with the unused bits counted (digitalSignature=0, keyCertSign=5, cRLSign=6).
function keyUsage(...bitsOn) {
  let v = 0;
  for (const b of bitsOn) v |= 0x80 >> b;
  let unused = 0;
  while (unused < 7 && !(v & (1 << unused))) unused++;
  return tlv(0x03, Buffer.from([unused, v]));
}

function ipBytes(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return Buffer.from(ip.split('.').map(Number));
  return null; // IPv6 left out: the page is reached by name or IPv4
}

// What the authority may sign for: names under .local and the private IPv4 ranges. A copy of its key
// could not be used to impersonate any site on the internet on the phone that trusts it.
function constraints() {
  const net = (a, m) => ctx(7, Buffer.concat([Buffer.from(a), Buffer.from(m)]), false);
  const sub = (g) => seq(g);
  return seq(ctx(0, Buffer.concat([
    sub(ctx(2, Buffer.from('local'), false)),
    sub(net([10, 0, 0, 0], [255, 0, 0, 0])),
    sub(net([172, 16, 0, 0], [255, 240, 0, 0])),
    sub(net([192, 168, 0, 0], [255, 255, 0, 0])),
    sub(net([169, 254, 0, 0], [255, 255, 0, 0])),
    sub(net([100, 64, 0, 0], [255, 192, 0, 0])), // carrier-grade NAT, some hotspots
    sub(net([127, 0, 0, 0], [255, 0, 0, 0])),
  ])));
}

function spki(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' });
}
// The raw EC point of a public key (the last bytes of its SubjectPublicKeyInfo), for key identifiers.
const keyId = (publicKey) => crypto.createHash('sha1').update(spki(publicKey).subarray(-65)).digest();

function sign(tbs, privateKey) {
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const pem = seq(tbs, seq(oid(OID.ecdsaSha256)), bits(sig)).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`;
}

function tbsOf({ serial, issuer, subject, days, publicKey, extensions }) {
  const from = new Date(Date.now() - 24 * 3600 * 1000); // a day back: a phone's clock a little behind
  const to = new Date(Date.now() + days * 24 * 3600 * 1000);
  return seq(
    ctx(0, int(2)), // v3
    int(serial),
    seq(oid(OID.ecdsaSha256)),
    issuer,
    seq(time(from), time(to)),
    subject,
    spki(publicKey),
    ctx(3, seq(...extensions)),
  );
}

const newKeys = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemKey = (k) => k.export({ type: 'pkcs8', format: 'pem' });

function makeCa({ cn = 'TwinDesk Local Authority', days = 3650, constrain = true } = {}) {
  const { publicKey, privateKey } = newKeys();
  const tbs = tbsOf({
    serial: crypto.randomBytes(16), issuer: name(cn), subject: name(cn), days, publicKey,
    extensions: [
      ext(OID.basicConstraints, true, seq(bool(true), int(0))),
      ext(OID.keyUsage, true, keyUsage(0, 5, 6)),
      ext(OID.subjectKeyId, false, octets(keyId(publicKey))),
      ...(constrain ? [ext(OID.nameConstraints, true, constraints())] : []),
    ],
  });
  return { keyPem: pemKey(privateKey), certPem: sign(tbs, privateKey) };
}

// Apple's rules for a server certificate: names in subjectAltName, serverAuth, at most 825 days.
function makeLeaf({ ca, cn, dns = [], ips = [], days = 800 }) {
  const caKey = crypto.createPrivateKey(ca.keyPem);
  const caCert = new crypto.X509Certificate(ca.certPem);
  const caPub = caCert.publicKey;
  const { publicKey, privateKey } = newKeys();
  const sans = [
    ...dns.map((d) => ctx(2, Buffer.from(d), false)),
    ...ips.map(ipBytes).filter(Boolean).map((b) => ctx(7, b, false)),
  ];
  // The issuer exactly as the authority's certificate has it as subject.
  const issuer = subjectDer(ca.certPem);
  const tbs = tbsOf({
    serial: crypto.randomBytes(16), issuer, subject: name(cn), days, publicKey,
    extensions: [
      ext(OID.basicConstraints, true, seq()),
      ext(OID.keyUsage, true, keyUsage(0)),
      ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      ext(OID.subjectAltName, false, seq(...sans)),
      ext(OID.subjectKeyId, false, octets(keyId(publicKey))),
      ext(OID.authorityKeyId, false, seq(ctx(0, keyId(caPub), false))),
    ],
  });
  return { keyPem: pemKey(privateKey), certPem: sign(tbs, caKey) };
}

// ---- reading one back: the subject Name's DER inside a certificate ----
function readTlv(b, i) {
  const tag = b[i];
  let l = b[i + 1];
  let h = 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    l = 0;
    for (let k = 0; k < n; k++) l = l * 256 + b[i + 2 + k];
    h += n;
  }
  return { tag, start: i, body: i + h, end: i + h + l };
}

function subjectDer(certPem) {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.body);
  let i = tbs.body;
  const fields = [];
  while (i < tbs.end) { const t = readTlv(der, i); fields.push(t); i = t.end; }
  // [0] version, serial, sigAlg, issuer, validity, subject
  const k = fields[0].tag === 0xa0 ? 1 : 0;
  const s = fields[k + 4];
  return der.subarray(s.start, s.end);
}

const derOf = (pem) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');

module.exports = { makeCa, makeLeaf, derOf };
