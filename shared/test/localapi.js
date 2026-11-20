// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/localapi.js: works with the key from its file; refuses no key, a wrong key, anything a
// browser sends, another Host, non-JSON; off removes the file and the port.
// Run with: node shared/test/localapi.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { LocalApi } = require('../localapi.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-api-'));
const file = path.join(dir, 'a.txt');
fs.writeFileSync(file, 'a');
const got = { sent: [], clip: [], tasks: [] };
const taskAlerts = {
  start: (b) => { got.tasks.push(['start', b]); return { code: 200, body: { ok: true, id: 'a'.repeat(32) } }; },
  cancel: (b) => { got.tasks.push(['cancel', b]); return { code: 200, body: { ok: true } }; },
  finish: (b) => { got.tasks.push(['finish', b]); return { code: 200, body: { ok: true } }; },
};
const api = new LocalApi({ dir, actions: { status: () => ({ connected: true, device: 'Studio' }), send: (p) => { got.sent.push(p); return 'sent'; }, clipboard: (t) => got.clip.push(t), taskAlerts } });

function call(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, method, path: p, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

(async () => {
  await api.start();
  const info = JSON.parse(fs.readFileSync(api.file, 'utf8'));
  assert.strictEqual(info.port, api.port);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(api.file).mode & 0o777, 0o600);
  const auth = { authorization: `Bearer ${info.key}` };
  const json = { ...auth, 'content-type': 'application/json' };

  assert.deepStrictEqual((await call('GET', '/v1/status', { headers: auth })).body, { connected: true, device: 'Studio' });
  assert.strictEqual((await call('GET', '/v1/status')).code, 401);
  assert.strictEqual((await call('GET', '/v1/status', { headers: { authorization: 'Bearer ' + '0'.repeat(48) } })).code, 401);
  assert.strictEqual((await call('GET', '/v1/status', { headers: { ...auth, origin: 'https://evil.example' } })).code, 403);
  assert.strictEqual((await call('GET', '/v1/status', { headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).code, 403);
  assert.strictEqual((await call('GET', '/v1/status', { headers: { ...auth, host: 'evil.example' } })).code, 403);
  assert.strictEqual((await call('POST', '/v1/clipboard', { headers: { ...auth, 'content-type': 'text/plain' }, body: '{"text":"x"}' })).code, 415);

  assert.strictEqual((await call('POST', '/v1/clipboard', { headers: json, body: JSON.stringify({ text: 'hello' }) })).code, 200);
  assert.deepStrictEqual(got.clip, ['hello']);
  const r = await call('POST', '/v1/send', { headers: json, body: JSON.stringify({ paths: [file, path.join(dir, 'gone.txt'), 'relative.txt'] }) });
  assert.deepStrictEqual(r.body, { ok: true, status: 'sent' });
  assert.deepStrictEqual(got.sent, [[file]]);
  assert.strictEqual((await call('POST', '/v1/send', { headers: json, body: '{"paths":[]}' })).code, 400);
  assert.deepStrictEqual((await call('POST', '/v1/task-alert/start', { headers: json, body: JSON.stringify({ title: 'Build' }) })).body, { ok: true, id: 'a'.repeat(32) });
  assert.deepStrictEqual((await call('POST', '/v1/task-alert/cancel', { headers: json, body: JSON.stringify({ id: 'a'.repeat(32) }) })).body, { ok: true });
  assert.deepStrictEqual((await call('POST', '/v1/task-alert/finish', { headers: json, body: JSON.stringify({ id: 'a'.repeat(32), ok: true }) })).body, { ok: true });
  assert.deepStrictEqual(got.tasks, [['start', { title: 'Build' }], ['cancel', { id: 'a'.repeat(32) }], ['finish', { id: 'a'.repeat(32), ok: true }]]);
  assert.strictEqual((await call('POST', '/v1/nope', { headers: json, body: '{}' })).code, 404);

  const port = api.port;
  await api.stop();
  assert.ok(!fs.existsSync(path.join(dir, 'local-api.json')));
  await assert.rejects(new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/v1/status' }, resolve).on('error', reject); }));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('localapi: ok');
})().catch((e) => { console.error(e); process.exit(1); });
