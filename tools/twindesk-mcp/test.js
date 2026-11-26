// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The MCP server (tools/twindesk-mcp/server.js) end to end, as a code agent uses it: the server, spawned,
// over stdio → this computer's Local API (shared/localapi.js, its key file) → Debug (shared/debug-start.js)
// → another device on real sockets (windows/mesh: Server, Pairing, LinkManager, Hub). The tools list, the
// devices, a status, a log, a refusal said plainly, and no Local API at all.
// Run: node tools/twindesk-mcp/test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const W = path.join(ROOT, 'windows', 'mesh');
const { Mesh } = require(path.join(ROOT, 'shared', 'mesh.js'));
const { Server } = require(path.join(W, 'server.js'));
const { Pairing } = require(path.join(W, 'hostpair.js'));
const { LinkManager } = require(path.join(W, 'links.js'));
const { Hub } = require(path.join(W, 'hub.js'));
const { startDebug } = require(path.join(ROOT, 'shared', 'debug-start.js'));
const { LocalApi } = require(path.join(ROOT, 'shared', 'localapi.js'));
const { loadTestCert } = require(path.join(W, 'test', 'lib', 'testcert.js'));
const { close, waitFor, pair, memoryStorage } = require(path.join(W, 'test', 'lib', 'mesh.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-mcp-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
setInterval(() => {}, 1000); // meshdebug's timers are unref'd

async function node(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((r) => server.once('listening', r));
  const storage = memoryStorage();
  storage.write('pairings.json', []);
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, fp: cert.fp, port: server.port, server, pairing, links, storage, mesh, hub, settings: { device: { name }, mesh: {} } };
  n.dbg = startDebug({ app: { getVersion: () => '9.9.9' }, hub, device: { id, name }, settings: n.settings, save: () => {}, kvm: () => null });
  n.log = path.join(tmp, `${name}.log`);
  fs.writeFileSync(n.log, `${name} started\n[lane] down\n[server] nitro silent for 8000 ms, closing\n`);
  n.dbg.local.files = async () => [{ name: 'TwinDesk.log', path: n.log, size: fs.statSync(n.log).size }];
  return n;
}

// The MCP server as an agent runs it: requests in, one answer per line out.
function mcp(apiFile) {
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, TWINDESK_API_FILE: apiFile }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  let n = 0;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  p.on('exit', (code) => { for (const w of waiting.values()) w({ error: { message: `the server exited (${code})` } }); waiting.clear(); });
  const req = (method, params) => new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer in 30 s`)); }, 30000);
    waiting.set(id, (m) => { clearTimeout(t); if (m.error && !m.result) reject(new Error(m.error.message)); else resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => (await req('tools/call', { name, arguments: args })).result;
  return { req, tool, end: () => p.kill() };
}

(async () => {
  const A = await node('nitro');
  const B = await node('Ryzen9');
  const api = new LocalApi({ dir: tmp, actions: { status: () => ({}), send: () => null, clipboard: () => {}, debug: A.dbg.api } });
  try {
    await pair(A, B);
    await waitFor(() => { const s = A.hub.sessions.get(B.id); return !!s && s.connected; }, 'linked');
    await api.start();
    const m = mcp(api.file);

    const init = await m.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.strictEqual(init.result.serverInfo.name, 'twindesk');
    const tools = (await m.req('tools/list', {})).result.tools.map((t) => t.name);
    assert.deepStrictEqual(tools, ['mesh_devices', 'device_status', 'device_verbose', 'device_files', 'device_log', 'device_screenshot', 'device_diag', 'device_run', 'device_restart']);

    // Not let in yet: the list says so, and a status says what to do.
    let r = await m.tool('mesh_devices', {});
    assert.match(r.content[0].text, /Ryzen9 \(win, id .*\): connected[^;]*; doesn’t let this computer debug it; TwinDesk 9\.9\.9/);
    assert.match(r.content[0].text, /nitro .*this computer; lets this computer debug it/);
    r = await m.tool('device_status', { device: 'Ryzen9' });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /Debug › Let these devices debug this computer/);

    B.settings.mesh.debug = { allow: [A.id], anyCommandUntil: 0, verbose: { tags: [], until: 0 } };
    r = await m.tool('device_status', { device: 'ryzen9' }); // by name, any case
    const st = JSON.parse(r.content[0].text);
    assert.ok(st.sessions.some((s) => s.id === A.id && s.connected), 'its session with nitro');
    r = await m.tool('device_log', { device: 'Ryzen9', grep: 'silent' });
    assert.match(r.content[0].text, /1 lines with "silent"[\s\S]*nitro silent for 8000 ms/);
    r = await m.tool('device_run', { device: 'Ryzen9', command: 'echo hi' });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /Allow any command is off/);
    r = await m.tool('device_diag', { device: 'self', name: 'nope' });
    assert.strictEqual(r.isError, true);
    r = await m.tool('device_status', { device: 'Nobody' });
    assert.match(r.content[0].text, /no device of that name/);
    m.end();

    // TwinDesk's Local API off: said plainly.
    const off = mcp(path.join(tmp, 'none.json'));
    r = await off.tool('mesh_devices', {});
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /turn on General › Local API/);
    off.end();
    console.log('twindesk-mcp: all passed');
  } finally {
    await api.stop();
    close(A, B);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
