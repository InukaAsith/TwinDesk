// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { ANDROID } = require('./android-keys.js');
const { OS } = require('../shared/protocol.js');
const { displayIdOf } = require('../shared/appstart.js');

const UNLOCK_MS = 60000;
const APP_START_MS = 6000;
const ADB_READ_MS = 1800;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A control session targets the physical phone. Virtual-display sessions are for app video.
class AppPanel {
  constructor(bridge, server) {
    this.bridge = bridge;
    this.server = server;
    this.current = null;
  }

  capture() {
    const { bridge, server } = this;
    const phone = server.current;
    const owner = { socket: phone?.conn || phone?.ws, id: phone?.deviceId, control: bridge.control };
    return this.matches(owner) ? owner : null;
  }

  matches(owner) {
    const phone = this.server.current;
    const { id, socket, control } = owner;
    return !!(id && socket && control && phone?.deviceId === id && phone.os === OS.ANDROID && phone.authed === true
      && !phone.released && (phone.conn || phone.ws) === socket && socket.readyState === 1
      && this.bridge.control === control && this.bridge.serial === control.serial && !control.closed);
  }

  wake(owner) {
    if (!this.matches(owner)) return false;
    owner.control.tap(ANDROID.WAKEUP);
    return true;
  }

  begin(view) {
    if (!this.owns(this.current)) {
      this.release();
      const owner = this.capture();
      if (!owner) return null;
      this.current = { ...owner, views: new Set(), off: false, wakeSent: false, manual: false };
    }
    this.current.views.add(view);
    return this.current;
  }

  owns(lease) {
    return !!lease && this.current === lease && this.matches(lease);
  }

  retry(lease) {
    if (this.owns(lease)) lease.wakeSent = false;
  }

  async waitUnlocked(lease, live, waitingForUnlock) {
    const { adb, serial } = lease.control;
    const deadline = Date.now() + UNLOCK_MS;
    let warned = false;
    while (live() && this.owns(lease) && Date.now() < deadline) {
      const [power, policy] = await Promise.all([
        adb.shell(serial, 'dumpsys power', { timeout: ADB_READ_MS }),
        adb.shell(serial, 'dumpsys window policy', { timeout: ADB_READ_MS }),
      ]);
      if (!live() || !this.owns(lease)) return false;
      const awake = power.code === 0 && /\bmWakefulness=Awake\b/.test(power.out);
      const sleeping = power.code === 0 && /\bmWakefulness=(?:Asleep|Dozing|Dreaming)\b/.test(power.out);
      const keyguard = policy.code === 0 && /KeyguardServiceDelegate\s+showing=(true|false)\b/.exec(policy.out)?.[1];
      if ((!awake && !sleeping) || !keyguard) return false;
      // A display-off scrcpy controller otherwise blanks again when it handles WAKEUP.
      if (lease.off && (sleeping || keyguard === 'true')) this.restore();
      if (awake && keyguard === 'false') {
        const trust = await adb.shell(serial, 'dumpsys trust', { timeout: ADB_READ_MS });
        if (!live() || !this.owns(lease)) return false;
        const locked = trust.code === 0 && /^\s*User .*\(current\):[^\n]*\bdeviceLocked=([01])\b/m.exec(trust.out)?.[1];
        if (!locked) return false;
        if (locked === '0') {
          lease.wakeSent = false;
          return true;
        }
      }
      if (sleeping && !lease.wakeSent) {
        lease.wakeSent = true;
        this.wake(lease);
      }
      if (awake && !warned) {
        warned = true;
        waitingForUnlock();
      }
      await pause(500);
    }
    return false;
  }

  async waitForApp(session, pkg, live) {
    // scrcpy uses this exact virtual display. Poll only the requested package's task listing.
    if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(pkg)) return false;
    const deadline = Date.now() + APP_START_MS;
    while (live() && Date.now() < deadline) {
      const id = displayIdOf(session.log);
      if (Number.isSafeInteger(id) && id > 0) {
        const r = await session.adb.shell(session.serial, `dumpsys activity activities ${pkg}`, { timeout: ADB_READ_MS });
        if (!live()) return false;
        const display = r.code === 0 && r.out.split(/(?=^Display #)/m).find((block) => block.startsWith(`Display #${id} `));
        if (display && display.split('\n').some((line) => line.includes('ActivityRecord{') && line.includes(` ${pkg}/`))) return true;
      }
      await pause(275);
    }
    return false;
  }

  get off() {
    return this.owns(this.current) && this.current.off;
  }

  blank(lease, view) {
    if (!this.owns(lease) || !lease.views.has(view) || lease.off || lease.manual) return false;
    this._blank(lease);
    return true;
  }

  toggle() {
    const lease = this.current;
    if (!this.owns(lease)) return false;
    lease.manual = true;
    if (lease.off) this.restore();
    else this._blank(lease);
    return true;
  }

  _blank(lease) {
    lease.control.setDisplayPower(false);
    lease.off = true;
  }

  remove(view) {
    const lease = this.current;
    if (!lease || !lease.views.delete(view) || lease.views.size) return false;
    return this.release();
  }

  restore() {
    const lease = this.current;
    if (!lease?.off) return false;
    lease.off = false;
    // Always restore through the original physical controller, never through the replacement.
    if (!lease.control.closed && this.bridge.control === lease.control && this.bridge.serial === lease.control.serial) {
      lease.control.setDisplayPower(true);
    }
    return true;
  }

  release() {
    const restored = this.restore();
    this.current = null;
    return restored;
  }
}

module.exports = { AppPanel };
