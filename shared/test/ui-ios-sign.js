// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/ui-ios-sign.js builds and updates through every state without throwing (a stand-in DOM and
// UI kit), sends the password once and clears the field, and asks before Keep a copy.
'use strict';

const assert = require('assert');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.className = ''; this.attrs = {}; this.style = {}; this.parent = null; }
  append(...c) { for (const x of c) { if (x instanceof El) x.parent = this; this.children.push(x); } }
  replaceChildren(...c) { this.children = []; this.append(...c); }
  insertBefore(n, ref) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, n);
  }
  get nextSibling() { return this.parent ? this.parent.children[this.parent.children.indexOf(this) + 1] || null : null; }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this.attrs[k] = v; }
  get classList() { const e = this; return { add: (c) => { e.className += ` ${c}`; }, toggle: (c, on) => { e.className = e.className.split(' ').filter((x) => x !== c).concat(on ? [c] : []).join(' '); } }; }
  querySelector(sel) { return sel === '.card-title span' ? this.titleSpan : null; }
  get text() { return [this.textContent, ...this.children.map((c) => (c instanceof El ? c.text : ''))].join(' '); }
}
const el = (tag, props = {}, children = []) => {
  const e = new El(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'attrs') Object.assign(e.attrs, v); else e[k] = v; }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
};
const sent = [];
const tabs = [];
global.window = {};
global.document = { createElementNS: (ns, tag) => new El(tag) };
Object.defineProperty(global, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
const went = [];
global.UI = {
  el, tab: (d) => tabs.push(d), go: (id) => went.push(id),
  api: { iosSign: (o) => sent.push(o), iosSignIpa: () => sent.push({ a: 'pick' }) },
  note: (kind, text) => { const n = el('div', { class: `note ${kind}`, text }); n.set = (t) => { n.textContent = t || ''; n.hidden = !t; }; return n; },
  button: (label, onClick) => { const b = el('button', { text: label }); b.click = onClick; return b; },
  row: (label, hint, controls = [], o = {}) => { const r = el('div', { text: label }, controls); r.hintText = hint; r.setHint = (h) => { r.hintText = h; }; r.label = el('span'); r.click = o.onClick; return r; },
  card: (title, rows, o = {}) => { const span = el('span', { text: title }); const c = el('section', { text: title }, [...(o.actions || []), ...rows]); c.titleSpan = span; return c; },
  switch: (onChange) => { const e = el('input'); return { el: e, on: onChange, set: (v) => { e.checked = !!v; } }; },
  select: (options, onChange) => { const e = el('select'); return { el: e, on: onChange, options: (o) => { e.opts = o; }, set: (v) => { e.value = v; } }; },
  segmented: (options, onChange) => { const e = el('div'); return { el: e, on: onChange, set: (v) => { e.value = v; } }; },
};
require('../ui-ios-sign.js');

const tab = tabs[0];
assert.strictEqual(tab.id, 'iossign');
assert.strictEqual(tab.hidden({}), true);
const body = el('div');
const update = tab.build(body);
const find = (node, pred, out = []) => { if (node instanceof El) { if (pred(node)) out.push(node); node.children.forEach((c) => find(c, pred, out)); } return out; };
const button = (label) => find(body, (n) => n.tag === 'button' && n.textContent === label)[0];
const base = { on: true, available: true, anyIpa: true, anisette: 'https://a.example', auto: true, days: 3, how: 'self', which: 'all', retry: 6, retries: [1, 3, 6, 12, 24], keep: false, canKeep: true, devices: [{ udid: 'U1', name: 'An iPhone', usb: false, wifi: true }], udid: 'U1', near: [], session: null, apps: [], phone: null, kept: null, pending: false, ipa: '', run: null, last: null };
const soon = Math.floor(Date.now() / 1000) + 3600;
const td = { bundleId: 'com.twindesk.ios.T', name: 'TwinDesk', version: '3', teamName: 'T', expires: soon, twindesk: true };
const states = [
  {}, { iosSign: { available: false } }, { iosSign: { ...base, on: false } }, { iosSign: base },
  { iosSign: { ...base, devices: [], udid: '' } },
  { iosSign: { ...base, devices: [...base.devices, { udid: 'U2', name: 'An iPad', usb: true }], udid: '' } },
  { iosSign: { ...base, devices: [], udid: '', near: [{ id: 'P', name: 'Near iPhone' }] } },
  { iosSign: { ...base, devices: [], udid: '', session: { id: 'P', name: 'In session' } } },
  { iosSign: { ...base, apps: [td, { bundleId: 'x', name: 'Other', version: '', teamName: '', expires: 0 }] } },
  { iosSign: { ...base, phone: { signedIn: true, email: 'a@b.c', until: 1, auto: true } } },
  { iosSign: { ...base, run: { from: 'here', step: 'signin', percent: 0, seen: ['signin'], need: { what: 'code', numbers: [], error: 'Wrong code' } } } },
  { iosSign: { ...base, run: { from: 'here', step: 'cert', percent: 0, seen: ['signin', 'register', 'cert'], need: { what: 'cert', certs: [{ serial: 'S1', name: 'iOS Development', machine: 'AltStore', expires: soon, ours: false }, { serial: 'S2', name: 'iOS Development', machine: 'TwinDesk', expires: soon, ours: true }] } } } },
  { iosSign: { ...base, run: { from: 'phone', step: 'install', percent: 40, seen: ['session', 'register', 'cert', 'appid', 'profile', 'sign', 'install'], need: { what: 'code' } } } },
  { iosSign: { ...base, last: { error: { kind: 'auth', code: -80045, message: 'Apple didn’t accept the sign-in', detail: 'This action cannot be completed' } } } },
  { iosSign: { ...base, last: { done: { expires: soon } }, pending: true } },
  { iosSign: { ...base, last: { info: 'Waking TwinDesk on the iPhone over Bluetooth…' } } },
  { iosSign: { ...base, keep: true, kept: { email: 'a@b.c', until: 1, signedIn: true }, ipa: 'App.ipa' } },
];
for (const s of states) update(s);

const card = (title) => find(body, (n) => n.tag === 'section' && n.titleSpan && n.titleSpan.textContent === title)[0];
const order = () => body.children.map((c) => (c.titleSpan ? c.titleSpan.textContent : c.className));
// TwinDesk not on the device: Install right under the devices; there: Reinstall after the options
update({ iosSign: base });
assert.ok(order().indexOf('Devices') < order().indexOf('Install TwinDesk'), order().join());
assert.ok(order().indexOf('Install TwinDesk') < order().indexOf('Automatic refresh'), order().join());
update(states[8]);
assert.ok(order().indexOf('Reinstall') > order().indexOf('Apple developer account'), order().join());
// While off: the picture, the warning and TwinDesk Web under the switch; gone once on
const warnEl = find(body, (n) => n.className === 'ios-warn')[0];
const heroEl = find(body, (n) => n.className === 'ios-hero')[0];
const webEl = find(body, (n) => n.className === 'ios-alt')[0];
assert.deepStrictEqual([heroEl, warnEl, webEl].map((n) => body.children.indexOf(n)), [2, 3, 4]);
assert.ok(warnEl.hidden && heroEl.hidden && webEl.hidden);
update({ iosSign: { ...base, on: false } });
assert.ok(!warnEl.hidden && !heroEl.hidden && !webEl.hidden);
button('Open TwinDesk Web').click();
assert.strictEqual(went.pop(), 'web');
// A run: Progress at the top, above the devices
update(states[11]);
assert.ok(order().indexOf('Progress') < order().indexOf('Devices'), order().join());

// Revoke: every certificate offers it, TwinDesk's own first (another tool's is confirmed by the app's dialog)
update(states[11]);
const revokes = find(body, (n) => n.tag === 'button' && n.textContent === 'Revoke');
assert.strictEqual(revokes.length, 2);
revokes[0].click();
assert.deepStrictEqual(sent.pop(), { a: 'answer', revoke: ['S2'] });
revokes[1].click();
assert.deepStrictEqual(sent.pop(), { a: 'answer', revoke: ['S1'] });
// Progress lists the steps seen and the ones to come
assert.ok(/Getting the certificate/.test(card('Progress').text) && /Installing/.test(card('Progress').text));

// Several devices: a row picks one
update(states[5]);
const ipad = find(body, (n) => n.textContent === 'An iPad')[0];
ipad.click();
assert.deepStrictEqual(sent.pop(), { a: 'set', udid: 'U2' });

// The password: sent once, then gone from the field
update({ iosSign: base });
const inputs = find(body, (n) => n.tag === 'input' && (n.type === 'email' || n.type === 'password'));
inputs[0].value = ' a@b.c ';
inputs[1].value = 'pw';
button('Install TwinDesk').click();
assert.deepStrictEqual(sent.pop(), { a: 'signin', email: 'a@b.c', password: 'pw' });
assert.strictEqual(inputs[1].value, '');
button('Install TwinDesk').click();
assert.strictEqual(sent.length, 0, 'nothing without a password');

// Keep a copy: a plain switch; App IDs once the session is stored here
const keep = card('Apple developer account');
assert.ok(/Keep a copy of the Apple developer session/.test(keep.text));
update({ iosSign: { ...base, keep: true, kept: { email: 'a@b.c', until: 1, signedIn: true } } });
button('View app IDs').click();
assert.deepStrictEqual(sent.pop(), { a: 'appids' });
update({ iosSign: { ...base, keep: true, kept: { email: 'a@b.c', until: 1, signedIn: true }, ids: { list: [{ id: 'com.twindesk.ios.T', name: 'TwinDesk', expires: soon }], available: 9, teamName: 'Me' } } });
assert.ok(/Reload/.test(keep.text) && /TwinDesk/.test(keep.text), keep.text);
console.log('ui-ios-sign: ok');
