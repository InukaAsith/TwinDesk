// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: debugging any device of the mesh from any computer (docs/debug.md). The Debug tab and
// the Local API (the code agent's MCP server, tools/twindesk-mcp) ask; every device answers, if the
// person there let the asking device debug it (Debug › Let other devices debug this computer).
//
// Wire (new types; an older app or a phone ignores them, logging the type once):
//   dbg.req {req, from, to, hops, op, args}
//   dbg.res {req, from, to, part, more, data? (the first part), bin? (base64 piece), error?}
// from/to: device ids (the asker, the device asked); req: unique for the asker.
//
// Through other devices: the bus reaches only direct sessions, so a device that gets a request (or an
// answer) for another one passes it on: to that device if it's connected here, else to the first
// connected device it's reached through (route()). At most MAX_HOPS; a request seen already is dropped;
// the answer goes back the way the request came (back: req -> the device it came from, for BACK_MS).
//
// What 11-25 taught (Ryzen9's links dying 4 s after every connect, nitro reading log copies after the
// fact), and so:
//   - never wait for an answer: nothing in NO_ANSWER_MS is "doesn't debug" (an older app, a phone), and
//     that device is asked again only after RETRY_MS; a device that answered before isn't shut out so
//     (one slow request did that to AMXLPDL for 2 min: tasklist /v took 10 s), and every request it lets in
//     is acknowledged at once ({ack, more}: no data), so a diagnostic or a command may take its time;
//   - big answers in PIECE pieces, each only while the socket has less than HIGH_WATER queued, so a
//     5 MB log never holds up the session's pings (TIMEOUT_MS later the link would be closed for it);
//     a quiet link is held (Quiet.hold) while pieces go, never for good;
//   - not through Bluetooth: a screenshot or a big log would stall the mouse for seconds;
//   - a relayed request is the asker's word only: it's done if the asker AND the device that passed it
//     on are both let in here;
//   - one log line per request served, none per piece.
'use strict';

const fs = require('fs');

const PIECE = 128 * 1024; // bytes of `bin` in one dbg.res
const HIGH_WATER = 512 * 1024; // queued on a socket: the next piece waits
const MAX_HOPS = 4;
const SEEN_MAX = 200;
const BACK_MS = 60000;
const NO_ANSWER_MS = 10000;
const RETRY_MS = 120000;
const LIMIT_MS = 60000; // the whole answer
const RUN_LIMIT_MS = 130000;
const BLE_MAX = 64 * 1024; // what may go through Bluetooth in one answer
const GREP_SCAN = 16 * 1024 * 1024; // a search reads at most this much of a file
const OUT_MAX = 16 * 1024 * 1024; // an answer's bytes, at most
const OPS = ['hello', 'status', 'verbose', 'files', 'log', 'shot', 'diag', 'run', 'restart'];
const BIG = new Set(['log', 'shot']); // their answers may be big: not through Bluetooth beyond BLE_MAX

class MeshDebug {
  // bus: the hub's (on, send(id, msg), connectedIds()). self: this device's id.
  // route(id) -> the id of the connected device to send to for `id` (itself when direct), or null.
  // transportOf(id) -> 'ble' | 'ip'; queued(id) -> bytes waiting on its socket.
  // allowed(): ids let in (Debug › Let other devices debug this computer); anyCommand(): *Allow any
  // command* on now. local: this device's tools (shared/debuglocal.js and the platform's parts):
  //   hello() -> {}, status() -> {}, verbose({tags, minutes}) -> {}, files() -> [{name, size, path?}],
  //   read?(name, from, len) -> Promise<Buffer> (a file without path), shot(args) -> Promise<{data, bin}>,
  //   diag(args) -> Promise<{}>, run(args) -> Promise<{}>, restart(args) -> Promise<{}>.
  // nameOf(id); hold(key, on): Quiet.hold; onServed(entry), onAsked(entry): the Activity list.
  constructor(opts) {
    Object.assign(this, {
      log: (l) => console.log(l),
      now: () => Date.now(),
      nameOf: (id) => id,
      transportOf: () => 'ip',
      queued: () => 0,
      allowed: () => [],
      anyCommand: () => false,
      hold: () => {},
      onServed: () => {},
      onAsked: () => {},
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    }, opts);
    this.n = 0;
    this.pending = new Map(); // req -> {to, op, resolve, reject, parts, data, timers}
    this.seen = new Set(); // from:req of requests passed on or served
    this.back = new Map(); // from:req -> {id, at}: where the answer goes
    this.silent = new Map(); // id -> when it didn't answer (asked again after RETRY_MS)
    this.heard = new Set(); // ids that answered once: they debug, so a slow answer isn't "an older app"
    this.queues = new Map(); // id -> Promise: what's sent to that device, in order
    this.said = new Set(); // log lines said once (relays)
  }

  start() {
    this.bus.on('dbg.req', (m, from) => this._onReq(m, from));
    this.bus.on('dbg.res', (m, from) => this._onRes(m, from));
    return this;
  }

  // ---- asking ----

  // -> Promise<{data, bin: Buffer | null}>; rejects with an Error whose code is the device's answer
  // ('not allowed', 'bluetooth', …), 'unreachable', 'no answer' or 'timeout'.
  ask(to, op, args = {}) {
    if (!OPS.includes(op)) return Promise.reject(err('unknown op'));
    if (to === this.self) return this._serveSelf(op, args);
    const quiet = this.silent.get(to);
    if (quiet && op !== 'hello' && this.now() - quiet < RETRY_MS) return Promise.reject(err('no answer'));
    const hop = this.route(to);
    if (!hop) return Promise.reject(err('unreachable'));
    const req = `${this.self.slice(0, 8)}-${(++this.n).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const p = { to, op, resolve, reject, parts: [], data: undefined, got: false };
      const done = (e, v) => {
        clearTimeout(p.first);
        clearTimeout(p.all);
        this.pending.delete(req);
        this.onAsked({ at: this.now(), to, op, ok: !e, error: e ? e.code : '' });
        if (e) reject(e); else resolve(v);
      };
      p.done = done;
      p.first = setTimeout(() => {
        if (p.got) return;
        if (this.heard.has(to)) return done(err('timeout'));
        this.silent.set(to, this.now());
        done(err('no answer'));
      }, NO_ANSWER_MS);
      p.all = setTimeout(() => done(err('timeout')), op === 'run' ? RUN_LIMIT_MS : LIMIT_MS);
      for (const t of [p.first, p.all]) if (t.unref) t.unref();
      this.pending.set(req, p);
      const sent = this.bus.send(hop, { t: 'dbg.req', req, from: this.self, to, hops: 0, op, args: clean(args) });
      if (!sent) done(err('unreachable'));
    });
  }

  // Whether `id` answered (hello) recently enough to be asked; false: it didn't, RETRY_MS ago at most.
  answers(id) {
    const at = this.silent.get(id);
    return !at || this.now() - at >= RETRY_MS;
  }

  _onRes(m, sender) {
    if (!m || typeof m !== 'object' || typeof m.req !== 'string') return;
    if (m.to !== this.self) return this._pass(m, sender, true);
    const p = this.pending.get(m.req);
    if (!p || m.from !== p.to) return; // not ours, or late
    p.got = true;
    this.silent.delete(p.to);
    this.heard.add(p.to);
    if (m.error) return p.done(err(String(m.error).slice(0, 200)));
    if (m.part === 0 && m.data !== undefined) p.data = m.data;
    if (typeof m.bin === 'string' && m.bin) {
      p.parts.push(Buffer.from(m.bin, 'base64'));
      p.size = (p.size || 0) + p.parts[p.parts.length - 1].length;
      if (p.size > OUT_MAX) return p.done(err('too big'));
    }
    if (!m.more) p.done(null, { data: p.data, bin: p.parts.length ? Buffer.concat(p.parts) : null });
  }

  // ---- passing on ----

  _onReq(m, sender) {
    if (!m || typeof m !== 'object' || typeof m.req !== 'string' || typeof m.from !== 'string' || typeof m.to !== 'string') return;
    const key = `${m.from}:${m.req}`;
    if (this.seen.has(key)) return;
    remember(this.seen, key);
    if (m.to === this.self) return this._serve(m, sender);
    this._pass(m, sender, false);
  }

  // A request (answer: false) or an answer (true) for another device.
  _pass(m, sender, answer) {
    const key = `${answer ? m.to : m.from}:${m.req}`;
    let next;
    if (answer) {
      const b = this.back.get(key);
      if (!b || this.now() - b.at > BACK_MS) return;
      if (!m.more) this.back.delete(key);
      next = b.id;
    } else {
      const hops = Number(m.hops) || 0;
      if (hops >= MAX_HOPS) return;
      next = this.route(m.to);
      if (!next || next === sender) {
        return this._sendTo(sender, { t: 'dbg.res', req: m.req, from: m.to, to: m.from, part: 0, more: false, error: 'unreachable' });
      }
      this._prune();
      this.back.set(key, { id: sender, at: this.now() });
      m = { ...m, hops: hops + 1 };
      const line = `${this.nameOf(m.from)}→${this.nameOf(m.to)}`;
      if (!this.said.has(line)) {
        this.said.add(line);
        this.log(`[debug] passing on ${line} (through ${this.nameOf(next)})`);
      }
    }
    // Over Bluetooth only small answers (the piece itself decides; a request is small).
    if (answer && this.transportOf(next) === 'ble' && typeof m.bin === 'string' && m.bin.length > BLE_MAX) {
      return this._sendTo(next, { t: 'dbg.res', req: m.req, from: m.from, to: m.to, part: m.part, more: false, error: 'bluetooth' });
    }
    this._sendTo(next, m);
  }

  _prune() {
    const now = this.now();
    for (const [k, b] of this.back) if (now - b.at > BACK_MS) this.back.delete(k);
  }

  // In order per device, each message only while that socket has less than HIGH_WATER queued.
  _sendTo(id, msg) {
    const prev = this.queues.get(id) || Promise.resolve();
    const next = prev.then(async () => {
      for (let i = 0; i < 600 && this.queued(id) > HIGH_WATER; i++) await this.wait(50);
      this.bus.send(id, msg);
    }).catch(() => {});
    this.queues.set(id, next);
    next.then(() => { if (this.queues.get(id) === next) this.queues.delete(id); });
    return next;
  }

  // ---- answering ----

  _letIn(m, sender) {
    const ok = this.allowed();
    return ok.includes(m.from) && (sender === m.from || ok.includes(sender));
  }

  async _serve(m, sender) {
    const reply = (x) => this._sendTo(sender, { t: 'dbg.res', req: m.req, from: this.self, to: m.from, part: 0, more: false, ...x });
    const op = OPS.includes(m.op) ? m.op : null;
    if (!op) return reply({ error: 'unknown op' });
    const allowed = this._letIn(m, sender);
    const entry = { at: this.now(), from: m.from, op, ok: false, error: '' };
    if (op !== 'hello') this.log(`[debug] ${this.nameOf(m.from)} asked ${op}${allowed ? '' : ' (not let in)'}`);
    if (op !== 'hello' && !allowed) {
      entry.error = 'not allowed';
      this.onServed(entry);
      return reply({ error: 'not allowed' });
    }
    // Let in: acknowledged now, the answer follows when it's done (an older asker keeps the piece as part 0
    // without data, and waits for the rest as before).
    if (op !== 'hello') this._sendTo(sender, { t: 'dbg.res', req: m.req, from: this.self, to: m.from, part: 0, more: true, ack: true });
    const ble = this.transportOf(sender) === 'ble';
    if (op === 'shot' && ble) {
      entry.error = 'bluetooth';
      this.onServed(entry);
      return reply({ error: 'bluetooth' });
    }
    let out;
    try {
      out = await this._do(op, clean(m.args), { allowed, ble });
    } catch (e) {
      entry.error = String((e && (e.code || e.message)) || e).slice(0, 200);
      this.onServed(entry);
      return reply({ error: entry.error });
    }
    entry.ok = true;
    this.onServed(entry);
    const bin = out && Buffer.isBuffer(out.bin) ? out.bin : null;
    if (bin && ble && bin.length > BLE_MAX) return reply({ error: 'bluetooth' });
    if (!bin || bin.length <= PIECE) return reply({ data: out ? out.data : null, bin: bin && bin.length ? bin.toString('base64') : undefined });
    const key = `dbg:${m.req}`;
    this.hold(key, true);
    const release = setTimeout(() => this.hold(key, false), LIMIT_MS);
    if (release.unref) release.unref();
    try {
      for (let at = 0, part = 0; at < bin.length; at += PIECE, part++) {
        const end = Math.min(bin.length, at + PIECE);
        await this._sendTo(sender, {
          t: 'dbg.res', req: m.req, from: this.self, to: m.from, part, more: end < bin.length,
          ...(part === 0 ? { data: out.data } : {}), bin: bin.subarray(at, end).toString('base64'),
        });
      }
    } finally {
      clearTimeout(release);
      this.hold(key, false);
    }
  }

  // This computer's own tools, without the bus (the Debug tab's own device, the Local API's `self`).
  async _serveSelf(op, args) {
    const out = await this._do(op, clean(args), { allowed: true, ble: false, self: true });
    return { data: out ? out.data : null, bin: out && Buffer.isBuffer(out.bin) ? out.bin : null };
  }

  async _do(op, args, { allowed, ble, self }) {
    const L = this.local;
    switch (op) {
      case 'hello':
        return { data: { ...(await L.hello()), ops: OPS, allowed, anyCommand: !!this.anyCommand(), transport: ble ? 'ble' : 'ip' } };
      case 'status':
        return { data: await L.status() };
      case 'verbose':
        return { data: await L.verbose(args) };
      case 'files':
        return { data: (await L.files()).map(({ name, size }) => ({ name, size })) };
      case 'log':
        return this._log(args, ble);
      case 'shot':
        return L.shot(args);
      case 'diag':
        return { data: await L.diag(args) };
      case 'run':
        if (!self && !this.anyCommand()) throw err('any command is off');
        return { data: await L.run(args) };
      case 'restart':
        return { data: await L.restart(args) };
      default:
        throw err('unknown op');
    }
  }

  // {file, from?, len?, grep?, tail?}: a range of one of the files() (any byte offset; tail: its last
  // `tail` bytes); grep: the lines holding that text, from at most the last GREP_SCAN bytes.
  async _log(args, ble) {
    const files = await this.local.files();
    const f = files.find((x) => x.name === args.file);
    if (!f) throw err('no such log');
    const size = Number(f.size) || 0;
    const cap = ble ? BLE_MAX : OUT_MAX;
    let from;
    let len;
    if (typeof args.grep === 'string' && args.grep) {
      from = Math.max(0, size - GREP_SCAN);
      len = size - from;
    } else if (Number(args.tail) > 0) {
      len = Math.min(size, Number(args.tail));
      from = size - len;
    } else {
      from = Math.min(size, Math.max(0, Number(args.from) || 0));
      len = Math.min(size - from, Number(args.len) > 0 ? Number(args.len) : size - from);
    }
    len = Math.min(len, args.grep ? GREP_SCAN : cap);
    let buf = await this._read(f, from, len);
    if (args.grep) {
      const needle = String(args.grep).slice(0, 200);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.includes(needle));
      buf = Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''));
      if (buf.length > cap) buf = buf.subarray(buf.length - cap);
      return { data: { file: f.name, size, from, len, grep: needle, lines: lines.length }, bin: buf };
    }
    return { data: { file: f.name, size, from, len: buf.length }, bin: buf };
  }

  async _read(f, from, len) {
    if (!len) return Buffer.alloc(0);
    if (!f.path) return this.local.read(f.name, from, len);
    const fd = fs.openSync(f.path, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function err(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function remember(set, key) {
  set.add(key);
  if (set.size > SEEN_MAX) set.delete(set.values().next().value);
}

// What's asked is plain data, capped: strings to 4 KB, at most 20 keys, arrays of 20 short strings.
function clean(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  for (const k of Object.keys(a).slice(0, 20)) {
    const v = a[k];
    if (typeof v === 'string') out[k] = v.slice(0, 4096);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).filter((x) => typeof x === 'string').map((x) => x.slice(0, 64));
  }
  return out;
}

module.exports = { MeshDebug, OPS, PIECE, HIGH_WATER, MAX_HOPS, NO_ANSWER_MS, RETRY_MS, BLE_MAX };
