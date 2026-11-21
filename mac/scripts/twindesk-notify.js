#!/usr/bin/env node
// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Run a local command, then ask the paired phone to show its completion.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TIMEOUT_MS = 2000;
const MAX_REPLY = 4096;
const API_ERRORS = new Set([
  'Connect an Android phone and enable Task alerts on it',
  'Task alert session ended; start a new watch',
  'Too many pending task alerts',
  'Invalid task label',
  'Invalid task alert',
  'Local API restarted',
]);

function argumentsOf(argv) {
  let title = 'Terminal task';
  let offset = 0;
  if (argv[0] === '--title') {
    title = argv[1]?.trim();
    offset = 2;
  }
  if (!title || title.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title) ||
      argv[offset] !== '--' || !argv[offset + 1]) {
    throw new Error('Usage: twindesk-notify.js [--title LABEL] -- command [args...]');
  }
  return { title, command: argv[offset + 1], args: argv.slice(offset + 2) };
}

function endpoint() {
  const profile = require('../store').profilePath(path.join(os.homedir(), 'Library', 'Application Support'));
  let value;
  try {
    const file = path.join(profile, 'local-api.json');
    if (fs.statSync(file).size > MAX_REPLY) throw new Error('size');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Enable General → Local API in TwinDesk to send task alerts.');
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error('The Local API address is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/v1/' || url.search || url.hash || !Number.isInteger(value.port) ||
      value.port < 1 || value.port > 65535 || Number(url.port) !== value.port ||
      typeof value.key !== 'string' || !/^[0-9a-f]{48}$/i.test(value.key)) {
    throw new Error('The Local API address or key is invalid.');
  }
  return { url, key: value.key };
}

function post(route, body) {
  const { url, key } = endpoint();
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(new URL('task-alert/' + route, url), {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': payload.length },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_REPLY) return request.destroy(new Error('The Local API reply was too large.'));
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let reply;
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new Error('The Local API reply was invalid.')); }
        if (API_ERRORS.has(reply?.error)) return reject(new Error(reply.error + '.'));
        if (response.statusCode !== 200) return reject(new Error('The Local API rejected the task alert (HTTP ' + response.statusCode + ').'));
        if (reply?.ok !== true) return reject(new Error('The task alert was refused. Check the phone connection and task alert setting.'));
        resolve(reply);
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('The Local API request timed out.')), TIMEOUT_MS);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => reject(error.code ? new Error('The Local API could not be reached (' + error.code + ').') : error));
    request.end(payload);
  });
}

async function run(argv) {
  const options = argumentsOf(argv);
  let child = null;
  let interrupted = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map(signals.map(signal => [signal, () => {
    interrupted ||= signal;
    // On an interactive terminal, Ctrl-C delivers SIGINT to the whole foreground process group;
    // sending it again can force-abort tools that treat a second SIGINT as immediate termination.
    if (signal === 'SIGINT' && process.stdin.isTTY) return;
    if (child && child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let id = null;
  let result;
  const cancelWatch = async () => {
    if (!id) return;
    const pending = id;
    id = null;
    try { await post('cancel', { id: pending }); } catch { /* Best-effort slot cleanup. */ }
  };
  try {
    try {
      const reply = await post('start', { title: options.title });
      if (typeof reply.id !== 'string' || !/^[0-9a-f]{32}$/.test(reply.id)) throw new Error('The Local API returned an invalid task id.');
      id = reply.id;
    } catch (error) { console.error('TwinDesk task alert: ' + error.message); }
    if (interrupted) {
      await cancelWatch();
      return { signal: interrupted };
    }
    result = await new Promise(resolve => {
      child = spawn(options.command, options.args, { stdio: 'inherit', shell: false });
      child.once('error', error => {
        console.error('TwinDesk task: command could not start (' + (error.code || 'spawn error') + ').');
        resolve({ code: error.code === 'ENOENT' ? 127 : 126 });
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (id && !interrupted) {
      try { await post('finish', { id, ok: result.code === 0 && !result.signal }); }
      catch (error) { console.error('TwinDesk task alert: ' + error.message); }
    } else if (interrupted) {
      await cancelWatch();
    }
    return interrupted ? { signal: interrupted } : result;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => {
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
