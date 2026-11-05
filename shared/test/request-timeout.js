// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Regression (#143, "the 323rd second"): Node's http/https servers end any request that takes longer
// than server.requestTimeout (300 s by default, checked every 30 s) to arrive, body included, even
// while its bytes still flow. A big file PUT to us (a phone's, a guest's fx2 ranges) died 300–330 s
// in. Every server that takes uploads turns that cap off; IDLE_MS (no bytes for 30 s) catches stalls.
// Run with: node shared/test/request-timeout.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { FastFiles } = require('../fastfile.js');
const { Engine } = require('../fx2-engine.js');

const root = path.join(__dirname, '..', '..');
const until = async (cond, what, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

(async () => {
  // What the bug was: with the default cap (scaled down here), an upload still sending is cut off.
  {
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end()); });
    srv.headersTimeout = 200;
    srv.requestTimeout = 400;
    srv.connectionsCheckingInterval = 100;
    let closedEarly = false;
    srv.on('request', (req) => req.on('close', () => { if (!req.complete) closedEarly = true; }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const req = http.request({ port: srv.address().port, method: 'PUT', headers: { 'content-length': 1e9 } });
    req.on('error', () => {});
    const iv = setInterval(() => req.write(Buffer.alloc(16 * 1024)), 10);
    await until(() => closedEarly, 'the capped server cutting off a live upload');
    clearInterval(iv);
    req.destroy();
    srv.close();
  }

  // The files engine (fx2): its HTTPS and plain servers.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqt-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const tls = { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
    const e = new Engine(() => {});
    e.handle({ op: 'listen', tls });
    e.handle({ op: 'plain', on: true });
    await until(() => e.server && e.plainPort, 'the engine listening');
    assert.strictEqual(e.server.requestTimeout, 0, 'fx2 HTTPS server: no whole-request cap');
    assert.strictEqual(e.plainServer.requestTimeout, 0, 'fx2 plain server: no whole-request cap');
    e.server.close();
    e.plainServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // fx's plain server (Encrypt file transfers off).
  {
    const ff = new FastFiles({ session: () => null, deliver() {}, send() {} });
    ff.setPlain(true);
    await until(() => ff.plainPort, 'the fx plain server listening');
    assert.strictEqual(ff.plainServer.requestTimeout, 0, 'fx plain server: no whole-request cap');
    ff.setPlain(false);
  }

  // The session servers (fx PUTs, the WebSocket) and the other servers that take uploads.
  const files = ['windows/server.js', 'windows/mesh/server.js', 'mac/server.js', 'mac/mesh/server.js', 'linux/server.js', 'linux/mesh/server.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(/this\.https = https\.createServer\(this\.tls\);\n\s*this\.https\.requestTimeout = 0;/.test(src), `${f}: no whole-request cap`);
  }
  for (const f of ['shared/foldershare.js', 'shared/rzlive.js', 'shared/phonedrive.js', 'shared/fastfile.js', 'shared/fx2-engine.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const made = (src.match(/\b(?:https?)\.createServer\(/g) || []).length;
    const off = (src.match(/\.requestTimeout = 0;/g) || []).length;
    assert.strictEqual(off, made, `${f}: every server it makes has no whole-request cap (${off}/${made})`);
  }

  console.log('request-timeout: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
