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
  const api = {
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
