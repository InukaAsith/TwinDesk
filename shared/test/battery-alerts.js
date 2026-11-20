// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone battery alerts (shared/battery-alerts.js): off until asked, one low alert per discharge,
// one full alert per charge, no repeat of the same sample, and a new session starts clean.
// Run with: node shared/test/battery-alerts.js
'use strict';

const assert = require('assert');
const { mock } = require('node:test');
const { BatteryAlerts, createPhoneBatteryWatch, showDesktopNotification, showMacNotification } = require('../battery-alerts.js');

function sample(over) {
  return { deviceId: 'phone-a', sessionId: 'sess-1', name: 'Pixel', battery: 50, charging: false, ...over };
}

function kinds(list) {
  return list.map((a) => a.kind);
}

// Off by default: samples are ignored and do not arm a later alert.
{
  const seen = [];
  const alerts = new BatteryAlerts({ notify: (a) => seen.push(a) });
  assert.strictEqual(alerts.enabled, false);
  assert.deepStrictEqual(alerts.update(sample({ battery: 10, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: 80, charging: true })), []);
  alerts.setEnabled(true);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), [], 'a full phone plugged in before the switch was on does not alert');
  assert.deepStrictEqual(seen, []);
}

// Low battery: once at <= 15% while not charging. Re-arm at >= 20% or when charging starts.
{
  const alerts = new BatteryAlerts({ enabled: true });
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 16, charging: false }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 15, charging: false }))), ['low']);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 15, charging: false }))), [], 'the same low sample does not repeat');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 14, charging: false }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 19, charging: false }))), [], 'still in the low zone');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 20, charging: false }))), [], '20% re-arms without alerting');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 15, charging: false }))), ['low']);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 12, charging: true }))), [], 'plugging in re-arms and does not alert');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 12, charging: false }))), ['low'], 'unplugging again is a new discharge');
  const chargingFirst = new BatteryAlerts({ enabled: true });
  assert.deepStrictEqual(kinds(chargingFirst.update(sample({ battery: 10, charging: true }))), []);
  assert.deepStrictEqual(kinds(chargingFirst.update(sample({ battery: 10, charging: false }))), ['low']);
}

// Full battery: only after this session has seen a level below 100%. Already full and plugged in is quiet.
{
  const alerts = new BatteryAlerts({ enabled: true });
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), [], 'the same full sample does not repeat');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: false }))), [], 'unplugging an already-full phone does not by itself arm');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 90, charging: true }))), []);
  const full = alerts.update(sample({ battery: 100, charging: true }));
  assert.deepStrictEqual(kinds(full), ['full']);
  assert.strictEqual(full[0].name, 'Pixel');
  assert.strictEqual(full[0].battery, 100);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 96, charging: true }))), [], '96% is still in the full zone');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 95, charging: true }))), [], '95% re-arms');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), ['full']);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: false }))), [], 'unplugging re-arms');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), ['full'], 'plugging a full phone back in is the next charge cycle');
}

// A discharge that was seen below 100% can finish at full, including one that was not charging yet.
{
  const alerts = new BatteryAlerts({ enabled: true });
  alerts.update(sample({ battery: 40, charging: false }));
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 100, charging: true }))), ['full']);
}

// Invalid levels and a missing session are ignored, and they do not disturb a cycle in progress.
{
  const alerts = new BatteryAlerts({ enabled: true });
  assert.deepStrictEqual(alerts.update(sample({ battery: null, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: undefined, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: NaN, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: '15', charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: 101, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: -1, charging: false })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: 10, charging: 'false' })), []);
  assert.deepStrictEqual(alerts.update(sample({ battery: 10, charging: 0 })), []);
  assert.deepStrictEqual(alerts.update({ battery: 10, charging: false, name: 'Pixel' }), [], 'no session');
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 10, charging: false }))), ['low']);
  assert.deepStrictEqual(alerts.update(sample({ battery: null, charging: false })), []);
  assert.deepStrictEqual(kinds(alerts.update(sample({ battery: 9, charging: false }))), [], 'the invalid sample did not clear the latch');
}

// Another phone, a new session, and a late close of the old one.
{
  let on = true;
  const seen = [];
  const watch = createPhoneBatteryWatch({ getEnabled: () => on, notify: (a) => seen.push(a.kind) });
  const pixel = { deviceId: 'pixel', resumeKey: 'aaa', name: 'Pixel' };
  const pixelAgain = { deviceId: 'pixel', resumeKey: 'bbb', name: 'Pixel' };
  const galaxy = { deviceId: 'galaxy', resumeKey: 'aaa', name: 'Galaxy' };
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, pixel), [], 'info before the authenticated session is ignored');
  watch.begin(pixel);
  assert.deepStrictEqual(kinds(watch.info({ battery: 5, charging: false }, pixel)), ['low']);
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, pixel), []);
  watch.begin(galaxy);
  assert.deepStrictEqual(kinds(watch.info({ battery: 5, charging: false }, galaxy)), ['low'], 'the other phone has its own cycle');
  assert.deepStrictEqual(watch.info({ battery: 4, charging: false }, pixel), [], 'the first phone stays latched');
  watch.begin(pixelAgain);
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, pixel), [], 'stale replaced session cannot trigger or mutate the new session');
  watch.end(pixel); // the replaced session closes after the new one is up
  assert.deepStrictEqual(kinds(watch.info({ battery: 5, charging: false }, pixelAgain)), ['low'], 'the new login starts a new cycle');
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, { ...pixelAgain, authed: false }), [], 'unauthenticated ctx is rejected');
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, { ...pixelAgain, released: true }), [], 'released ctx is rejected');
  watch.end(pixelAgain);
  assert.deepStrictEqual(watch.info({ battery: 5, charging: false }, pixelAgain), [], 'disconnect drops the session');
  watch.begin(pixelAgain);
  assert.deepStrictEqual(kinds(watch.info({ battery: 4, charging: false }, pixelAgain)), ['low']);
  watch.forget('pixel');
  assert.deepStrictEqual(watch.info({ battery: 3, charging: false }, pixelAgain), [], 'forget drops it until the next login');
  watch.begin(pixelAgain);
  watch.reset();
  assert.deepStrictEqual(watch.info({ battery: 2, charging: false }, pixelAgain), [], 'reset clears active sessions on quit');
  on = false;
  watch.setting(false);
  watch.begin(galaxy);
  assert.deepStrictEqual(watch.info({ battery: 1, charging: false }, galaxy), []);
  on = true;
  watch.setting(true);
  assert.deepStrictEqual(kinds(watch.info({ battery: 1, charging: false }, galaxy)), ['low'], 'turning the switch back on starts clean');
  assert.deepStrictEqual(seen.filter((k) => k === 'low').length >= 4, true);
}

// Both entry points use the same safe notification helper.
{
  assert.strictEqual(showMacNotification, showDesktopNotification);
  assert.strictEqual(showMacNotification({ kind: 'low', name: 'Pixel', battery: 10 }, {}), false);
  assert.strictEqual(showMacNotification({ kind: 'low', name: 'Pixel', battery: 10 }, { Notification: { isSupported: () => false } }), false);
  assert.strictEqual(showMacNotification({ kind: 'low', name: 'Pixel', battery: 10 }, {
    Notification: class { static isSupported() { return true; } constructor() { throw new Error('denied'); } },
  }), false);
  const shown = [];
  const listeners = [];
  function Note(opts) { this.opts = opts; this.handlers = {}; shown.push(opts); listeners.push(this.handlers); }
  Note.isSupported = () => true;
  Note.prototype.show = function () { this.shown = true; };
  Note.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };
  let clicked = null;
  assert.strictEqual(showDesktopNotification({ kind: 'full', name: 'Pixel', battery: 100 }, {
    Notification: Note,
    t: (s, vars) => s.replace('{name}', vars && vars.name || '').replace('{percent}', vars && vars.percent != null ? String(vars.percent) : ''),
    onClick: (a) => { clicked = a; },
  }), true);
  assert.strictEqual(shown[0].title, 'Pixel is fully charged');
  assert.strictEqual(shown[0].body, 'Battery is at 100%');
  assert.strictEqual(typeof listeners[0].click, 'function');
  listeners[0].click();
  assert.strictEqual(clicked && clicked.name, 'Pixel');
  assert.strictEqual(showMacNotification({ kind: 'low', name: 'Pixel', battery: 10 }, {
    Notification: Note,
    onClick: () => { throw new Error('window gone'); },
  }), true);
  assert.doesNotThrow(() => listeners[1].click());
  assert.strictEqual(showMacNotification({ kind: 'nope', battery: 1 }, { Notification: Note }), false);

  const timer = { unref() {} };
  const schedule = mock.method(global, 'setTimeout', () => timer);
  const cancel = mock.method(global, 'clearTimeout', () => {});
  try {
    class Denied extends Note { show() { throw new Error('permission denied'); } }
    assert.strictEqual(showDesktopNotification({ kind: 'low', battery: 5 }, { Notification: Denied }), false);
    assert.strictEqual(schedule.mock.callCount(), 1);
    assert.deepStrictEqual(cancel.mock.calls.map(({ arguments: args }) => args), [[timer]]);
  } finally {
    schedule.mock.restore();
    cancel.mock.restore();
  }
}

console.log('battery-alerts: ok');
