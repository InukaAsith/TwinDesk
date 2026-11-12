// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/iossign.js with a stand-in for the signing helper: a sealed run asked by the iPhone (this
// side only passes boxes), a run typed here (the code asked for, the state handed to the iPhone),
// the kept copy (only when switched on, gone when switched off), and what never leaves: the password.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { IosSign, T, cleanState, stateFacts } = require('../iossign.js');

if (process.platform === 'win32') { console.log('iossign: skipped (needs a script as the helper)'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iossign-test-'));
const fake = path.join(dir, 'helper');
const UDID = '00008110-0002285C02BA801E';
const FUTURE = Date.now() + 300 * 86400000;
fs.writeFileSync(fake, `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const lines = []; let wait = null;
rl.on('line', (l) => { if (wait) { const w = wait; wait = null; w(JSON.parse(l)); } else lines.push(JSON.parse(l)); });
const next = () => new Promise((r) => (lines.length ? r(lines.shift()) : (wait = r)));
(async () => {
  const req = await next();
  if (req.op === 'info') out({ ev: 'info', anyIpa: false, anisette: 'https://a.example', version: '1' });
  else if (req.op === 'devices') out({ ev: 'devices', devices: [{ udid: '${UDID}', name: 'An iPhone', usb: false, ip: '' }] });
  else if (req.op === 'apps') out({ ev: 'apps', apps: [{ bundleId: 'com.twindesk.ios.ABCDEF1234', name: 'TwinDesk', version: '3.0.0', team: 'ABCDEF1234', teamName: 'T', expires: ${Math.floor(Date.now() / 1000) + 5 * 86400} }] });
  else if (req.sealed) {
    out({ ev: 'key', pub: 'aGVscGVy' });
    const first = await next();
    if (!first.pub || !first.box) return out({ ev: 'error', kind: 'other', message: 'no box' });
    out({ ev: 'step', step: 'sign' });
    out({ ev: 'state', box: 'c2VhbGVk' });
    out({ ev: 'done', expires: 99, bundleId: 'com.twindesk.ios.ABCDEF1234', device: 'An iPhone' });
  } else if (req.state && req.state.xcode_token && !req.password) {
    out({ ev: 'state', state: req.state });
    out({ ev: 'done', expires: 77 });
  } else {
    if (req.password !== 'hunter2 "x"') return out({ ev: 'error', kind: 'auth', code: -1, message: 'wrong' });
    out({ ev: 'need2fa', sms: false, numbers: [{ id: 1, number: '+1 ••13' }] });
    const a = await next();
    if (a.code !== '123456') return out({ ev: 'error', kind: 'auth', message: 'bad code' });
    out({ ev: 'state', state: { email: req.email, adsid: 'a', xcode_token: 'tok', xcode_token_expiry: '${FUTURE}' } });
    out({ ev: 'done', expires: 88 });
  }
  process.exit(0);
})();
`);
fs.chmodSync(fake, 0o755);

function rig(cfg0 = {}, extra = {}) {
  const link = new EventEmitter();
  link.sent = [];
  link.send = (m) => link.sent.push(m);
  link.current = { os: 'ios', id: 'phone-1', name: 'An iPhone' };
  let cfg = { on: true, auto: false, ...cfg0 };
  let vault = '';
  let loads = 0;
  const sign = new IosSign({ link, bins: ['/nowhere', fake], cfg: () => cfg, setCfg: (p) => { cfg = { ...cfg, ...p }; }, vault: { load: () => { loads++; return vault; }, save: (s) => { vault = s; } }, ...extra });
  return { link, sign, vault: () => vault, loads: () => loads, cfg: () => cfg, of: (t) => link.sent.filter((m) => m.t === t) };
}
const until = async (what, fn) => {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out: ${what}`);
};

(async () => {
  assert.strictEqual(cleanState({ a: 'b', c: 1 }), null);
  assert.deepStrictEqual(cleanState({ a: 'b' }), { a: 'b' });
  assert.strictEqual(stateFacts({ xcode_token: 't', xcode_token_expiry: '1' }).signedIn, false);

  // What it finds
  let r = rig();
  await until('the device and its apps', () => r.sign.view.apps.length === 1);
  assert.strictEqual(r.sign.view.udid, UDID);
  assert.strictEqual(r.sign.view.apps[0].twindesk, true);
  assert.strictEqual(r.sign.view.available, true);

  // A sealed run: boxes pass through, the state stays a box
  r.link.emit(T.START, {});
  await until('the key', () => r.of(T.KEY).length === 1);
  assert.strictEqual(r.of(T.KEY)[0].pub, 'aGVscGVy');
  r.link.emit(T.BOX, { pub: 'cGhvbmU=', box: 'Ym94' });
  await until('done', () => r.sign.view.last && r.sign.view.last.done);
  const evs = r.of(T.EV);
  assert.deepStrictEqual(evs.find((e) => e.ev === 'state'), { t: T.EV, ev: 'state', box: 'c2VhbGVk' });
  assert.strictEqual(evs.find((e) => e.ev === 'done').expires, 99);
  assert.strictEqual(r.vault(), '', 'a sealed run leaves nothing here');
  assert.strictEqual(r.sign.view.pending, false);
  // a second start while one runs is refused
  r.link.emit(T.START, {});
  r.link.emit(T.START, {});
  await until('busy', () => r.of(T.EV).some((e) => e.ev === 'error' && e.kind === 'busy'));
  r.sign.close();

  // Typed here: the code is asked for, the state waits for the iPhone's app, nothing is kept
  r = rig({ keep: false });
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  r.sign.signIn({ email: 'a@b.c', password: 'hunter2 "x"' });
  await until('the code is asked', () => r.sign.view.run && r.sign.view.run.need);
  assert.strictEqual(r.sign.view.run.need.what, 'code');
  r.sign.answer({ code: '123 456' });
  await until('done', () => r.sign.view.last && r.sign.view.last.done);
  assert.strictEqual(r.vault(), '', 'keep is off: nothing in the vault');
  assert.strictEqual(r.of(T.KEEP).length, 1, 'the iPhone is connected: it gets the state');
  assert.strictEqual(r.of(T.KEEP)[0].state.xcode_token, 'tok');
  assert.ok(!JSON.stringify(r.link.sent).includes('hunter2'), 'the password goes to nobody');
  assert.ok(!JSON.stringify(r.sign.view).includes('hunter2') && !JSON.stringify(r.sign.view).includes('tok'), 'nor into the window');
  r.sign.close();

  // A wrong password: said, and nothing made
  r = rig();
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  r.sign.signIn({ email: 'a@b.c', password: 'nope' });
  await until('the error', () => r.sign.view.last && r.sign.view.last.error);
  assert.strictEqual(r.sign.view.last.error.kind, 'auth');
  assert.strictEqual(r.of(T.KEEP).length, 0);
  r.sign.close();

  // Keep switched on: the copy is kept, refreshes without the iPhone, and goes when switched off
  r = rig({ keep: true });
  r.link.current = { os: 'mac', id: 'x' }; // no iPhone app on the session
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  r.sign.signIn({ email: 'a@b.c', password: 'hunter2 "x"' });
  await until('the code is asked', () => r.sign.view.run && r.sign.view.run.need);
  r.sign.answer({ code: '123456' });
  await until('done', () => r.sign.view.last && r.sign.view.last.done);
  assert.ok(r.vault().includes('tok'), 'the copy is in the vault');
  assert.strictEqual(r.sign.view.kept.signedIn, true);
  assert.strictEqual(r.sign.view.pending, true, 'and still waits for the iPhone’s app');
  r.sign.refreshKept();
  await until('refreshed from the copy', () => r.sign.view.last && r.sign.view.last.done && r.sign.view.last.done.expires === 77);
  r.link.current = { os: 'ios', id: 'phone-1' };
  r.link.emit(T.STATE, { signedIn: false });
  assert.strictEqual(r.of(T.KEEP).length, 1, 'handed over once its app is there');
  r.sign.set({ keep: false });
  assert.strictEqual(r.vault(), '');
  assert.strictEqual(r.sign.view.kept, null);
  // a copy offered by the iPhone is refused while keep is off, taken while on
  r.link.emit(T.KEEP, { state: { xcode_token: 'p' } });
  assert.strictEqual(r.vault(), '');
  r.sign.set({ keep: true });
  r.link.emit(T.KEEP, { state: { xcode_token: 'p' } });
  assert.ok(r.vault().includes('"p"'));
  r.sign.close();

  // Time to refresh: the iPhone's app is asked, once
  r = rig({ auto: true, days: 6 });
  await until('the apps', () => r.sign.view.apps.length === 1);
  r.link.emit(T.STATE, { signedIn: true, email: 'a@b.c', until: FUTURE, auto: true });
  assert.strictEqual(r.of(T.WANT).length, 1);
  r.link.emit(T.STATE, { signedIn: true, email: 'a@b.c', until: FUTURE, auto: true });
  assert.strictEqual(r.of(T.WANT).length, 1);
  r.sign.close();

  // The vault (a Keychain prompt on a Mac) isn't read while Keep a copy is off, nor while it's all off
  r = rig({ on: false });
  await until('the helper', () => r.sign.view.available);
  assert.strictEqual(r.sign.view.keep, true, 'Keep a copy is on by default');
  assert.strictEqual(r.loads(), 0, 'but the vault isn’t read while it’s all off');
  r.sign.close();
  r = rig({ on: false, keep: false });
  await until('the helper', () => r.sign.view.available);
  void r.sign.view;
  assert.strictEqual(r.sign.view.devices.length, 0, 'off: no device is looked at');
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(r.sign.view.ready, false, 'off: the helper isn’t even run');
  r.sign.set({ on: true });
  await until('the device', () => r.sign.view.udid === UDID);
  assert.strictEqual(r.loads(), 0, 'the vault is never read with Keep a copy off');
  r.sign.close();

  // Ask first: the iPhone is told to show its notification
  r = rig({ auto: true, days: 6, how: 'ask' });
  await until('the apps', () => r.sign.view.apps.length === 1);
  r.link.emit(T.STATE, { signedIn: true, email: 'a@b.c', until: FUTURE, auto: true });
  assert.strictEqual(r.of(T.WANT)[0].ask, true);
  assert.ok(r.of(T.WANT)[0].expires > 0);
  r.sign.close();

  // Any offered certificate can be revoked when picked (another tool's after the window's warning); nothing else
  r = rig();
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  r.sign.run = { from: 'here', need: { what: 'cert', certs: [{ serial: 'A', ours: false }, { serial: 'T', ours: true }] }, proc: { stdin: { writable: true, write: (l) => { r.wrote = l; } } } };
  r.sign.answer({ revoke: ['A', 'X'] });
  assert.deepStrictEqual(JSON.parse(r.wrote), { revoke: ['A'] });
  r.sign.run = null;
  r.sign.close();

  // Not in a session, only near over Bluetooth: Refresh now invites it and asks once it's back
  const invited = [];
  r = rig({}, { near: { list: () => [{ id: 'phone-1', name: 'An iPhone', os: 'ios' }], invite: (id) => invited.push(id) } });
  r.link.current = null;
  await until('the helper', () => r.sign.view.available);
  assert.strictEqual(r.sign.view.near.length, 1);
  r.sign.refresh();
  assert.deepStrictEqual(invited, ['phone-1']);
  r.link.current = { os: 'ios', id: 'phone-1', name: 'An iPhone' };
  r.link.emit(T.STATE, { signedIn: true, email: 'a@b.c', until: FUTURE, auto: true });
  assert.strictEqual(r.of(T.WANT)[0].now, true);
  r.sign.close();

  // TwinDesk's IPA: downloaded once and kept (save_ipa), then refreshed from the kept copy
  const cacheDir = path.join(dir, 'ipas');
  r = rig({ keep: true }, { cacheDir });
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  const reqs = [];
  r.sign._start = (run, req) => reqs.push(req);
  r.sign.kept[UDID] = { email: 'a@b.c', xcode_token: 't', xcode_token_expiry: String(FUTURE) };
  r.sign.refreshKept();
  assert.strictEqual(reqs[0].save_ipa, path.join(cacheDir, 'TwinDesk.ipa'));
  assert.ok(!reqs[0].twindesk_ipa && !reqs[0].ipa);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'TwinDesk.ipa'), 'x');
  r.sign.refreshKept();
  assert.strictEqual(reqs[1].twindesk_ipa, path.join(cacheDir, 'TwinDesk.ipa'), 'refreshed from the kept IPA, not downloaded');
  assert.ok(!reqs[1].save_ipa && !reqs[1].ipa);
  r.sign.set({ cache: false });
  r.sign.refreshKept();
  assert.ok(!reqs[2].twindesk_ipa && !reqs[2].save_ipa, 'Store IPAs off: nothing kept');
  r.sign.close();

  // Refresh of an installed TwinDesk: profiles only (the helper reinstalls when it can't)
  r = rig({ keep: true }, { cacheDir });
  await until('the apps', () => r.sign.view.apps.length === 1);
  const reqs2 = [];
  r.sign._start = (run, req) => reqs2.push(req);
  r.sign.kept[UDID] = { email: 'a@b.c', xcode_token: 't', xcode_token_expiry: String(FUTURE) };
  r.sign.refreshKept();
  assert.strictEqual(reqs2[0].profile_only, 'com.twindesk.ios.ABCDEF1234');
  // Another app without its IPA: refreshed with new profiles only, no download, no TwinDesk
  r.sign.info.anyIpa = true;
  r.sign.apps[UDID].push({ bundleId: 'com.example.App', name: 'App', expires: 1, twindesk: false });
  r.sign.refreshApp('com.example.App');
  assert.strictEqual(reqs2[1].profile_only, 'com.example.App');
  assert.ok(reqs2[1].no_ipa === true && !reqs2[1].ipa && !reqs2[1].twindesk_ipa && !reqs2[1].save_ipa);
  r.sign.refreshApp('com.not.there');
  assert.strictEqual(reqs2.length, 2, 'only an app that is on the device');
  r.sign.close();

  // The vault is opened only to use or change the copy: the window reads the facts from the settings
  r = rig({ keep: true });
  await until('the device', () => r.sign.view.udid === UDID && r.sign.view.available);
  r.link.emit(T.KEEP, { state: { email: 'a@b.c', xcode_token: 'p', xcode_token_expiry: String(FUTURE) } });
  const saved = r.vault();
  assert.ok(saved.includes('"p"'));
  const later = rig({ ...r.cfg() });
  await until('the device', () => later.sign.view.udid === UDID && later.sign.view.available);
  assert.strictEqual(later.sign.view.kept.signedIn, true);
  assert.strictEqual(later.sign.view.kept.email, 'a@b.c');
  later.link.emit(T.KEEP, { state: { email: 'a@b.c', xcode_token: 'p', xcode_token_expiry: String(FUTURE) } });
  assert.strictEqual(later.loads(), 0, 'the same copy again: the vault isn’t opened');
  r.sign.close();
  later.sign.close();

  // On and off in step with the iPhone's App refresh
  r = rig({ on: false });
  r.link.emit(T.STATE, { signedIn: false });
  assert.strictEqual(r.of(T.INFO).pop().on, false);
  r.link.emit(T.SET, { on: true }); // switched on there (after its warning)
  assert.strictEqual(r.cfg().on, true);
  let info = r.of(T.INFO).pop();
  assert.ok(info.on === true && info.switched === false, 'the iPhone did it: not echoed as a switch');
  r.sign.set({ on: false }); // switched off here
  info = r.of(T.INFO).find((m) => m.switched);
  assert.ok(info && info.on === false, 'the iPhone is told it was switched off here');
  r.link.emit(T.STATE, { signedIn: false });
  assert.strictEqual(r.of(T.INFO).pop().switched, false, 'said once');
  r.link.emit(T.SET, { on: 'yes' });
  assert.strictEqual(r.cfg().on, false, 'only a real on/off');
  r.sign.close();

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('iossign: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
