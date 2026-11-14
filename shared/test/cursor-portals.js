// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalize, mapOffset, desktopOffset, route, entryPoint, exposed, usableSource, usableTarget } = require('../cursor-portals.js');
const { KvmMap } = require('../kvm-map.js');

const laptop = { id: 'laptop', source: { display: '1', side: 'top', from: 0, to: 0.5 },
  target: { display: 'remote', side: 'bottom', from: 0.25, to: 0.75 }, modifiers: ['Command'], key: '' };
const msi = { id: 'msi', source: { display: '2', side: 'left', from: 0, to: 1 },
  target: { display: 'remote', side: 'right', from: 0, to: 1 }, modifiers: ['Alt', 'Shift'], key: 'KeyP' };
assert.deepEqual(normalize([laptop, msi]), [laptop, msi]);
assert.equal(mapOffset(laptop, 0.25), 0.5);
assert.equal(mapOffset(laptop, 0), 0.25);
assert.equal(mapOffset(laptop, 0.5), 0.75);
assert.equal(mapOffset(laptop, NaN), null);
assert.equal(normalize([{ ...laptop, modifiers: ['Command', 'Command'] }]), null);
assert.equal(normalize([{ ...laptop, modifiers: ['Unknown'] }]), null);
assert.equal(normalize([{ ...laptop, key: 'untrusted input' }]), null);
assert.equal(normalize([{ ...laptop, source: { ...laptop.source, from: 0.8, to: 0.2 } }]), null);
assert.equal(normalize([laptop, { ...laptop, id: 'overlap', source: { ...laptop.source, from: 0.25, to: 0.75 } }]), null);
assert.ok(normalize([laptop, { ...laptop, id: 'adjacent', source: { ...laptop.source, from: 0.5, to: 1 } }]));
const adjacent = normalize([laptop, { ...laptop, id: 'adjacent', source: { ...laptop.source, from: 0.5, to: 1 } }]);
assert.equal(route(adjacent, { display: '1', side: 'top', offset: 0.5 }, { modifiers: ['Command'], keys: [] }).id, 'adjacent');
const displays = [{ id: 'other', x: -1280, y: 360, w: 1280, h: 720 }, { id: 'remote', x: 0, y: 0, w: 1920, h: 1080 }];
assert.equal(desktopOffset(displays, laptop.target, 0.5), 2240 / 3200);
assert.equal(desktopOffset(displays, { ...laptop.target, display: 'missing' }, 0.5), null);
assert.deepEqual(entryPoint(displays, laptop.target, 0.5), { x: 960, y: 1078 });
assert.deepEqual(entryPoint(displays, { display: 'other', side: 'left' }, 0), { x: -1278, y: 362 });
assert.equal(entryPoint(displays, { display: 'missing', side: 'top' }, 0.5), null);
assert.equal(exposed(displays, laptop.target), true);
assert.equal(exposed(displays, { display: 'remote', side: 'left', from: 0, to: 1 }), false);
assert.equal(exposed(displays, { display: 'remote', side: 'left', from: 0, to: 0.25 }), true);
assert.equal(usableTarget(displays, { display: 'remote', side: 'left', from: 0, to: 1 }), true, 'return target may be a shared local edge');
assert.equal(usableTarget(displays, { display: 'missing', side: 'left', from: 0, to: 1 }), false);
const sharedSource = { id: 'shared', source: { display: 'remote', side: 'left', from: 0, to: 1 },
  target: laptop.target, modifiers: ['Command'], key: '' };
assert.equal(usableSource(displays, sharedSource), true, 'shortcut permits a portal at an occupied local edge');
assert.equal(usableSource(displays, { ...sharedSource, modifiers: [] }), false, 'an occupied local edge cannot steal normal movement');
assert.equal(usableSource(displays, { ...sharedSource, modifiers: [], key: 'KeyP' }), true);
assert.equal(usableSource(displays, { ...sharedSource, source: { ...sharedSource.source, display: 'missing' } }), false);
assert.equal(route(normalize([sharedSource]), { display: 'remote', side: 'left', offset: 0.5 }, { modifiers: [], keys: [] }), null);
assert.equal(route(normalize([sharedSource]), { display: 'remote', side: 'left', offset: 0.5 }, { modifiers: ['Command'], keys: [] }).id, 'shared');
const rules = normalize([laptop, msi]);
assert.equal(route(rules, { display: '1', side: 'top', offset: 0.25 }, { modifiers: [], keys: [] }), null,
  'without the configured key, normal local movement stays available');
assert.deepEqual(route(rules, { display: '1', side: 'top', offset: 0.25 }, { modifiers: ['Command'], keys: [] }),
  { id: 'laptop', display: 'remote', side: 'bottom', offset: 0.5 });
assert.deepEqual(route(rules, { display: '2', side: 'left', offset: 0.25 }, { modifiers: ['Alt', 'Shift'], keys: ['KeyP'] }),
  { id: 'msi', display: 'remote', side: 'right', offset: 0.25 }, 'a different source reaches the same target');
assert.equal(route(rules, { display: '2', side: 'left', offset: 0.25 }, { modifiers: ['Alt', 'Shift'], keys: [] }), null);
assert.equal(route(rules, { display: '1', side: 'top', offset: 0.75 }, { modifiers: ['Command'], keys: [] }), null);
// Two different targets on the same peer remain independent even when a local screen lies
// between the originating displays. Neither route may fire without its held shortcut.
const toSecondScreen = { id: 'second-target', source: { display: '2', side: 'left', from: 0, to: 1 },
  target: { display: 'other', side: 'top', from: 0, to: 1 }, modifiers: [], key: 'KeyP' };
const multipleTargets = normalize([laptop, toSecondScreen]);
assert.ok(multipleTargets);
assert.deepEqual(route(multipleTargets, { display: '1', side: 'top', offset: 0.25 }, { modifiers: ['Command'], keys: [] }),
  { id: 'laptop', display: 'remote', side: 'bottom', offset: 0.5 });
assert.equal(route(multipleTargets, { display: '2', side: 'left', offset: 0.5 }, { modifiers: [], keys: [] }), null);
assert.deepEqual(route(multipleTargets, { display: '2', side: 'left', offset: 0.5 }, { modifiers: [], keys: ['KeyP'] }),
  { id: 'second-target', display: 'other', side: 'top', offset: 0.5 });
assert.deepEqual(entryPoint(displays, toSecondScreen.target, 0.5), { x: -640, y: 362 });
const screen = new EventEmitter();
screen.getPrimaryDisplay = () => ({ id: 1 });
screen.getAllDisplays = () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }];
const sent = [];
const map = new KvmMap({ electron: { screen }, send: (m) => sent.push(m), side: () => 'top', getAlong: () => null,
  setAlong: () => {}, portalVersion: 1 });
map.sendDisplays();
assert.equal(sent[0].portalVersion, 1);
map.onDisplays({ displays: [], portalVersion: 1 });
assert.equal(map.peerPortalVersion, 1);
map.reset();
assert.equal(map.peerPortalVersion, 0, 'a reconnect does not inherit the prior peer capability');
map.onDisplays({ displays: [], portalVersion: '1' });
assert.equal(map.peerPortalVersion, 0, 'malformed capability is not trusted');
console.log('cursor portal geometry and validation passed');
