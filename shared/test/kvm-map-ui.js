// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Exercise dragging the remote display group through the real map UI without a browser.
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const G = require('../kvm-geom.js');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; }
  setAttribute(name, value) { this.attrs[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
  setPointerCapture() {}
  createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }; }
  getScreenCTM() { return { inverse() { return {}; } }; }
  dispatch(name, x, y) { this.listeners[name]({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} }); }
}

const document = { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
const context = { document, KvmGeom: G };
vm.runInNewContext(fs.readFileSync(require.resolve('../kvm-map-ui.js'), 'utf8'), context);

const mine = [
  { id: 'laptop', x: 2300, y: 1190, w: 1620, h: 1040 },
  { id: 'tv', x: 3500, y: 0, w: 2110, h: 1150 },
];
const theirs = [
  { id: 'mini-1', x: 0, y: 500, w: 1370, h: 750 },
  { id: 'arzopa', x: 1410, y: 0, w: 2070, h: 1150 },
];
let chosen;
const map = context.KvmMapUI.create({ onMove: (side, along) => { chosen = { side, along }; }, onIdentify() {} });
map.update({ mine, theirs, side: 'left', along: 40 });
const box = map.el.children[0];
const remote = box.children.find((node) => node.attrs.class === 'kvm-map-theirs');
const initial = G.placement(mine, theirs, { side: 'left', along: 40 });
remote.dispatch('pointerdown', 1500, 400);
box.dispatch('pointermove', 1500 - initial.x, 400);
box.dispatch('pointerup', 1500 - initial.x, 400);
assert.strictEqual(chosen.side, 'top');
assert.deepStrictEqual(G.contact(mine, theirs, chosen).map((c) => [c.mine.display, c.theirs.display]), [['laptop', 'arzopa']]);
console.log('kvm-map-ui: ok');
