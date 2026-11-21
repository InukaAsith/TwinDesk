// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Opt-in desktop alerts for a connected phone's battery. No protocol of its own: the phone already
// sends battery and charging in phone.info. One alert per discharge cycle at or below 15% (not
// charging), and one per charge cycle when it reaches 100% while charging. Each cycle re-arms
// only after the level has left that zone. State belongs to one authenticated session
// (device id + session). A phone that connects already full and plugged in does not alert.
'use strict';

const LOW_AT = 15;
const LOW_REARM = 20;
const FULL_AT = 100;
const FULL_REARM = 95;

function idOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string' || !v || v.length > 200) return '';
  return v;
}

function sessionKey(sample) {
  const deviceId = idOf(sample && sample.deviceId);
  const sessionId = idOf(sample && sample.sessionId);
  return deviceId && sessionId ? `${deviceId}\0${sessionId}` : '';
}

// A level the phone could actually be at. Null, strings and out-of-range numbers are not a sample.
function batteryOf(sample) {
  const n = sample && sample.battery;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function chargingOf(sample) {
  return sample && typeof sample.charging === 'boolean' ? sample.charging : null;
}

function fresh() {
  return { lowLatched: false, fullLatched: false, fullReady: false };
}

class BatteryAlerts {
  constructor({ enabled = false, notify } = {}) {
    this.enabled = enabled === true;
    this._notify = typeof notify === 'function' ? notify : () => {};
    this._sessions = new Map();
  }

  setEnabled(on) {
    const next = on === true;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) this.reset();
  }

  // No argument: every phone. {deviceId} without a session: that phone's sessions.
  // {deviceId, sessionId}: that authenticated session only.
  reset(which) {
    if (which == null) {
      this._sessions.clear();
      return;
    }
    if (typeof which === 'string') {
      this._sessions.delete(which);
      return;
    }
    const deviceId = idOf(which.deviceId);
    if (!deviceId) return;
    if (which.sessionId == null || which.sessionId === '') {
      for (const key of [...this._sessions.keys()]) {
        if (key.startsWith(`${deviceId}\0`)) this._sessions.delete(key);
      }
      return;
    }
    this._sessions.delete(sessionKey(which));
  }

  // One phone.info sample for the session it names. Invalid levels change nothing.
  // Returns the alerts this sample produced.
  update(sample) {
    if (!this.enabled) return [];
    const key = sessionKey(sample);
    const battery = batteryOf(sample);
    const charging = chargingOf(sample);
    if (!key || battery == null || charging == null) return [];
    let st = this._sessions.get(key);
    if (!st) {
      st = fresh();
      this._sessions.set(key, st);
    }
    const alerts = [];
    if (st.lowLatched) {
      if (battery >= LOW_REARM || charging === true) st.lowLatched = false;
    } else if (battery <= LOW_AT && charging === false) {
      st.lowLatched = true;
      alerts.push(this._alert('low', sample, battery, charging));
    }
    const fullNow = charging === true && battery >= FULL_AT;
    if (fullNow) {
      if (st.fullReady && !st.fullLatched) {
        st.fullLatched = true;
        st.fullReady = false;
        alerts.push(this._alert('full', sample, battery, charging));
      }
    } else {
      // Re-arm only after leaving the full zone: unplugged, or down to 95%.
      if (st.fullLatched && (charging === false || battery <= FULL_REARM)) {
        st.fullLatched = false;
        st.fullReady = true;
      }
      // A connected phone that is already at 100% and plugged in has not been seen below full,
      // so the first full sample of the session does not alert.
      if (!st.fullLatched && battery < FULL_AT) st.fullReady = true;
    }
    for (const alert of alerts) {
      try { this._notify(alert); } catch { /* notification API missing or denied */ }
    }
    return alerts;
  }

  _alert(kind, sample, battery, charging) {
    return {
      kind,
      deviceId: idOf(sample.deviceId),
      sessionId: idOf(sample.sessionId),
      name: typeof sample.name === 'string' ? sample.name.slice(0, 80) : '',
      battery,
      charging,
    };
  }
}

// deviceId -> the authenticated session currently in that sample stream.
// resumeKey (or the socket ctx) keeps a path change of the same login from looking like a new one.
function createPhoneBatteryWatch({ getEnabled, notify } = {}) {
  const alerts = new BatteryAlerts({ notify });
  const ids = new WeakMap();
  let seq = 0;
  const current = new Map();

  function enabled() {
    return typeof getEnabled === 'function' && getEnabled() === true;
  }

  function sessionIdOf(ctx) {
    if (!ctx || typeof ctx !== 'object') return '';
    if (typeof ctx.sessionId === 'string' && ctx.sessionId) return ctx.sessionId;
    if (typeof ctx.resumeKey === 'string' && ctx.resumeKey) return ctx.resumeKey;
    if (Number.isFinite(ctx.connectedAt)) return `t${ctx.connectedAt}`;
    const keyObj = ctx.session && typeof ctx.session === 'object' ? ctx.session : ctx;
    let id = ids.get(keyObj);
    if (!id) {
      seq += 1;
      id = `s${seq}`;
      ids.set(keyObj, id);
    }
    return id;
  }

  function isLiveCtx(ctx) {
    return !!ctx && typeof ctx === 'object' && ctx.authed !== false && ctx.released !== true;
  }

  function syncEnabled() {
    alerts.setEnabled(enabled());
  }

  return {
    alerts,
    begin(ctx) {
      syncEnabled();
      if (!isLiveCtx(ctx) || typeof ctx.deviceId !== 'string' || !ctx.deviceId || ctx.deviceId.length > 200) return;
      const sessionId = sessionIdOf(ctx);
      const prev = current.get(ctx.deviceId);
      if (prev && prev.sessionId !== sessionId) alerts.reset(prev);
      current.set(ctx.deviceId, {
        deviceId: ctx.deviceId,
        sessionId,
        name: typeof ctx.name === 'string' ? ctx.name.slice(0, 80) : '',
      });
    },
    // A late close of the session that was replaced must not drop the one that replaced it.
    end(ctx) {
      if (!ctx || typeof ctx.deviceId !== 'string' || !ctx.deviceId) {
        alerts.reset();
        current.clear();
        return;
      }
      const prev = current.get(ctx.deviceId);
      if (!prev || prev.sessionId !== sessionIdOf(ctx)) return;
      alerts.reset(prev);
      current.delete(ctx.deviceId);
    },
    forget(deviceId) {
      if (typeof deviceId !== 'string' || !deviceId) return;
      alerts.reset({ deviceId });
      current.delete(deviceId);
    },
    reset() {
      alerts.reset();
      current.clear();
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    },
    info(info, ctx) {
      syncEnabled();
      if (!alerts.enabled || !isLiveCtx(ctx) || typeof ctx.deviceId !== 'string') return [];
      const s = current.get(ctx.deviceId);
      if (!s || s.sessionId !== sessionIdOf(ctx)) return [];
      if (typeof ctx.name === 'string' && ctx.name) s.name = ctx.name.slice(0, 80);
      return alerts.update({
        deviceId: s.deviceId,
        sessionId: s.sessionId,
        name: s.name,
        battery: info && info.battery,
        charging: info && info.charging,
      });
    },
    setting(on) {
      alerts.setEnabled(on === true);
    },
  };
}

const held = new Map();

// Native desktop notification. Keep it alive for the click handler even when show() returns.
function showDesktopNotification(alert, deps) {
  let drop;
  try {
    const Notification = deps && deps.Notification;
    const t = deps && typeof deps.t === 'function' ? deps.t : (s) => s;
    const onClick = deps && typeof deps.onClick === 'function' ? deps.onClick : null;
    if (!alert || (alert.kind !== 'low' && alert.kind !== 'full')) return false;
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return false;
    const name = typeof alert.name === 'string' && alert.name ? alert.name.slice(0, 80) : t('Phone');
    const percent = alert.battery;
    const title = alert.kind === 'full' ? t('{name} is fully charged', { name }) : t('{name} battery is low', { name });
    const body = alert.kind === 'full' ? t('Battery is at {percent}%', { percent }) : t('{percent}% and not charging', { percent });
    const n = new Notification({ title, body });
    drop = () => {
      clearTimeout(held.get(n));
      held.delete(n);
    };
    if (typeof n.on === 'function') {
      n.on('close', drop);
      n.on('failed', drop);
      if (onClick) {
        n.on('click', () => {
          drop();
          try { onClick(alert); } catch { /* window unavailable */ }
        });
      }
    }
    const timer = setTimeout(drop, 60000);
    held.set(n, timer);
    timer.unref?.();
    n.show();
    return true;
  } catch {
    if (drop) drop();
    return false;
  }
}

module.exports = {
  BatteryAlerts,
  createPhoneBatteryWatch,
  showDesktopNotification,
  showMacNotification: showDesktopNotification,
  LOW_AT,
  LOW_REARM,
  FULL_AT,
  FULL_REARM,
};
