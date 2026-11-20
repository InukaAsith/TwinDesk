// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { LocalApi } = require('../../shared/localapi');
const { OS, T } = require('../../shared/protocol');
const { TaskAlerts } = require('../task-alerts');

const NOTIFY_SCRIPT = path.join(__dirname, '../scripts/twindesk-notify.js');

function fixture() {
  const peer = new EventEmitter();
  const ctx = { os: OS.ANDROID, deviceId: 'phone', authed: true, ws: { readyState: 1 } };
  peer.current = ctx;
  peer.outbound = c => c === peer.current && c.ws.readyState === 1 ? c.ws : null;
  const sent = [];
  peer.send = (ctx, message) => sent.push([ctx.ws, message]);
  const alerts = new TaskAlerts(peer);
  const policy = (on, ws = ctx.ws) => peer.emit(`t:${T.TASK_ALERT_POLICY}`, { on }, ctx, ws);
  return { peer, ctx, alerts, policy, sent };
}

test('approved Android session receives one alert with only the label and result', () => {
  const { ctx, alerts, policy, sent } = fixture();
  assert.equal(alerts.start({ title: 'Build' }).code, 409);
  policy(true);
  const result = alerts.start({ title: '  Build  ', command: 'local-only arguments' });
  assert.equal(result.code, 200);
  const { id } = result.body;
  assert.match(id, /^[a-f0-9]{32}$/);
  policy(true); // an unchanged policy refresh keeps existing watches
  assert.equal(alerts.finish({ id, ok: true, output: 'local-only output' }).code, 200);
  assert.equal(alerts.finish({ id, ok: true }).code, 409);
  assert.deepEqual(sent, [[ctx.ws, { t: T.TASK_ALERT, id, title: 'Build', ok: true }]]);
});

test('revoked, foreign and replaced sockets never inherit an alert', () => {
  const { peer, ctx, alerts, policy, sent } = fixture();
  const ws = ctx.ws;
  policy(true, { readyState: 1 });
  assert.equal(alerts.start({ title: 'Build' }).code, 409);
  policy(true);
  assert.equal(alerts.start({ title: 'Build\nLog' }).code, 400);
  const first = alerts.start({ title: 'Build' }).body.id;
  policy(false);
  policy(true);
  assert.equal(alerts.finish({ id: first, ok: true }).code, 409);

  const second = alerts.start({ title: 'Build' }).body.id;
  ctx.ws = { readyState: 1 };
  peer.emit('transport', ctx);
  policy(true, ws);
  assert.equal(alerts.start({ title: 'Build' }).code, 409);
  policy(true);
  assert.equal(alerts.finish({ id: second, ok: false }).code, 409);
  assert.deepEqual(sent, []);
});

test('cancel releases pending watch slots without notifying the phone', () => {
  const { alerts, policy, sent } = fixture();
  policy(true);
  const { id } = alerts.start({ title: 'Build' }).body;
  assert.equal(alerts.cancel({ id: 'invalid' }).code, 400);
  assert.equal(alerts.cancel({ id }).code, 200);
  assert.equal(alerts.tasks.size, 0);
  assert.equal(alerts.finish({ id, ok: true }).code, 409);
  assert.deepEqual(sent, []);
});

function runNotify(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NOTIFY_SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('twindesk-notify wrapper delivers completion, preserves exit code, and cancels on interrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-task-alerts-'));
  const { alerts, policy, sent } = fixture();
  policy(true);
  const api = new LocalApi({ dir, actions: { status: () => ({ connected: true, device: 'Phone' }), send: () => 'sent', clipboard: () => {}, taskAlerts: alerts } });
  try {
    await api.start();
    const env = { ...process.env, MACSHARE_PROFILE: dir };

    const okRun = await runNotify(['--title', '  Build  ', '--', process.execPath, '-e', 'process.exit(0)'], env);
    assert.equal(okRun.status, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].t, T.TASK_ALERT);
    assert.equal(sent[0][1].title, 'Build');
    assert.equal(sent[0][1].ok, true);

    const failRun = await runNotify(['--title', 'Tests', '--', process.execPath, '-e', 'process.exit(7)'], env);
    assert.equal(failRun.status, 7);
    assert.equal(sent.length, 2);
    assert.equal(sent[1][1].title, 'Tests');
    assert.equal(sent[1][1].ok, false);

    const badTitle = await runNotify(['--title', 'A\u202eB', '--', process.execPath, '-e', 'process.exit(0)'], env);
    assert.equal(badTitle.status, 2);
    assert.equal(sent.length, 2);

    const noApi = await runNotify(['--title', 'Offline', '--', process.execPath, '-e', 'process.exit(5)'], {
      ...process.env, MACSHARE_PROFILE: path.join(dir, 'missing'),
    });
    assert.equal(noApi.status, 5);
    assert.match(noApi.stderr, /Local API/);

    // Interrupting the wrapper cancels its pending watch slot without sending an alert.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [NOTIFY_SCRIPT, '--title', 'Long build', '--', process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ready')) child.kill('SIGTERM');
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        try {
          assert.equal(code, null);
          assert.equal(signal, 'SIGTERM');
          resolve();
        } catch (e) { reject(e); }
      });
    });
    assert.equal(sent.length, 2, 'interrupted run does not alert the phone');
    assert.equal(alerts.tasks.size, 0, 'interrupted run releases its pending watch slot');
  } finally {
    await api.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
