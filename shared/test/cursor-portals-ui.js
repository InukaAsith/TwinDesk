// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Exercise the real portal editor and UI controls without starting Electron or requesting permissions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this._value = ''; this.checked = false; this.disabled = false; this.classList = { add() {}, toggle() {} }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); if (this.tag === 'select' && !this._value && this.children[0]) this._value = this.children[0].value; }
  replaceChildren(...nodes) { this.children = []; this._value = ''; this.append(...nodes); }
  get options() { return this.children; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  click() { if (!this.disabled && this.onclick) this.onclick(); }
}
const document = { activeElement: null, createElement: (tag) => new Element(tag), createTextNode: (text) => ({ textContent: text }) };
let saved;
const ctx = { document, console, MacShareProtocol: { HOTKEYS: [], hotkeyName: () => '' },
  macshare: { setPortals(rules) { saved = rules; } }, I18n: { t: (s) => s } };
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
for (const file of ['mac/control.js', 'shared/cursor-portals.js', 'mac/ui-cursor-portals.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), ctx, { filename: file });
}
const editor = vm.runInContext('CursorPortalsUI.create()', ctx);
const state = { client: { id: 'peer' }, input: { where: 'home', portals: { supported: true, rules: [] }, map: {
  mine: [{ id: '1', name: 'Laptop', x: 0, y: 100, w: 100, h: 100 }, { id: '2', name: 'MSI', x: 80, y: 0, w: 150, h: 100 }],
  theirs: [{ id: '3', name: 'ARZOPA', x: 0, y: 0, w: 100, h: 100 }, { id: '4', name: 'Mini Display', x: 0, y: 100, w: 100, h: 100 }],
} } };
editor.update(state);
function nodes(root) { return [root, ...(root.children || []).flatMap(nodes)]; }
function byLabel(label) { return nodes(editor.el).find((n) => n.attributes && n.attributes['aria-label'] === label); }
function button(label) { return nodes(editor.el).find((n) => n.tag === 'button' && n.textContent === label); }
byLabel('Destination edge').value = 'bottom';
byLabel('Command').checked = true;
button('Add portal').click();
assert.equal(saved.length, 1);
assert.equal(saved[0].source.display, '1');
assert.equal(saved[0].target.display, '3');
assert.equal(saved[0].target.side, 'bottom');
assert.deepEqual(Array.from(saved[0].modifiers), ['Command']);
state.input.portals.rules = saved;
editor.update(state);
button('Remove').click();
assert.equal(saved.length, 0);
state.input.portals.rules = [];
editor.update(state);
byLabel('Source display').value = '2';
byLabel('Source edge').value = 'bottom';
byLabel('Source end percent').value = '10';
saved = null;
button('Add portal').click();
assert.equal(saved[0].source.display, '2', 'shortcut-gated shared edge can be configured');
assert.equal(saved[0].source.side, 'bottom');
byLabel('Command').checked = false;
saved = null;
button('Add portal').click();
assert.equal(saved, null, 'a shared local edge cannot be configured without a shortcut');
state.input.portals.supported = false;
editor.update(state);
assert.equal(button('Add portal').disabled, true);
console.log('cursor portal editor: add, remove and unsupported peer passed');
