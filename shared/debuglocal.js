// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's debug tools (Debug tab, shared/meshdebug.js; docs/debug.md), each platform's way:
//   hello()    who this is: name, version, os, edition, uptime
//   status()   a snapshot of everything that tells why a link or a crossing failed, from the parts each
//              platform's main.js registers (part(name, fn)): sessions, lanes, kvm, graph, Full KVM, quiet…
//   verbose()  Debug › Verbose log (shared/applog.js), saved so it outlives a restart until its time is up
//   files()    the logs: TwinDesk.log (.1, .2), crash.log (.1), link-stats.log, and the Full KVM service's
//              (read through the service: it's for administrators only on disk)
//   shot()     a PNG of each display: Electron's desktopCapturer (Windows, X11, the Mac with Screen
//              Recording), on Wayland an installed tool (spectacle, grim, gnome-screenshot): the portal
//              would ask the person each time
//   diag()     one of the fixed diagnostics (DIAGS): network, adapter power, sleep/wake and system events,
//              reaching a device of the mesh, sockets, firewall, processes, Full KVM. execFile with
//              argument lists, no shell; on Windows the app's own scripts (windows/ps.js); a missing tool
//              is left out
//   run()      any command, as this user (only while Allow any command is on: meshdebug.js checks)
//   restart()  TwinDesk, or the Full KVM service
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const OUT_MAX = 1024 * 1024; // a diagnostic's or command's output, at most
const DIAG_MS = 60000;
const RUN_MAX_MS = 120000;
const LOGS = ['TwinDesk.log', 'TwinDesk.1.log', 'TwinDesk.2.log', 'crash.log', 'crash.1.log', 'link-stats.log', 'link-stats.1.log'];

const which = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => {
  try { return fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; }
});

// Windows' console tools (ipconfig, tasklist, netstat, cmd itself) write in the OEM code page, not UTF-8,
// even after chcp 65001: they're started without a console (Ryzen9, Spanish: 'Configuraci�n'). What
// isn't UTF-8 is read in that code page: 437 and 850 here, 866 by TextDecoder; others stay UTF-8.
const OEM = {
  437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0',
  850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0',
};
let oemPage = null; // Windows: the OEM code page, asked once (chcp's number)

function oemCodePage() {
  if (oemPage === null) {
    oemPage = 0;
    try {
      const out = require('child_process').execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, timeout: 5000 });
      oemPage = Number((String(out).match(/(\d+)\s*$/) || [])[1]) || 0;
    } catch (_) { /* stays 0: UTF-8 */ }
  }
  return oemPage;
}

function decode(buf, platform = process.platform, page = null) {
  if (!buf || !buf.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { /* not UTF-8 */ }
  if (platform === 'win32') {
    const cp = page || oemCodePage();
    if (OEM[cp]) { let s = ''; for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : OEM[cp][b - 0x80]; return s; }
    if (cp === 866) return new TextDecoder('ibm866').decode(buf);
  }
  return buf.toString('utf8');
}

// -> {code, out}: stdout and stderr together, capped; never throws (a missing tool is its error text).
function exec(cmd, args, { timeout = DIAG_MS, shell = false, verbatim = false } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: OUT_MAX * 2, shell, encoding: 'buffer', windowsVerbatimArguments: verbatim }, (err, stdoutB, stderrB) => {
      const stdout = decode(stdoutB);
      const stderr = decode(stderrB);
      let out = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
      if (err && !out) out = err.killed ? `(timed out after ${Math.round(timeout / 1000)} s)` : String(err.message || err);
      if (out.length > OUT_MAX) out = out.slice(0, OUT_MAX) + '\n(cut at 1 MB)';
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : err.killed ? 'timeout' : 1) : 0, out });
    });
  });
}

// Each diagnostic: label, and for each OS the commands (each [cmd, args] or a function of the request).
// {peer}: the address and port of a device of the mesh, from the hub's own list (never free text).
const DIAGS = {
  network: {
    label: 'Network: addresses, routes, Wi-Fi',
    win32: [['ipconfig', ['/all']], ['netsh', ['wlan', 'show', 'interfaces']]],
    linux: [['ip', ['-br', 'addr']], ['ip', ['route']], ['nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev']]],
    darwin: [['ifconfig', []], ['networksetup', ['-getinfo', 'Wi-Fi']]],
  },
  'adapter-power': {
    label: 'Network adapters: power saving',
    win32: [{ ps: 'debug-adapter-power' }],
    linux: [{ wifiPower: true }, ['ethtool', ['--show-eee', '__first_ethernet__']]],
    darwin: [['pmset', ['-g']]],
  },
  events: {
    label: 'Sleep, wake and network events (last hours)',
    win32: [{ ps: 'debug-events', hours: true }],
    // systemd's journal; without systemd (OpenRC: Gentoo, Alpine, nitro), the syslog file when it's readable.
    linux: [{ any: [(a) => ['journalctl', ['-b', '--no-pager', '-q', '-o', 'short-iso', '--since', `-${a.hours}h`, '-u', 'NetworkManager', '-u', 'systemd-logind', '-u', 'systemd-suspend', '-u', 'wpa_supplicant', '-u', 'iwd']]], syslog: true }],
    // pmset's own Sleep, Wake and DarkWake lines (its third column), not the Assertions that name a Sleep.
    darwin: [(a) => ['pmset', ['-g', 'log']], { filter: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4} (Sleep|Wake|DarkWake|Wake Requests)\s/, since: true }],
  },
  reach: {
    label: 'Reach a device of the mesh',
    needsPeer: true,
    win32: [(a) => ['ping', ['-n', '3', a.peer.address]], { tcp: true }],
    linux: [(a) => ['ping', ['-c', '3', '-W', '2', a.peer.address]], { tcp: true }],
    darwin: [(a) => ['ping', ['-c', '3', '-t', '6', a.peer.address]], { tcp: true }],
  },
  sockets: {
    label: 'TwinDesk’s sockets',
    win32: [['netstat', ['-ano', '-p', 'TCP']], { filterPid: true }],
    linux: [['ss', ['-tunp']], { filter: /TwinDesk|twindesk|electron|macshare/i }],
    darwin: [['lsof', ['-i', '-nP']], { filter: /TwinDesk/i }],
  },
  firewall: {
    label: 'Firewall',
    win32: [{ ps: 'firewall-status', exe: true }],
    linux: [{ any: [['firewall-cmd', ['--list-all']], ['ufw', ['status', 'verbose']]], none: 'no firewall-cmd or ufw (nftables and iptables need root to read)' }],
    darwin: [['/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']]],
  },
  processes: {
    label: 'TwinDesk’s processes',
    // Without /v: with it tasklist asks every window its title, 8 to 10 s (Ryzen9, AMXLPDL).
    win32: [['tasklist', ['/fo', 'csv', '/fi', 'imagename eq TwinDesk*']], ['tasklist', ['/fi', 'imagename eq twindesk-fullkvm*']]],
    linux: [['ps', ['-eo', 'pid,ppid,user,etime,rss,args']], { filter: /twindesk|TwinDesk|macshare/i }],
    darwin: [['ps', ['-axo', 'pid,ppid,user,etime,rss,args']], { filter: /TwinDesk/i }],
  },
  fullkvm: {
    label: 'Full KVM service',
    win32: [{ fullkvm: true }],
    linux: [{ any: [['systemctl', ['status', '--no-pager', '-n', '20', 'twindesk-fullkvm']], ['rc-service', ['twindesk-fullkvm', 'status']]] }, { fullkvm: true }],
  },
};

class DebugLocal {
  // app: Electron's app; applog: shared/applog.js; name(): this device's name; edition(): 'full' | ….
  // saveVerbose({tags, until}): kept in multi.json; peers(): [{id, name, address, port}] (the hub's).
  // service: {list() -> Promise<[{name, size}]>, read(name, from, len) -> Promise<Buffer>} | null: the Full
  // KVM service's logs ('service'; on Windows 'service-node' too), read through the service.
  // fullkvm: {state() -> Promise<{}>} | null (the Full KVM edition only). ps: windows/ps.js's script() (Windows).
  // electron: {desktopCapturer, screen} (tests leave it out).
  constructor(opts) {
    Object.assign(this, {
      platform: process.platform,
      name: () => os.hostname(),
      edition: () => '',
      saveVerbose: () => {},
      peers: () => [],
      service: null,
      fullkvm: null,
      ps: null,
      electron: null,
      startedAt: Date.now(),
    }, opts);
    this.parts = new Map();
  }

  part(name, fn) {
    this.parts.set(name, fn);
    return this;
  }

  async hello() {
    return {
      name: this.name(),
      version: this.app ? this.app.getVersion() : '',
      os: this.platform,
      edition: this.edition(),
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      diags: this.diagNames(),
    };
  }

  // Every part, each on its own: one that throws is its error, not the whole snapshot's.
  async status() {
    const out = {
      at: new Date().toISOString(),
      process: {
        uptime: Math.round((Date.now() - this.startedAt) / 1000),
        pid: process.pid,
        rss: process.memoryUsage().rss,
        system: { platform: this.platform, release: os.release(), uptime: Math.round(os.uptime()), loadavg: os.loadavg() },
      },
      verbose: this.applog ? this.applog.verboseState() : null,
    };
    for (const [name, fn] of this.parts) {
      try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; }
    }
    return out;
  }

  async verbose({ tags, minutes }) {
    const until = Date.now() + Math.max(0, Math.min(120, Number(minutes) || 0)) * 60000;
    const state = this.applog.verbose(Array.isArray(tags) ? tags : [], until);
    try { this.saveVerbose(state); } catch (_) { /* in memory still */ }
    return state;
  }

  // The logs there are (with their sizes), and the Full KVM service's when it answers.
  async files() {
    const dir = this.applog ? this.applog.dir() : '';
    const out = [];
    for (const name of LOGS) {
      try {
        const p = path.join(dir, name);
        out.push({ name, path: p, size: fs.statSync(p).size });
      } catch (_) { /* not there */ }
    }
    if (this.service) {
      try { out.push(...(await this.service.list())); } catch (_) { /* not installed, not running */ }
    }
    return out;
  }

  read(name, from, len) {
    if (/^service/.test(name) && this.service) return this.service.read(name, from, len);
    return Promise.reject(new Error('no such log'));
  }

  // ---- screenshot ----

  async shot({ display } = {}) {
    const wayland = this.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
    if (wayland) return this._waylandShot();
    const el = this.electron || require('electron');
    const displays = el.screen.getAllDisplays();
    const big = displays.reduce((m, d) => ({
      width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)),
      height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)),
    }), { width: 0, height: 0 });
    const sources = await el.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: big });
    if (!sources.length) throw new Error(this.platform === 'darwin' ? 'no screen: Screen Recording isn’t allowed for TwinDesk' : 'no screen');
    // One display (display: its index), or the first one; the list says how many there are.
    const i = Math.max(0, Math.min(sources.length - 1, Number(display) || 0));
    const png = sources[i].thumbnail.toPNG();
    if (!png.length) throw new Error('an empty picture (Screen Recording isn’t allowed?)');
    const size = sources[i].thumbnail.getSize();
    return { data: { display: i, displays: sources.length, width: size.width, height: size.height, names: sources.map((s) => s.name) }, bin: png };
  }

  async _waylandShot() {
    const file = path.join(os.tmpdir(), `twindesk-shot-${process.pid}-${Date.now()}.png`);
    const tools = [
      ['spectacle', ['-b', '-n', '-f', '-o', file]],
      ['grim', [file]],
      ['gnome-screenshot', ['-f', file]],
    ].filter(([c]) => which(c));
    if (!tools.length) throw new Error('wayland: no screenshot tool (spectacle, grim or gnome-screenshot)');
    try {
      const [cmd, args] = tools[0];
      const r = await exec(cmd, args, { timeout: 20000 });
      if (!fs.existsSync(file)) throw new Error(`${cmd}: ${r.out.trim().split('\n')[0] || 'no picture'}`);
      return { data: { display: 0, displays: 1, tool: cmd }, bin: fs.readFileSync(file) };
    } finally {
      try { fs.unlinkSync(file); } catch (_) { /* never written */ }
    }
  }

  // ---- diagnostics ----

  diagNames() {
    return Object.entries(DIAGS)
      .filter(([name, d]) => d[this.platform] && (name !== 'fullkvm' || this.fullkvm))
      .map(([name, d]) => ({ name, label: d.label, peer: !!d.needsPeer }));
  }

  // {name, peer?: a device id or name of the mesh, hours?: 1..48} -> {name, out}
  async diag({ name, peer, hours }) {
    const d = DIAGS[name];
    const steps = d && d[this.platform];
    if (!steps || (name === 'fullkvm' && !this.fullkvm)) throw new Error('no such diagnostic here');
    const a = { hours: Math.max(1, Math.min(48, Number(hours) || 3)) };
    if (d.needsPeer) {
      a.peer = this.peers().find((p) => p.id === peer || p.name === peer);
      if (!a.peer || !a.peer.address) throw new Error('that device has no address here');
      a.peer = { ...a.peer, address: String(a.peer.address).replace(/:\d+$/, '') };
    }
    const parts = [];
    let filter = null;
    let since = false;
    for (const step of steps) {
      if (!Array.isArray(step) && step.filter instanceof RegExp) { filter = step.filter; since = !!step.since; continue; }
      if (!Array.isArray(step) && step.filterPid) { filter = new RegExp(`\\s(${process.pid}|${process.ppid})\\s*$`, 'm'); continue; }
      parts.push(await this._step(step, a));
    }
    let out = parts.join('\n');
    if (filter) out = out.split('\n').filter((l) => filter.test(l) || /^\$ /.test(l)).join('\n');
    // since: lines that start with their time, only those of the last hours
    if (since) {
      const from = Date.now() - a.hours * 3600000;
      out = out.split('\n').filter((l) => { const t = Date.parse(l.slice(0, 25).replace(' ', 'T').replace(/ ([+-]\d\d)(\d\d)$/, '$1:$2')); return !(t < from); }).join('\n');
    }
    // Nothing but the commands' own lines: say so (a Mac kept awake has no Sleep or Wake at all).
    if ((filter || since) && !out.split('\n').some((l) => l.trim() && !/^\$ /.test(l))) out += `\n(nothing of this in the last ${a.hours} h)`;
    return { name, out: out.length > OUT_MAX ? out.slice(0, OUT_MAX) : out };
  }

  async _step(step, a) {
    if (typeof step === 'function') step = step(a);
    if (Array.isArray(step)) {
      let [cmd, args] = step;
      if (args.includes('__first_ethernet__')) {
        const eth = Object.keys(os.networkInterfaces()).find((n) => /^(en|eth)/.test(n));
        if (!eth) return '$ ethtool: no wired adapter';
        args = args.map((x) => (x === '__first_ethernet__' ? eth : x));
      }
      if (!path.isAbsolute(cmd) && this.platform !== 'win32' && !which(cmd)) return `$ ${cmd}: not installed`;
      const r = await exec(cmd, args);
      return `$ ${cmd} ${args.join(' ')}\n${r.out.trimEnd()}${r.code ? `\n(exit ${r.code})` : ''}`;
    }
    if (step.any) { // the first of these that's installed
      for (let one of step.any) {
        if (typeof one === 'function') one = one(a);
        if (path.isAbsolute(one[0]) || which(one[0])) return this._step(one, a);
      }
      if (step.syslog) return this._syslog(a.hours);
      return `$ ${step.none || step.any.map((x) => (typeof x === 'function' ? x(a) : x)[0]).join(', ') + ': not installed'}`;
    }
    if (step.ps) {
      if (!this.ps) return `$ ${step.ps}: no PowerShell here`;
      const args = {};
      if (step.hours) args.Hours = a.hours;
      if (step.exe) args.Exe = process.execPath;
      try { return `$ ${step.ps}\n${(await this.ps(step.ps, args, DIAG_MS)).trimEnd()}`; } catch (e) { return `$ ${step.ps}\n${e.message}`; }
    }
    if (step.wifiPower) {
      const wl = Object.keys(os.networkInterfaces()).find((n) => /^(wl|wlan)/.test(n));
      if (!wl) return '$ iw: no Wi-Fi adapter';
      if (!which('iw')) return '$ iw: not installed';
      const r = await exec('iw', ['dev', wl, 'get', 'power_save']);
      return `$ iw dev ${wl} get power_save\n${r.out.trimEnd()}`;
    }
    if (step.tcp) return this._tcp(a.peer.address, a.peer.port);
    if (step.fullkvm) {
      if (!this.fullkvm) return '$ Full KVM: not on this computer';
      try { return `$ Full KVM state\n${JSON.stringify(await this.fullkvm.state(), null, 1)}`; } catch (e) { return `$ Full KVM state\n${e.message}`; }
    }
    return '';
  }

  // Without systemd: the system log's lines on the network, sleep and wake, from its last part (a syslog
  // file has no year and often no zone: the last SYSLOG_TAIL lines stand in for the last hours).
  _syslog(hours) {
    const file = ['/var/log/syslog', '/var/log/messages'].find((f) => { try { fs.accessSync(f, fs.constants.R_OK); return true; } catch (_) { return false; } });
    if (!file) return '$ events: no journalctl, and the system log isn\u2019t readable';
    const SYSLOG_TAIL = 4 * 1024 * 1024;
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const len = Math.min(size, SYSLOG_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Containers' virtual adapters (docker0, br-…, veth…) come and go with every container: not the network.
    const skip = /\b(veth[0-9a-f]+|docker\d|br-[0-9a-f]{12})\b/;
    const want = /NetworkManager|wpa_supplicant|iwd|dhcpcd|dhclient|elogind|logind|suspend|resum|PM: |ACPI|wlan|wlp|enp|eth\d|carrier|link (is )?(up|down)|twindesk/i;
    // A line's time: ISO (rsyslog's high-precision format) or 'Nov 26 08:19:01' in this year (or last year's,
    // when that would be in the future); a line without one stays.
    const since = Date.now() - hours * 3600000;
    const year = new Date().getFullYear();
    const timeOf = (l) => {
      if (/^\d{4}-\d\d-\d\dT/.test(l)) return Date.parse(l.slice(0, 32).split(' ')[0]);
      let t = Date.parse(`${l.slice(0, 15)} ${year}`);
      if (t > Date.now() + 86400000) t = Date.parse(`${l.slice(0, 15)} ${year - 1}`);
      return t;
    };
    const lines = text.split('\n').filter((l) => {
      if (!want.test(l) || skip.test(l)) return false;
      const t = timeOf(l);
      return !Number.isFinite(t) || t >= since;
    });
    return `$ ${file} (the network, sleep and wake, the last ${hours} h)\n${lines.slice(-2000).join('\n')}`;
  }

  _tcp(host, port) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const s = net.connect({ host, port, timeout: 5000 });
      const end = (what) => { s.destroy(); resolve(`$ connect ${host}:${port}\n${what}`); };
      s.on('connect', () => end(`connected in ${Date.now() - t0} ms`));
      s.on('timeout', () => end('no answer in 5 s'));
      s.on('error', (e) => end(e.code || e.message));
    });
  }

  // ---- any command, restart ----

  // As this user, through the system's shell; at most RUN_MAX_MS; output capped.
  async run({ cmd, timeout }) {
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('no command');
    console.log(`[debug] running: ${cmd.slice(0, 500)}`);
    const ms = Math.max(1000, Math.min(RUN_MAX_MS, (Number(timeout) || 30) * 1000));
    // cmd.exe reads its own command line: /s /c "…" as it is (Node's \" escaping of the quotes inside isn't
    // cmd's: tasklist /fi "imagename eq x" came out as an argument "eq").
    const r = this.platform === 'win32'
      ? await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { timeout: ms, verbatim: true })
      : await exec(this.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', ['-c', cmd], { timeout: ms });
    return { cmd, code: r.code, out: r.out };
  }

  // Answers first (meshdebug sends it), then does it.
  // Only the app: the Full KVM service needs an administrator to restart it (UAC, pkexec), and nobody may
  // be at that computer to say yes.
  async restart({ what }) {
    if (what !== 'app') throw new Error('restart: only the app');
    console.log('[debug] restarting TwinDesk (asked through Debug)');
    setTimeout(() => { this.app.relaunch(); this.app.exit(0); }, 1500);
    return { restarting: 'app' };
  }
}

module.exports = { decode, DebugLocal, DIAGS, exec };
