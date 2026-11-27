// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Lock together (#322, settings.app.lockTogether, off): this computer locked, the connected
// computers lock too, and the other way round. Both ends must have it on: the one that locks says so
// (lock.now), the one that hears it locks only with its own switch on. A lock that came from another
// computer isn't passed on again (QUIET_MS), so two computers never lock each other in a loop.
//   lock.now {}   to each connected computer (not phones): this one just locked
// Locked, as each system tells it: Electron's powerMonitor 'lock-screen' (macOS, Windows); on Linux,
// logind's LockedHint of this session (gdbus monitor on the system bus; GNOME, KDE, Cinnamon and others set
// it), and powerMonitor too where it fires. Locking: the Deck's lock (shared/deck-sys.js: the helper's
// LockWorkStation on Windows, SACLockScreenImmediate on the Mac, loginctl lock-session on Linux).
//   const ls = new LockSync({ platform: 'mac'|'win'|'linux', helper, enabled: () => bool, send(msg) })
//   ls.start(); bus.on('lock.now', () => ls.onMessage());
'use strict';

const T_LOCK = 'lock.now';
const QUIET_MS = 15000; // after a lock asked by another computer, our own lock event is that lock
const SAME_MS = 3000; // one lock, told twice (logind and powerMonitor): once

class LockSync {
  constructor({ platform, helper, enabled, send, log, now, powerMonitor, spawn, lockNow, env }) {
    Object.assign(this, { platform, helper, enabled, send, log: log || ((l) => console.log(l)), now: now || Date.now });
    this.powerMonitor = powerMonitor || null;
    this.spawn = spawn || null;
    this.env = env || process.env;
    this.lockNow = lockNow || (() => require('./deck-sys.js').sys(platform, { helper, press: () => {} }).sys('lock'));
    this.remoteAt = 0;
    this.lockedAt = 0;
    this.proc = null;
  }

  start() {
    try {
      const pm = this.powerMonitor || require('electron').powerMonitor;
      pm.on('lock-screen', () => this.onLocked('system'));
    } catch (_) { /* not in Electron (tests) */ }
    if (this.platform === 'linux') this._logind();
    return this;
  }

  // This computer locked (by its person, or because another one asked).
  onLocked(how = '') {
    const t = this.now();
    if (t - this.lockedAt < SAME_MS) return;
    this.lockedAt = t;
    if (!this.enabled()) return;
    if (t - this.remoteAt < QUIET_MS) return; // the lock another computer asked for: not passed on
    this.log(`[lock] this computer locked${how ? ` (${how})` : ''}: the others lock too (Lock together)`);
    this.send({ t: T_LOCK });
  }

  // Another computer locked.
  onMessage(from = '') {
    if (!this.enabled()) return this.log(`[lock] ${from || 'the other computer'} locked; Lock together is off here`);
    this.remoteAt = this.now();
    this.log(`[lock] ${from || 'the other computer'} locked: locking this one (Lock together)`);
    Promise.resolve().then(() => this.lockNow()).catch((e) => this.log(`[lock] couldn’t lock: ${(e && e.message) || e}`));
  }

  // logind's LockedHint for this session: gdbus monitor prints each PropertiesChanged of its object.
  _logind() {
    const id = String(this.env.XDG_SESSION_ID || '');
    if (!id) return this.log('[lock] no XDG_SESSION_ID: Lock together hears powerMonitor only here');
    const object = '/org/freedesktop/login1/session/' + escapePath(id);
    const spawn = this.spawn || require('child_process').spawn;
    let p;
    try {
      p = spawn('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.login1', '--object-path', object], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return this.log(`[lock] gdbus monitor: ${e.message}`);
    }
    this.proc = p;
    p.on('error', (e) => this.log(`[lock] gdbus monitor: ${e.message}`));
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (/'LockedHint':\s*<true>/.test(line)) this.onLocked('logind');
      }
    });
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* gone */ } }
    this.proc = null;
  }
}

// logind's object path for a session id: a leading digit and anything not [A-Za-z0-9] as _XX (hex).
function escapePath(id) {
  return [...id].map((c, i) => (/[A-Za-z0-9]/.test(c) && !(i === 0 && /[0-9]/.test(c)) ? c : '_' + c.charCodeAt(0).toString(16).padStart(2, '0'))).join('');
}

module.exports = { LockSync, T_LOCK, QUIET_MS, escapePath };
