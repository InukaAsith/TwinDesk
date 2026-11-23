// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/peerlogs.js (docs/peer-logs.md): a device copies another's TwinDesk.log as it grows (only what's
// new, big ones in pieces, a rotation said), crash.log now and then, nothing with the switches off, and an
// older app that never answers is asked again only after a while.
// Run: node shared/test/peerlogs.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PeerLogs, CHUNK, INITIAL } = require('../peerlogs.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlogs-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// Two devices on a bus: what one sends, the other's handler for that type gets, with the sender's id.
function pair({ aShare = true, bCollect = true, aAnswers = true } = {}) {
  const dirs = { A: fs.mkdtempSync(path.join(root, 'A-')), B: fs.mkdtempSync(path.join(root, 'B-')) };
  const handlers = { A: {}, B: {} };
  let t = 0;
  const bus = (me, other) => ({
    on: (type, fn) => { handlers[me][type] = fn; },
    send: (to, m) => {
      if (me === 'B' && !aAnswers) return true; // an older app: it takes the message and says nothing
      const fn = handlers[to][m.t];
      if (fn) fn(JSON.parse(JSON.stringify(m)), me);
      return true;
    },
    connectedIds: () => [other],
  });
  const names = { A: 'Ryzen 9/x', B: 'nitro' };
  const mk = (me, other, o) => new PeerLogs({ bus: bus(me, other), nameOf: (id) => names[id], dir: () => dirs[me], now: () => t, log: () => {}, tickMs: 1e9, ...o }).start();
  const a = mk('A', 'B', { share: () => aShare, collect: () => false });
  const b = mk('B', 'A', { collect: () => bCollect });
  const copy = (f = 'TwinDesk.log') => {
    const p = path.join(dirs.B, 'peers', 'Ryzen_9_x-A', f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  return { a, b, dirs, copy, clock: (ms) => { t = ms; }, stop: () => { a.stop(); b.stop(); } };
}

const logOf = (x) => path.join(x.dirs.A, 'TwinDesk.log');

// The first copy, then only what's new; the folder is the name (made safe) and the id.
{
  const x = pair();
  fs.writeFileSync(logOf(x), 'one\ntwo\n');
  x.b.tick();
  assert.match(x.copy(), /copied from Ryzen 9\/x \(A\), its last 0 KB ----\none\ntwo\n$/);
  fs.appendFileSync(logOf(x), 'three\n');
  x.clock(40000);
  x.b.tick();
  assert.match(x.copy(), /one\ntwo\nthree\n$/);
  assert.strictEqual(x.copy().split('two').length, 2, 'nothing twice');
  x.stop();
}

// A log bigger than one piece comes in pieces in the same tick, with a multi-byte character across a
// piece's edge intact; the first copy is its last INITIAL bytes.
{
  const x = pair();
  const line = 'ñandú — ' + 'x'.repeat(91) + '\n'; // 100+ bytes, 3 of them outside ASCII
  let text = '';
  while (Buffer.byteLength(text) < INITIAL + 3 * CHUNK) text += line;
  fs.writeFileSync(logOf(x), text);
  x.b.tick();
  const got = x.copy().replace(/^\n---- .*----\n/, '');
  const want = Buffer.from(text).subarray(Buffer.byteLength(text) - INITIAL).toString('utf8');
  assert.strictEqual(got, want);
  assert.ok(!got.includes('�'), 'no broken character');
  x.stop();
}

// A rotated log (smaller than where we were): said in the copy, and copied from its new end.
{
  const x = pair();
  fs.writeFileSync(logOf(x), 'old old old old\n');
  x.b.tick();
  fs.writeFileSync(logOf(x), 'new\n');
  x.clock(40000);
  x.b.tick();
  assert.match(x.copy(), /old old old old\n\n---- .* its log was rotated or started again: from here on, its last 0 KB ----\nnew\n$/);
  x.stop();
}

// crash.log every 10th tick, the whole of it.
{
  const x = pair();
  fs.writeFileSync(logOf(x), 'a\n');
  fs.writeFileSync(path.join(x.dirs.A, 'crash.log'), 'boom\n');
  for (let i = 1; i <= 10; i++) { x.clock(i * 40000); x.b.tick(); }
  assert.strictEqual(x.copy('crash.log'), 'boom\n');
  x.stop();
}

// Its switch off: said once in the copy, nothing of the log.
{
  const x = pair({ aShare: false });
  fs.writeFileSync(logOf(x), 'secret\n');
  x.b.tick();
  x.clock(40000);
  x.b.tick();
  assert.strictEqual(x.copy().match(/isn’t shared/g).length, 1);
  assert.ok(!x.copy().includes('secret'));
  x.stop();
}

// Ours off: nothing asked, nothing written.
{
  const x = pair({ bCollect: false });
  fs.writeFileSync(logOf(x), 'a\n');
  x.b.tick();
  assert.strictEqual(x.copy(), null);
  x.stop();
}

// An older app: asked once, then again only after RETRY (2 min), not every tick.
{
  const x = pair({ aAnswers: false });
  let asks = 0;
  const send = x.b.bus.send;
  x.b.bus.send = (to, m) => { if (m.t === 'log.get') asks++; return send(to, m); };
  x.b.tick();
  x.clock(60000);
  x.b.tick();
  assert.strictEqual(asks, 1);
  x.clock(130000);
  x.b.tick();
  assert.strictEqual(asks, 2);
  x.stop();
}

// A request for any other file is TwinDesk.log; an offset past the end is its last INITIAL bytes.
{
  const x = pair();
  fs.writeFileSync(logOf(x), 'hello\n');
  let reply = null;
  x.b.bus.on('log.data', (m) => { reply = m; });
  x.b.bus.send('A', { t: 'log.get', req: 7, file: '../../etc/passwd', from: 99999 });
  assert.strictEqual(reply.req, 7);
  assert.strictEqual(reply.file, 'TwinDesk.log');
  assert.strictEqual(reply.from, 0);
  assert.strictEqual(Buffer.from(reply.data, 'base64').toString(), 'hello\n');
  x.stop();
}

console.log('peerlogs: all passed');
