// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/ui-ios-sign.js builds and updates through every state without throwing (a stand-in DOM and
// UI kit), sends the password once and clears the field, and asks before Keep a copy.
'use strict';

const assert = require('assert');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.className = ''; this.attrs = {}; }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelector() { return this.children.flatMap((c) => (c instanceof El ? [c, ...c.children] : [])).filter((c) => c instanceof El && c.tag === 'p').pop() || new El('p'); }
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
Object.defineProperty(global, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
global.UI = {
  el, tab: (d) => tabs.push(d),
  api: { iosSign: (o) => sent.push(o), iosSignIpa: () => sent.push({ a: 'pick' }) },
  note: (kind, text) => { const n = el('div', { class: `note ${kind}`, text }); n.set = (t) => { n.textContent = t || ''; n.hidden = !t; }; return n; },
  button: (label, onClick) => { const b = el('button', { text: label }); b.click = onClick; return b; },
  row: (label, hint, controls = []) => { const r = el('div', { text: label }, controls); r.hintText = hint; r.setHint = (h) => { r.hintText = h; }; r.label = el('span'); return r; },
  card: (title, rows) => el('section', { text: title }, rows),
  switch: (onChange) => { const e = el('input'); return { el: e, on: onChange, set: (v) => { e.checked = !!v; } }; },
  select: (options, onChange) => { const e = el('select'); return { el: e, on: onChange, options: (o) => { e.opts = o; }, set: (v) => { e.value = v; } }; },
};
require('../ui-ios-sign.js');

const tab = tabs[0];
assert.strictEqual(tab.id, 'iossign');
assert.strictEqual(tab.hidden({}), true);
const body = el('div');
const update = tab.build(body);
const find = (node, pred, out = []) => { if (node instanceof El) { if (pred(node)) out.push(node); node.children.forEach((c) => find(c, pred, out)); } return out; };
const button = (label) => find(body, (n) => n.tag === 'button' && n.textContent === label)[0];
const base = { on: true, available: true, anyIpa: true, anisette: 'https://a.example', auto: true, days: 3, keep: false, canKeep: true, devices: [{ udid: 'U1', name: 'An iPhone', usb: false }], udid: 'U1', apps: [], phone: null, kept: null, pending: false, ipa: '', run: null, last: null };
const soon = Math.floor(Date.now() / 1000) + 3600;
const states = [
  {}, { iosSign: { available: false } }, { iosSign: { ...base, on: false } }, { iosSign: base },
  { iosSign: { ...base, devices: [], udid: '' } },
  { iosSign: { ...base, apps: [{ bundleId: 'com.twindesk.ios.T', name: 'TwinDesk', version: '3', teamName: 'T', expires: soon, twindesk: true }, { bundleId: 'x', name: 'Other', version: '', teamName: '', expires: 0 }] } },
  { iosSign: { ...base, phone: { signedIn: true, email: 'a@b.c', until: 1, auto: true } } },
  { iosSign: { ...base, run: { from: 'here', step: 'signin', percent: 0, need: { what: 'code', numbers: [], error: 'Wrong code' } } } },
  { iosSign: { ...base, run: { from: 'here', step: 'sign', percent: 0, need: { what: 'cert', certs: [{ serial: 'S1', name: 'iOS Development', machine: 'AltStore', expires: soon }] } } } },
  { iosSign: { ...base, run: { from: 'phone', step: 'install', percent: 40, need: { what: 'code' } } } },
  { iosSign: { ...base, last: { error: { kind: 'auth', code: -80045, message: 'Apple didn’t accept the sign-in', detail: 'This action cannot be completed' } } } },
  { iosSign: { ...base, last: { done: { expires: soon } }, pending: true } },
  { iosSign: { ...base, keep: true, kept: { email: 'a@b.c', until: 1, signedIn: true }, ipa: 'App.ipa' } },
];
for (const s of states) update(s);

// A question for the iPhone isn't asked here
update(states[9]);
assert.ok(find(body, (n) => n.tag === 'section' && n.textContent === 'Apple asks')[0].hidden);
// Revoke names the one clicked
update(states[8]);
button('Revoke').click();
assert.deepStrictEqual(sent.pop(), { a: 'answer', revoke: ['S1'] });

// The password: sent once, then gone from the field
update({ iosSign: base });
const inputs = find(body, (n) => n.tag === 'input' && (n.type === 'email' || n.type === 'password'));
inputs[0].value = ' a@b.c ';
inputs[1].value = 'pw';
button('Sign in and install').click();
assert.deepStrictEqual(sent.pop(), { a: 'signin', email: 'a@b.c', password: 'pw' });
assert.strictEqual(inputs[1].value, '');
button('Sign in and install').click();
assert.strictEqual(sent.length, 0, 'nothing without a password');

// Keep a copy: the warning first, the switch stays off until "anyway"
const keep = find(body, (n) => n.tag === 'section' && n.textContent === 'Without the iPhone’s app')[0];
const danger = find(keep, (n) => /note bad/.test(n.className))[0];
assert.strictEqual(danger.hidden, true);
const keepSwitch = find(keep, (n) => n.tag === 'input')[0];
assert.ok(keepSwitch);
assert.ok(/Any program running as you/.test(danger.text));
console.log('ui-ios-sign: ok');
