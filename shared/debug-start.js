// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: Debug (docs/debug.md), started by each platform's mesh/main.js with what it has. The
// tools (shared/debuglocal.js), what the status snapshot reads (its parts), and the mesh side
// (shared/meshdebug.js) on the hub's bus. Returns {debug, local, activity()}.
//
// settings.mesh.debug: {allow: [ids], anyCommandUntil: ms, verbose: {tags, until}} (multi.json; the
// platform's mesh/settings.js keeps it). save(): the platform's saveSettings.
'use strict';

const { MeshDebug } = require('./meshdebug.js');
const { DebugLocal } = require('./debuglocal.js');
const applog = require('./applog.js');
const Quiet = require('./quiet.js');
const P = require('./protocol.js');

const ACTIVITY = 50;
const TEXT_MAX = 256 * 1024; // of a log or an output, what the window shows (all of it is in the file)
const TAGS = ['link', 'lane', 'quiet', 'bus']; // Verbose log's tags (shared/applog.js v()): quiet.js, inputlane.js, the hubs
const age = (now, t) => (t ? now - t : null);

// The debug settings, always whole.
function debugSettings(settings) {
  const m = settings.mesh || (settings.mesh = {});
  const d = m.debug && typeof m.debug === 'object' ? m.debug : (m.debug = {});
  if (!Array.isArray(d.allow)) d.allow = [];
  if (!Number.isFinite(d.anyCommandUntil)) d.anyCommandUntil = 0;
  if (!d.verbose || typeof d.verbose !== 'object') d.verbose = { tags: [], until: 0 };
  return d;
}

// One socket, for the status: what 11-25 needed to see at a glance.
function socketView(ws, now) {
  if (!ws) return null;
  return {
    transport: ws.transport || 'ip',
    address: ws.address || '',
    rxAgo: age(now, ws.lastRx),
    txAgo: age(now, ws.lastTx),
    pingAgo: age(now, ws.lastPing),
    queued: ws.bufferedAmount || 0,
    open: ws.readyState === 1,
    quiet: ws.quietSince ? { since: age(now, ws.quietSince), probe: !!ws.quietProbe, peerIdle: !!ws.quietPeer } : null,
  };
}

function sessionsView(hub) {
  const now = Date.now();
  return hub.sessions.list().map((s) => {
    const snap = s.snapshot();
    const hosting = !!(s.hosting || s.hostUp); // the Mac's session says hostUp
    const out = { ...snap, transport: s.transport, rxAgo: age(now, s.lastRx), queued: s.bufferedAmount || 0, hosting };
    try {
      if (hosting && s.ctx) {
        out.socket = socketView(s.ctx.ws, now);
        out.alt = socketView(s.ctx.alt, now);
        out.txAgo = age(now, s.ctx.lastTx);
        out.busy = !!(hub.server && hub.server.busyFlags && hub.server.busyFlags.get(s.id));
      } else if (s.link) {
        out.socket = socketView(s.link.ws, now);
        out.alt = socketView(s.link.alt, now);
        out.txAgo = age(now, s.link.lastTx);
        out.busy = !!s.link.busyBy;
      }
      const il = s.il;
      out.lane = il ? { started: !!il.started, up: !!il.up, rtt: il.rttMs == null ? null : Math.round(il.rttMs * 10) / 10 } : null;
      if (s.unknown && s.unknown.size) out.ignoredTypes = [...s.unknown].slice(0, 20);
    } catch (e) {
      out.error = e.message;
    }
    return out;
  });
}

// opts: app, hub, device ({id}), settings, save, kvm(), shadow (MeshShadow) | null, fullkvm (the
// platform's fullkvm/manager.js) | null, ps (windows/ps.js script) | null, helper (the service's logs) | null,
// onChange(): push the window's state (the Activity list, who is debugging this computer).
function startDebug(opts) {
  const { app, hub, device, settings, save } = opts;
  const activity = [];
  const note = (e) => {
    if (e.op === 'hello') return; // the Debug tab asks it of every device: not activity
    activity.unshift(e);
    if (activity.length > ACTIVITY) activity.length = ACTIVITY;
    if (opts.onChange) opts.onChange();
  };
  const nameOf = (id) => {
    const s = hub.sessions.get(id);
    if (s) return s.displayName();
    const p = hub.peers({ indirect: true }).find((x) => x.id === id);
    return p ? p.name : String(id).slice(0, 8);
  };

  // The Full KVM service's logs, through it (shared/fullkvm/route.js serviceLog): 'service' is its own,
  // 'service-node' (Windows) the machine node's. Pieces of 128 KB, as it answers them.
  const helper = opts.helper;
  const svcFiles = process.platform === 'win32' ? [['service', 'fullkvm'], ['service-node', 'node']] : [['service', 'fullkvm']];
  const service = helper && typeof helper.serviceLog === 'function' ? {
    list: async () => {
      const out = [];
      for (const [name, file] of svcFiles) {
        try { out.push({ name, size: (await helper.serviceLog(file, 0, 0)).size }); } catch (_) { /* not connected */ }
      }
      return out;
    },
    read: async (name, from, len) => {
      const file = (svcFiles.find(([n]) => n === name) || [])[1] || 'fullkvm';
      const parts = [];
      let pos = from;
      let got = 0;
      while (got < len) {
        const r = await helper.serviceLog(file, pos, Math.min(128 * 1024, len - got));
        const b = Buffer.from(r.data || '', 'base64');
        if (!b.length) break;
        parts.push(b);
        got += b.length;
        pos = r.from + b.length;
      }
      return Buffer.concat(parts);
    },
  } : null;

  const local = new DebugLocal({
    app,
    applog,
    name: () => (settings.device && settings.device.name) || device.name || require('os').hostname(),
    edition: () => { try { return require('./edition.js').fullKvm() ? 'fullkvm' : 'standard'; } catch (_) { return ''; } },
    saveVerbose: (v) => { debugSettings(settings).verbose = v; save(); if (opts.onChange) opts.onChange(); },
    peers: () => hub.peers({ indirect: true }).map((p) => {
      const l = hub.links && hub.links.get ? hub.links.get(p.id) : null;
      const port = (l && l.pairing && l.pairing.port) || P.PORT;
      return { id: p.id, name: p.name, address: p.address, port };
    }),
    fullkvm: opts.fullkvm ? { state: () => opts.fullkvm.state() } : null,
    ps: opts.ps || null,
    service,
    selfUpdate: () => (opts.updates && opts.updates() && opts.updates().self) || null,
    updatesCfg: () => settings.updates || null,
  });
  local
    .part('device', async () => ({ id: device.id, name: local.name(), version: app.getVersion(), selected: hub.selectedId || null }))
    .part('sessions', async () => sessionsView(hub))
    .part('peers', async () => hub.peers({ indirect: true }))
    .part('quiet', async () => { const q = Quiet.state(); return { ...q, wokeAgo: age(Date.now(), q.wokeAt) }; })
    .part('kvm', async () => {
      const k = opts.kvm && opts.kvm();
      if (!k) return null;
      return { mode: k.mode, partner: k.partner ? nameOf(k.partner) : null, paused: !!k.paused, onBle: !!k.onBle, view: k.view ? k.view() : null };
    });
  if (opts.shadow) local.part('graph', async () => ({ ...opts.shadow.last }));
  if (opts.fullkvm) local.part('fullkvm', () => opts.fullkvm.state());

  const route = (id) => {
    const s = hub.sessions.get(id);
    if (s && s.connected) return id;
    const k = hub.mesh && hub.mesh.known ? hub.mesh.known().find((x) => x.id === id) : null;
    if (!k || !Array.isArray(k.via)) return null;
    return k.via.find((v) => { const vs = hub.sessions.get(v); return !!vs && vs.connected; }) || null;
  };

  const debug = new MeshDebug({
    bus: hub.bus,
    self: device.id,
    route,
    nameOf,
    transportOf: (id) => { const s = hub.sessions.get(id); return s ? s.transport : 'ip'; },
    queued: (id) => { const s = hub.sessions.get(id); return s ? s.bufferedAmount || 0 : 0; },
    allowed: () => debugSettings(settings).allow,
    anyCommand: () => debugSettings(settings).anyCommandUntil > Date.now(),
    hold: (k, on) => Quiet.hold(k, on),
    local,
    onServed: (e) => note({ ...e, dir: 'in', name: nameOf(e.from) }),
    onAsked: (e) => note({ ...e, dir: 'out', name: nameOf(e.to) }),
  }).start();

  // A verbose log switched on before a restart goes on until its time is up.
  const v = debugSettings(settings).verbose;
  if (v && v.until > Date.now() && Array.isArray(v.tags) && v.tags.length) applog.verbose(v.tags, v.until);

  // The window's (and the Local API's) ask: a big answer is kept as a file in the log folder, beside that
  // device's peer logs (peers/<name>-<id8>/), and the window gets its path, its text's end, or the picture.
  const folderOf = (id) => {
    const path = require('path');
    const name = String(nameOf(id) || 'device').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'device';
    return path.join(applog.dir() || require('os').tmpdir(), 'peers', `${name}-${String(id).slice(0, 8)}`);
  };
  const keep = (id, file, bin) => {
    const fs = require('fs');
    const path = require('path');
    const dir = folderOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, file);
    fs.writeFileSync(p, bin);
    return p;
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  async function uiAsk(to, op, args = {}) {
    const id = to === 'self' ? device.id : to;
    try {
      const r = await debug.ask(id, op, args);
      const out = { ok: true, data: r.data };
      if (r.bin && op === 'shot') {
        out.path = keep(id, `screenshot-${stamp()}.png`, r.bin);
        out.png = 'data:image/png;base64,' + r.bin.toString('base64');
      } else if (r.bin && op === 'log') {
        const what = args.grep ? `find-${String(args.grep).replace(/[^\w.-]+/g, '_').slice(0, 20)}` : args.tail ? 'tail' : 'whole';
        out.path = keep(id, `${String((r.data && r.data.file) || 'log').replace(/[^\w.-]+/g, '_')}-${what}-${stamp()}.log`, r.bin);
        out.size = r.bin.length;
        out.text = r.bin.length > TEXT_MAX ? r.bin.subarray(r.bin.length - TEXT_MAX).toString('utf8') : r.bin.toString('utf8');
      }
      return out;
    } catch (e) {
      return { ok: false, error: e.code || e.message || String(e) };
    }
  }

  // Debug › This computer: {allow: [ids]} | {any: true | false} -> the next settings.mesh.debug.
  function next(o) {
    const d = { ...debugSettings(settings) };
    if (o && Array.isArray(o.allow)) d.allow = o.allow;
    if (o && typeof o.any === 'boolean') d.anyCommandUntil = o.any ? Date.now() + require('./debug-settings.js').ANY_MAX : 0;
    return d;
  }

  // The Local API's (shared/localapi.js; the code agent's MCP server): a device by id, by name (any case),
  // or 'self'; answers whole, with bin as base64.
  const idOf = (to) => {
    if (to === 'self' || to === device.id) return device.id;
    const peers = hub.peers({ indirect: true });
    const p = peers.find((x) => x.id === to) || peers.find((x) => (x.name || '').toLowerCase() === String(to).toLowerCase())
      || peers.find((x) => x.id.startsWith(to) && to.length >= 6);
    return p ? p.id : null;
  };
  // An update through the mesh (docs/debug.md): a file of this computer sent to a device in pieces
  // (put, PUT_WINDOW at a time), installed there (update), then waited for until it answers again as
  // the new start (its uptime from 0). Jobs: what the Local API's update/job routes report.
  const jobs = new Map();
  const PUT_WINDOW = 3;
  async function pushUpdate(job, id, file, force) {
    const fs = require('fs');
    const crypto = require('crypto');
    const path = require('path');
    const set = (x) => Object.assign(job, x, { at: Date.now() });
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      const name = path.basename(file);
      set({ state: 'checking', size: st.size });
      const before = (await debug.ask(id, 'hello')).data || {};
      set({ was: before.version || '', kind: (before.update && before.update.kind) || '' });
      if (before.update && !before.update.kind) throw new Error('that copy of TwinDesk can’t update itself (as it was installed)');
      const h = crypto.createHash('sha256');
      await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject));
      const sha256 = h.digest('hex');
      set({ state: 'sending', sha256, sent: 0 });
      const { PIECE } = require('./meshdebug.js');
      const fd = fs.openSync(file, 'r');
      try {
        const offsets = [];
        for (let at = 0; at < st.size; at += PIECE) offsets.push(at);
        const one = async (at) => {
          const buf = Buffer.alloc(Math.min(PIECE, st.size - at));
          fs.readSync(fd, buf, 0, buf.length, at);
          let tries = 0;
          for (;;) {
            try { return await debug.ask(id, 'put', { name, size: st.size, sha256, at }, buf); } catch (e) {
              if (++tries >= 3 || !['timeout', 'unreachable'].includes(e.code)) throw e;
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        };
        // The first piece alone (it starts the file there), then PUT_WINDOW at a time, the last one alone
        // (it checks the whole file).
        await one(0);
        set({ sent: Math.min(PIECE, st.size) });
        const mid = offsets.slice(1, -1);
        for (let i = 0; i < mid.length; i += PUT_WINDOW) {
          await Promise.all(mid.slice(i, i + PUT_WINDOW).map(one));
          set({ sent: Math.min(st.size, mid[Math.min(mid.length - 1, i + PUT_WINDOW - 1)] + PIECE) });
        }
        if (offsets.length > 1) await one(offsets[offsets.length - 1]);
        set({ sent: st.size });
      } finally {
        fs.closeSync(fd);
      }
      set({ state: 'installing' });
      const r = await debug.ask(id, 'update', { name, force: !!force });
      set({ state: 'restarting', installing: r.data });
      // Back as the new start: a hello whose uptime is less than the time since the install began.
      const since = Date.now();
      for (;;) {
        await new Promise((res) => setTimeout(res, 5000));
        if (Date.now() - since > 10 * 60 * 1000) throw new Error('it didn’t come back within 10 minutes (on Windows: is its administrator prompt waiting?)');
        let hello = null;
        try { hello = (await debug.ask(id, 'hello')).data; } catch (_) { continue; }
        if (hello && Number(hello.uptime) * 1000 < Date.now() - since + 5000) {
          return set({ state: 'done', version: hello.version || '', uptime: hello.uptime });
        }
      }
    } catch (e) {
      set({ state: 'failed', error: e.code || e.message || String(e) });
    }
  }

  const api = {
    // {to, path, force} -> {ok, job}: started; job(job) says how it goes.
    update: async (to, file, force) => {
      const id = idOf(to);
      if (!id) return { ok: false, error: 'no such device' };
      if (id === device.id) return { ok: false, error: 'not this computer: update it as it was installed' };
      if (typeof file !== 'string' || !require('path').isAbsolute(file)) return { ok: false, error: 'an absolute path' };
      for (const j of jobs.values()) if (j.id === id && !['done', 'failed'].includes(j.state)) return { ok: false, error: `already updating ${j.device}` };
      const job = { job: Math.random().toString(36).slice(2, 10), id, device: nameOf(id), file, state: 'starting', started: Date.now() };
      jobs.set(job.job, job);
      if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
      console.log(`[debug] updating ${job.device} with ${file}`);
      pushUpdate(job, id, file, force).then(() => console.log(`[debug] update of ${job.device}: ${job.state}${job.error ? ' (' + job.error + ')' : ''}`));
      return { ok: true, job: job.job, device: job.device };
    },
    job: async (j) => {
      const job = jobs.get(String(j));
      return job ? { ok: true, ...job, id: undefined } : { ok: false, error: 'no such job' };
    },
    devices: async () => {
      const peers = hub.peers({ indirect: true });
      const hellos = await Promise.all(peers.map((p) => (P.isPhoneOs && P.isPhoneOs(p.os) ? Promise.resolve({ error: 'phone' })
        : debug.ask(p.id, 'hello').then((r) => r.data, (e) => ({ error: e.code || e.message })))));
      const me = await local.hello();
      return [
        { id: device.id, name: me.name, os: me.os, state: 'self', hello: { ...me, allowed: true, anyCommand: true } },
        ...peers.map((p, i) => ({ id: p.id, name: p.name, os: p.os, state: p.state, rtt: p.rtt, via: p.via || null, hello: hellos[i] })),
      ];
    },
    ask: async (to, op, args) => {
      const id = idOf(to);
      if (!id) return { ok: false, error: 'no such device' };
      try {
        const r = await debug.ask(id, op, args);
        return { ok: true, device: nameOf(id), data: r.data, ...(r.bin ? { bin: r.bin.toString('base64') } : {}) };
      } catch (e) {
        return { ok: false, device: nameOf(id), error: e.code || e.message || String(e) };
      }
    },
  };

  return {
    debug,
    local,
    nameOf,
    api,
    ask: uiAsk,
    next,
    // For the window's state.
    view: () => {
      const d = debugSettings(settings);
      return {
        allow: d.allow,
        anyCommandUntil: d.anyCommandUntil > Date.now() ? d.anyCommandUntil : 0,
        verbose: applog.verboseState(),
        tags: TAGS,
        diags: local.diagNames(),
        activity: activity.slice(0, 20),
        debuggedBy: (() => {
          const now = Date.now();
          const names = new Set();
          for (const e of activity) if (e.dir === 'in' && e.ok && now - e.at < 120000) names.add(e.name);
          return [...names];
        })(),
        logs: applog.dir(),
      };
    },
    activity: () => activity.slice(),
    // Who asked this computer for something (not hello) within the last 2 minutes: the note on Debug.
    debuggedBy: () => {
      const now = Date.now();
      const names = new Set();
      for (const e of activity) if (e.dir === 'in' && e.op !== 'hello' && e.ok && now - e.at < 120000) names.add(e.name);
      return [...names];
    },
  };
}

module.exports = { startDebug, debugSettings, sessionsView };
