#!/usr/bin/env node
// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk's MCP server (docs/debug.md): a code agent on this computer debugs every device of the mesh
// through this computer's TwinDesk. It speaks MCP (JSON-RPC 2.0, one message a line) on stdin/stdout and
// asks TwinDesk's Local API (shared/localapi.js: 127.0.0.1, the key in local-api.json, new at every start),
// which asks the device (shared/meshdebug.js), directly or through another one.
//
// Needs, on this computer: TwinDesk in Multi-device, General › Local API on; on each device to debug:
// Debug › Let these devices debug this computer, with this computer on. No dependencies.
//   claude mcp add twindesk -- node tools/twindesk-mcp/server.js     (or .mcp.json, at the repository's root)
// TWINDESK_API_FILE: another local-api.json (a second profile, tests).
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const TEXT_MAX = 200 * 1024; // of a log or an output, what goes back to the agent (the rest: say so)

function apiFile() {
  if (process.env.TWINDESK_API_FILE) return process.env.TWINDESK_API_FILE;
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'MacShare', 'local-api.json');
}

// Read again at every call: the port and key change each time TwinDesk starts.
function call(method, route, body) {
  let conf;
  try { conf = JSON.parse(fs.readFileSync(apiFile(), 'utf8')); } catch (_) {
    return Promise.reject(new Error(`TwinDesk's Local API isn't on (no ${apiFile()}): turn on General › Local API in TwinDesk, in Multi-device`));
  }
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: conf.port, path: '/v1/' + route, method,
      headers: { authorization: `Bearer ${conf.key}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      timeout: 150000,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        let v;
        try { v = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) { return reject(new Error(`TwinDesk answered ${res.statusCode}`)); }
        if (res.statusCode === 404 && v.error === 'not in Multi-device') return reject(new Error('TwinDesk isn’t in Multi-device (or is older than Debug)'));
        if (res.statusCode !== 200) return reject(new Error(v.error || `TwinDesk answered ${res.statusCode}`));
        resolve(v);
      });
    });
    req.on('timeout', () => req.destroy(new Error('TwinDesk took too long')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'TwinDesk isn’t running (or its Local API was just turned off)' : e.message)));
    if (data) req.write(data);
    req.end();
  });
}

const ask = (device, op, args = {}) => call('POST', 'debug/ask', { to: device, op, args }).then((r) => {
  if (!r.ok) throw new Error(`${r.device || device}: ${explain(r.error)}`);
  return r;
});

function explain(e) {
  return {
    'not allowed': 'it doesn’t let this computer debug it (on that device: Debug › Let these devices debug this computer)',
    'no answer': 'no answer: an older TwinDesk, or a phone',
    unreachable: 'not reachable now (not connected, directly or through another device)',
    bluetooth: 'connected through Bluetooth only: too slow for this',
    'any command is off': 'Allow any command is off on that device (its Debug tab; it turns itself off after an hour)',
    'no such device': 'no device of that name or id (mesh_devices lists them)',
    timeout: 'it didn’t answer in time (it did before: busy, or its link is in trouble)',
  }[e] || e;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const cut = (s) => (s.length > TEXT_MAX ? `(the last ${Math.round(TEXT_MAX / 1024)} KB of ${Math.round(s.length / 1024)} KB)\n` + s.slice(s.length - TEXT_MAX) : s);
const DEVICE = { type: 'string', description: 'A device of the mesh: its name (as mesh_devices lists it), its id, or "self" for this computer' };

const TOOLS = [
  {
    name: 'mesh_devices',
    description: 'Every device of the TwinDesk mesh as this computer sees it: connected directly or through another device, whether it lets this computer debug it, its TwinDesk version and the diagnostics it has.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const list = await call('GET', 'debug/devices');
      return text(list.map((d) => {
        const h = d.hello || {};
        const how = d.state === 'self' ? 'this computer' : d.state === 'via' ? `through ${(d.via || []).join(', ')}` : d.state + (d.rtt != null ? ` ${d.rtt} ms` : '');
        const can = h.error ? explain(h.error) : h.allowed ? `lets this computer debug it${h.anyCommand ? ', any command allowed' : ''}` : 'doesn’t let this computer debug it';
        const diags = (h.diags || []).map((x) => x.name).join(', ');
        return `${d.name} (${d.os}, id ${d.id}): ${how}; ${can}${h.version ? `; TwinDesk ${h.version}` : ''}${diags ? `; diagnostics: ${diags}` : ''}`;
      }).join('\n'));
    },
  },
  {
    name: 'device_status',
    description: 'A device\'s live status: every session (transport, address, round trip, how long since anything was heard and sent, queued bytes, quiet-link state), input lanes, the KVM mode and partner, the Full KVM service, the last wake, uptime, the routing graph. JSON.',
    inputSchema: { type: 'object', properties: { device: DEVICE }, required: ['device'] },
    run: async ({ device }) => text(JSON.stringify((await ask(device, 'status')).data, null, 1)),
  },
  {
    name: 'device_verbose',
    description: 'Turn a device\'s verbose log on for a while (or off with minutes 0). Tags: link (a socket that has heard nothing for over 2 s, each second), lane (the input lane’s round trip every 10 s), quiet (quiet-link probes and closes), bus (each message type, every 10 s), all.',
    inputSchema: {
      type: 'object',
      properties: { device: DEVICE, tags: { type: 'array', items: { type: 'string', enum: ['all', 'link', 'lane', 'quiet', 'bus'] } }, minutes: { type: 'number', minimum: 0, maximum: 120 } },
      required: ['device', 'minutes'],
    },
    run: async ({ device, tags, minutes }) => text(JSON.stringify((await ask(device, 'verbose', { tags: tags && tags.length ? tags : ['all'], minutes })).data)),
  },
  {
    name: 'device_files',
    description: 'The logs a device has, with their sizes: TwinDesk.log (.1, .2: older), crash.log, link-stats.log, and the Full KVM service\'s (service, service-node).',
    inputSchema: { type: 'object', properties: { device: DEVICE }, required: ['device'] },
    run: async ({ device }) => text((await ask(device, 'files')).data.map((f) => `${f.name}  ${f.size} bytes`).join('\n')),
  },
  {
    name: 'device_log',
    description: 'Read a device\'s log: its end (tail bytes), a byte range (from, len), or the lines holding a text (grep, searched there). Default: the last 64 KB of TwinDesk.log.',
    inputSchema: {
      type: 'object',
      properties: {
        device: DEVICE,
        file: { type: 'string', description: 'TwinDesk.log (default), TwinDesk.1.log, TwinDesk.2.log, crash.log, link-stats.log, service, service-node' },
        tail: { type: 'number', description: 'the last this many bytes' },
        from: { type: 'number' }, len: { type: 'number' },
        grep: { type: 'string', description: 'only the lines holding this text (from the file\'s last 16 MB)' },
      },
      required: ['device'],
    },
    run: async ({ device, file, tail, from, len, grep }) => {
      const args = { file: file || 'TwinDesk.log' };
      if (grep) args.grep = grep;
      else if (from != null || len != null) Object.assign(args, { from: from || 0, len: len || 65536 });
      else args.tail = tail || 65536;
      const r = await ask(device, 'log', args);
      const body = r.bin ? Buffer.from(r.bin, 'base64').toString('utf8') : '';
      const d = r.data || {};
      const head = grep ? `${d.file}: ${d.lines} lines with "${grep}" (of ${d.size} bytes)` : `${d.file}: bytes ${d.from}–${d.from + d.len} of ${d.size}`;
      return text(`${head}\n${cut(body)}`);
    },
  },
  {
    name: 'device_screenshot',
    description: 'A screenshot of one of a device\'s displays (display: its index, 0 first). Not through Bluetooth.',
    inputSchema: { type: 'object', properties: { device: DEVICE, display: { type: 'number' } }, required: ['device'] },
    run: async ({ device, display }) => {
      const r = await ask(device, 'shot', { display: display || 0 });
      const d = r.data || {};
      return {
        content: [
          { type: 'image', data: r.bin, mimeType: 'image/png' },
          { type: 'text', text: `${r.device}: display ${(d.display || 0) + 1} of ${d.displays || 1}${d.width ? `, ${d.width}×${d.height}` : ''}${d.tool ? ` (${d.tool})` : ''}` },
        ],
      };
    },
  },
  {
    name: 'device_diag',
    description: 'Run one of a device\'s fixed diagnostics (mesh_devices lists each device\'s): network, adapter-power, events (sleep, wake and network events of the last hours), reach (another device of the mesh: peer), sockets, firewall, processes, fullkvm.',
    inputSchema: {
      type: 'object',
      properties: { device: DEVICE, name: { type: 'string' }, peer: { type: 'string', description: 'reach: the device to reach (name or id)' }, hours: { type: 'number', minimum: 1, maximum: 48 } },
      required: ['device', 'name'],
    },
    run: async ({ device, name, peer, hours }) => text(cut((await ask(device, 'diag', { name, peer: peer || '', hours: hours || 3 })).data.out || '(nothing)')),
  },
  {
    name: 'device_run',
    description: 'Run a command on a device, as the person signed in there (cmd.exe on Windows, sh on Linux, zsh on the Mac). Only while that device has Allow any command on (its Debug tab; it turns itself off after an hour). The command is written to that device\'s log.',
    inputSchema: { type: 'object', properties: { device: DEVICE, command: { type: 'string' }, timeout: { type: 'number', description: 'seconds, at most 120' } }, required: ['device', 'command'] },
    run: async ({ device, command, timeout }) => {
      const d = (await ask(device, 'run', { cmd: command, timeout: timeout || 60 })).data;
      return text(`$ ${command}\n${cut(d.out || '')}${d.code ? `\n(exit ${d.code})` : ''}`);
    },
  },
  {
    name: 'device_restart',
    description: 'Restart TwinDesk on a device (what: app). It answers first, then restarts; its links come back by themselves.',
    inputSchema: { type: 'object', properties: { device: DEVICE, what: { type: 'string', enum: ['app'] } }, required: ['device'] },
    run: async ({ device, what }) => text(JSON.stringify((await ask(device, 'restart', { what: what || 'app' })).data)),
  },
];

// ---- MCP over stdio ----

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification (initialized, cancelled): nothing to answer
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'twindesk', version: VERSION },
        instructions: 'Debug every device of the TwinDesk mesh from this computer. Start with mesh_devices. A device answers only if it lets this computer debug it (its Debug tab).',
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === (params && params.name));
      if (!tool) return reply(id, null, { code: -32602, message: 'unknown tool' });
      try {
        return reply(id, await tool.run((params && params.arguments) || {}));
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    return reply(id, null, { code: -32601, message: 'method not found' });
  } catch (e) {
    return reply(id, null, { code: -32603, message: e.message });
  }
}

if (require.main === module) {
  let buf = '';
  const pending = new Set(); // calls still being answered: stdin closing waits for them
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { reply(null, null, { code: -32700, message: 'parse error' }); continue; }
      const p = handle(msg).finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  process.stdin.on('end', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
}

module.exports = { TOOLS, handle, apiFile };
