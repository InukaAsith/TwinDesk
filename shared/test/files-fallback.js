// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// #143: fx2 failing before a byte went makes the next files go the fx way for a minute, not for the
// whole session, and says so (onFallback, with why); a files engine that restarts takes its port again
// so the other side's port still works (or any port when that one is taken).
// Run with: node shared/test/files-fallback.js
'use strict';

const assert = require('assert');
const net = require('net');
const { FastFiles } = require('../fastfile.js');
const { Engine } = require('../fx2-engine.js');

(async () => {
  // broken2: a minute, then fx2 again; the reason kept for Engines in use.
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const ff = new FastFiles({ session: () => null, deliver() {}, send() {} });
    const said = [];
    ff.onFallback = (o) => said.push(o);
    assert.equal(ff.broken2, false);
    ff.broken2 = true;
    ff.why2 = 'connect ECONNREFUSED';
    ff._fellBack('fx2', 'fx', ff.why2);
    assert.equal(ff.broken2, true);
    assert.deepEqual(said, [{ from: 'fx2', to: 'fx', why: 'connect ECONNREFUSED' }]);
    clock += 59_000;
    assert.equal(ff.broken2, true, 'still the fx way within the minute');
    clock += 2_000;
    assert.equal(ff.broken2, false, 'fx2 is tried again after a minute');
    ff.broken2 = true;
    ff.broken2 = false;
    assert.equal(ff.why2, '', 'a new session forgets why');
    ff.onFallback = () => { throw new Error('the app’s'); };
    ff._fellBack('fx', 'file.chunk', 'x'); // an app's error doesn't break the transfer code
  } finally {
    Date.now = realNow;
  }

  // The engine listens on the port it had before, when it's free; else on any.
  const tls = (() => {
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fb-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
  })();
  const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const portOf = (want) => new Promise((res) => {
    const e = new Engine((m) => { if (m.ev === 'port') res({ port: m.port, e }); });
    e.handle({ op: 'listen', tls, port: want });
  });
  const want = await freePort();
  const a = await portOf(want);
  assert.equal(a.port, want, 'the port it had');
  const b = await portOf(want); // taken by a
  assert.ok(b.port > 0 && b.port !== want, 'taken: any port');
  for (const x of [a, b]) x.e.server.close();
  console.log('files-fallback: ok');
})().catch((e) => { console.error(e); process.exit(1); });
