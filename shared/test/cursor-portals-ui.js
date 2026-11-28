// TwinDesk — Copyright (C) 2026 pengusto, inukaasith. GPL-3.0, see LICENSE.
// The Cursor portals card (mac/ui-cursor-portals.js) on a small fake DOM, without Electron: the switch, the
// editor shown only while it's on, edges picked by clicking the drawing, ranges set with the handles, keys,
// Add and Remove, a refused shared edge without a key, an older peer, a phone peer (no card), Multi-device's picker.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this._value = '';
    this.checked = false; this.disabled = false; this.hidden = false; this.isConnected = true; this.textContent = '';
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); if (this.tag === 'select' && !this._value && this.children[0]) this._value = this.children[0].value; }
  replaceChildren(...nodes) { this.children = []; if (this.tag === 'select') this._value = ''; this.append(...nodes); }
  get options() { return this.children; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  click() { if (!this.disabled && this.onclick) this.onclick({ target: this }); }
}
const document = { activeElement: null, head: null, createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), createTextNode: (text) => ({ textContent: text }) };
let saved = null;
let kvm = null;
const ctx = { document, console, MacShareProtocol: { HOTKEYS: [], hotkeyName: () => '' },
  macshare: { setPortals(arg) { saved = arg; }, setKvm(v) { kvm = v; } }, I18n: { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k]) : s) } };
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
for (const file of ['mac/control.js', 'shared/cursor-portals.js', 'mac/ui-cursor-portals.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), ctx, { filename: file });
}
const editor = vm.runInContext('CursorPortalsUI.create()', ctx);
const mine = [{ id: '1', name: 'Laptop', x: 0, y: 100, w: 100, h: 100 }, { id: '2', name: 'MSI', x: 80, y: 0, w: 150, h: 100 }];
const theirs = [{ id: '3', name: 'ARZOPA', x: 0, y: 0, w: 100, h: 100 }, { id: '4', name: 'Mini Display', x: 0, y: 100, w: 100, h: 100 }];
const pc = { id: 'peer', name: 'Office PC', os: 'windows', displays: theirs, rules: [] };
const state = { client: { id: 'peer', os: 'windows' }, kvm: { portalsOn: false },
  input: { where: 'home', portals: { supported: true, on: false, mine, peers: [pc] } } };
const all = (root) => [root, ...(root.children || []).flatMap(all)];
const byLabel = (label) => all(editor.el).find((n) => n.attributes && n.attributes['aria-label'] === label);
const button = (text) => all(editor.el).find((n) => n.tag === 'button' && n.textContent === text);
const editorEl = () => all(editor.el).find((n) => n.className === 'cp-editor');
const status = () => all(editor.el).find((n) => n.className === 'cp-status').textContent;

// Off: the switch only; it turns them on.
editor.update(state);
assert.equal(editorEl().hidden, true, 'collapsed while off');
const sw = byLabel('Cursor portals');
sw.checked = true; sw.onchange();
assert.deepEqual({ ...kvm }, { portalsOn: true });
state.kvm.portalsOn = true;
editor.update(state);
assert.equal(editorEl().hidden, false, 'expanded while on');
assert.equal(button('Add portal').disabled, true, 'nothing picked yet');

// Pick: display 1's right edge here (it touches nothing there), display 3's bottom edge there.
byLabel('This Mac, display 1, right edge').onclick();
byLabel('Other computer, display 1, bottom edge').onclick();
// the far end handle down to 60% with the keys
const end = byLabel('Destination end');
for (let i = 0; i < 8; i++) end.onkeydown({ key: 'ArrowLeft' });
assert.equal(byLabel('Destination end').attributes['aria-valuenow'], '60');
assert.equal(button('Add portal').disabled, false, status());
button('Add portal').click();
assert.equal(saved.peer, 'peer');
assert.equal(saved.rules.length, 1);
const r = saved.rules[0];
assert.equal(r.source.display, '1'); assert.equal(r.source.side, 'right');
assert.equal(r.target.display, '3'); assert.equal(r.target.side, 'bottom');
assert.equal(r.target.from, 0); assert.equal(r.target.to, 0.6);
assert.deepEqual(Array.from(r.modifiers), ['Command'], 'Command is the default key');

// Saved: listed, removable.
pc.rules = saved.rules;
editor.update(state);
byLabel('Remove').onclick();
assert.equal(saved.rules.length, 0);
pc.rules = [];
editor.update(state);

// Display 2's bottom edge touches display 1 here: it needs a key to hold.
byLabel('This Mac, display 2, bottom edge').onclick();
byLabel('Other computer, display 1, top edge').onclick();
byLabel('Command').onclick(); // off
assert.equal(button('Add portal').disabled, true, 'a shared edge with no key');
assert.match(status(), /key to hold/);
byLabel('Shift').onclick();
assert.equal(button('Add portal').disabled, false, status());
saved = null;
button('Add portal').click();
assert.deepEqual(Array.from(saved.rules[0].modifiers), ['Shift']);

// An older peer: no adding.
state.input.portals.supported = false;
editor.update(state);
assert.equal(button('Add portal').disabled, true);
state.input.portals.supported = true;

// A phone: no card at all.
const phone = { client: { id: 'ph', os: 'android' }, kvm: { portalsOn: true }, input: { where: 'home', portals: { supported: true, on: true, mine, peers: [] } } };
editor.update(phone);
assert.equal(editor.el.hidden, true, 'no portals with a phone');
const phonePeer = { ...phone, client: null, input: { ...phone.input, portals: { ...phone.input.portals, peers: [{ id: 'ph', name: 'Pixel', os: 'android', displays: theirs, rules: [] }] } } };
editor.update(phonePeer);
assert.ok(!byLabel('Other computer, display 1, top edge') || !all(editor.el).some((n) => n.textContent === 'Pixel'), 'a phone is never a portal peer');

// Multi-device: a picker for each computer; the second one gets its own list.
const mesh = { kvm: { portalsOn: true }, input: { where: 'home', portals: { supported: true, on: true, mine, peers: [pc, { id: 'mac2', name: 'Studio', os: 'mac', displays: theirs, rules: [] }] } } };
editor.update(mesh);
assert.equal(editor.el.hidden, false);
button('Studio').click();
byLabel('This Mac, display 1, left edge').onclick();
byLabel('Other computer, display 2, right edge').onclick();
saved = null;
button('Add portal').click();
assert.equal(saved.peer, 'mac2');
assert.equal(saved.rules[0].target.display, '4');

console.log('cursor portal editor: switch, visual pick, keys, add, remove, shared edge, old peer, phone, Multi-device passed');
