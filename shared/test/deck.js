// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck: the layout (shared/deck-model.js) and the computer's side (shared/deck.js) with a fake
// phone session, helper and system layer. Run with: node shared/test/deck.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const M = require('../deck-model.js');
const P = require('../protocol.js');
const { Deck, startDeck, zoneRect, displayOf } = require('../deck.js');
const { sys } = require('../deck-sys.js');

const T = P.T;

// ---- model: actions ----
assert.strictEqual(M.combo('Shift+Mod+KeyS'), 'Mod+Shift+KeyS', 'modifiers in order');
assert.strictEqual(M.combo('Ctrl+KeyA+KeyB'), '', 'one key only');
assert.strictEqual(M.combo('Ctrl+<script>'), '', 'codes only');
assert.deepStrictEqual(M.codesOf('Mod+KeyC', true), ['MetaLeft', 'KeyC']);
assert.deepStrictEqual(M.codesOf('Mod+KeyC', false), ['ControlLeft', 'KeyC']);
assert.strictEqual(M.url('example.com/a'), 'https://example.com/a');
assert.strictEqual(M.url('javascript:alert(1)'), '');
assert.strictEqual(M.url('file:///etc/passwd'), '');
assert.deepStrictEqual(M.action({ k: 'url', url: 'javascript:x' }), { k: 'url', url: '' }, 'kept, empty: does nothing');
assert.deepStrictEqual(M.action({ k: 'keys' }), { k: 'keys', combo: '' }, 'being set up');
assert.deepStrictEqual(M.action({ k: 'sys', what: 'shutdown' }), { k: 'sys', what: 'lock' }, 'an unknown step: the first one');
assert.deepStrictEqual(M.action({ k: 'cmd', command: 'rm -rf /' }), { k: 'none' }, 'no command actions at all');
assert.deepStrictEqual(M.action({ k: 'evil' }), { k: 'none' });
assert.deepStrictEqual(M.action({ k: 'volume', what: 'set', level: 140 }), { k: 'volume', what: 'set', level: 100, step: 6 });
assert.deepStrictEqual(M.action({ k: 'nav', what: 'page' }), { k: 'none' }, 'a page to go to');
const macro = M.action({ k: 'macro', steps: [{ action: { k: 'keys', combo: 'Mod+KeyC' }, wait: 99999 }, { action: { k: 'macro', steps: [] } }, { action: { k: 'nav', what: 'next' } }, { action: { k: 'slider', what: 'volume' } }] });
assert.strictEqual(macro.steps.length, 1, 'no device steps, sliders or macros in a macro');
assert.strictEqual(macro.steps[0].wait, 10000, 'waits clamped');

// ---- model: layout ----
const starter = M.normalize(null);
assert.strictEqual(starter.v, 2);
assert.strictEqual(starter.spaces.length, 2, 'tiles and the window space');
assert.strictEqual(starter.spaces[1].kind, 'windows');
assert.ok(starter.spaces[1].layouts.length >= 4, 'window layouts to start from');
assert.ok(starter.spaces[0].pages[0].tiles.some((t) => t.w === 2), 'tiles of different sizes');
assert.deepStrictEqual(M.normalize(starter), starter, 'stable');

// v1 (one grid of buttons in slots) as one space.
const v1 = M.normalize({ cols: 4, rows: 3, pages: [{ id: 'a', name: 'A', buttons: [{ id: 'x', slot: 5, label: 'X', action: { k: 'page', to: 'a' } }, { id: 'v', slot: 0, action: { k: 'media', what: 'volup' } }] }] });
assert.strictEqual(v1.spaces[0].pages[0].tiles.find((t) => t.id === 'x').x, 1);
assert.strictEqual(v1.spaces[0].pages[0].tiles.find((t) => t.id === 'x').y, 1);
assert.deepStrictEqual(v1.spaces[0].pages[0].tiles.find((t) => t.id === 'x').action, { k: 'nav', what: 'page', to: 'a' });
assert.deepStrictEqual(v1.spaces[0].pages[0].tiles.find((t) => t.id === 'v').action, { k: 'volume', what: 'up', level: 50, step: 6 });

// Tiles: inside their grid, no overlaps, a size up to 4.
const g = M.normalize({ spaces: [{ id: 's', kind: 'tiles', pages: [{ id: 'p', cols: 4, rows: 2, tiles: [
  { id: 'a', x: 0, y: 0, w: 2, h: 2 }, { id: 'b', x: 1, y: 1 }, { id: 'c', x: 3, y: 0, w: 1, h: 3 }, { id: 'd', x: 2, y: 0, w: 9, h: 1 },
] }] }] });
const gt = g.spaces[0].pages[0].tiles;
assert.deepStrictEqual(gt.map((t) => t.id), ['a', 'c'], 'b overlaps a; d, cut to the edge, still overlaps c');
assert.strictEqual(gt.find((t) => t.id === 'c').h, 2, 'past the bottom: shorter');
// Ids unique across spaces and pages.
const dup = M.normalize({ spaces: [{ id: 'x', kind: 'tiles', pages: [{ id: 'x' }] }, { id: 'x', kind: 'tiles', pages: [{ id: 'x' }] }] });
const ids = [];
for (const s of dup.spaces) { ids.push(s.id); for (const p of s.pages) ids.push(p.id); }
assert.strictEqual(new Set(ids).size, ids.length, 'unique ids');
// Zones in the 12 grid.
const wz = M.normalize({ spaces: [{ kind: 'windows', layouts: [{ zones: [{ x: 10, y: 0, w: 9, h: 50 }] }] }] }).spaces[0].layouts[0].zones[0];
assert.deepStrictEqual(wz, { x: 10, y: 0, w: 2, h: 12 });

// move / resize / free.
let l = M.normalize({ spaces: [{ id: 's', kind: 'tiles', pages: [{ id: 'p', cols: 4, rows: 4, tiles: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'w', x: 0, y: 1, w: 2 }] }, { id: 'q', cols: 2, rows: 2, tiles: [] }] }] });
l = M.move(l, 'a', 'p', 1, 0);
assert.deepStrictEqual([M.find(l, 'a').x, M.find(l, 'b').x], [1, 0], 'same size: they swap');
l = M.move(l, 'w', 'p', 1, 0);
assert.strictEqual(M.find(l, 'w').y, 1, 'a wide one doesn’t land on others');
l = M.move(l, 'w', 'p', 2, 3);
assert.deepStrictEqual([M.find(l, 'w').x, M.find(l, 'w').y], [2, 3]);
l = M.resize(l, 'w', 2, 2);
assert.strictEqual(M.find(l, 'w').h, 1, 'no room below the grid');
l = M.resize(l, 'a', 3, 1);
assert.strictEqual(M.find(l, 'a').w, 3);
l = M.move(l, 'b', 'q');
assert.strictEqual(M.where(l, 'b').page.id, 'q', 'onto another page, its first free place');
assert.deepStrictEqual(M.free(M.pageOf(l, 's', 'q'), 2, 2), { x: 1, y: 0 }, 'q grew to the screen (4 × 2): 2 × 2 goes beside b');
assert.deepStrictEqual(M.free(M.pageOf(l, 's', 'q'), 4, 2), null, 'not 4 × 2');

// The grid follows the way the Deck is held (16:9), so tiles are about square.
assert.deepStrictEqual(M.fit(4, 'landscape'), { cols: 7, rows: 4 });
assert.deepStrictEqual(M.fit(3, 'portrait'), { cols: 3, rows: 5 });
const sq = M.normalize({ spaces: [{ kind: 'tiles', pages: [{ cols: 4, rows: 4, tiles: [{ id: 't', x: 3, y: 1, w: 1, h: 2 }] }] }] }).spaces[0].pages[0];
assert.deepStrictEqual([sq.cols, sq.rows, sq.fit], [7, 4, 'landscape'], 'a square grid grows sideways, no tile lost');
const turned = M.normalize({ orient: 'portrait', spaces: [{ kind: 'tiles', pages: [sq] }] }).spaces[0].pages[0];
assert.deepStrictEqual([turned.cols, turned.rows], [4, 7], 'held upright: columns become rows');
assert.deepStrictEqual([turned.tiles[0].x, turned.tiles[0].y, turned.tiles[0].w, turned.tiles[0].h], [1, 3, 2, 1], 'and the tiles turn with it');
const back2 = M.normalize({ orient: 'landscape', spaces: [{ kind: 'tiles', pages: [turned] }] }).spaces[0].pages[0];
assert.deepStrictEqual([back2.cols, back2.rows, back2.tiles[0].x, back2.tiles[0].y], [7, 4, 3, 1], 'and back');
const again = M.normalize(M.normalize({ spaces: [{ kind: 'tiles', pages: [sq] }] }));
assert.deepStrictEqual([again.spaces[0].pages[0].cols, again.spaces[0].pages[0].rows], [7, 4], 'stable');

// Paths stay on this computer.
const withPaths = M.normalize({ spaces: [{ id: 's', kind: 'tiles', pages: [{ id: 'p', tiles: [
  { id: 'sc', x: 0, y: 0, action: { k: 'script', path: '/Users/me/backup.command' } },
  { id: 'mc', x: 1, y: 0, action: { k: 'macro', steps: [{ action: { k: 'open', path: '/secret' } }] } },
] }] }, { id: 'wins', kind: 'windows' }] });
const dev = M.forDevice(withPaths);
assert.ok(!JSON.stringify(dev).includes('/Users/me'), 'no paths to the device');
assert.ok(!JSON.stringify(dev).includes('/secret'), 'not in a macro either');
assert.deepStrictEqual(M.find(dev, 'sc').action, { k: 'script', set: true });
assert.strictEqual(M.forDevice(withPaths, { windows: false }).spaces.length, 1, 'no window space where it can’t be used');
// The device moves and relabels the script tile, and tries to point a new one at its own path.
const back = JSON.parse(JSON.stringify(dev));
M.find(back, 'sc').label = 'Backup';
M.find(back, 'sc').x = 2;
back.spaces[0].pages[0].tiles.push({ id: 'new', x: 3, y: 0, action: { k: 'script', path: 'C:\\evil.bat' } });
const merged = M.fromDevice(withPaths, back);
assert.deepStrictEqual(M.find(merged, 'sc').action, { k: 'script', path: '/Users/me/backup.command' }, 'kept from here');
assert.strictEqual(M.find(merged, 'sc').label, 'Backup');
assert.strictEqual(M.find(merged, 'sc').x, 2);
assert.deepStrictEqual(M.find(merged, 'new').action, { k: 'script', path: '' }, 'a device can’t set a path');
assert.deepStrictEqual(M.find(merged, 'mc').action.steps[0].action, { k: 'open', path: '/secret' }, 'a macro is only edited here');
const noWin = M.fromDevice(withPaths, M.forDevice(withPaths, { windows: false }));
assert.ok(noWin.spaces.some((s) => s.kind === 'windows'), 'the window space it didn’t get stays');

// symbols
assert.strictEqual(M.symbolOf({ k: 'media', what: 'next' }), 'next');
for (const k of M.KINDS) for (const w of M.WHATS[k] || [undefined]) {
  const s = M.symbolOf(M.action({ k, what: w, to: 'x', combo: 'KeyA' }));
  assert.ok(M.SYMBOLS.includes(s), `${k} ${w}: a symbol every surface has (${s})`);
}

// ---- the engine ----
assert.deepStrictEqual(zoneRect({ x: 100, y: 0, w: 1200, h: 600 }, { x: 6, y: 0, w: 6, h: 12 }), { x: 700, y: 0, w: 600, h: 600 });
assert.strictEqual(displayOf([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 100, y: 0, w: 100, h: 100 }], { x: 80, y: 0, w: 60, h: 10 }).id, 'b');

class FakeServer extends EventEmitter {
  constructor() { super(); this.sent = []; this.current = null; }
  sendToClient(m) { this.sent.push(m); }
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}
const helperSent = [];
const fakeHelper = { send: (cmd, a) => helperSent.push({ cmd, ...a }), request: async () => ({}) };
const calls = [];
const sysState = { volume: 0.5, muted: false, micMuted: false, outputs: [{ id: 'o1', name: 'Speakers', on: true }, { id: 'o2', name: 'Headphones', on: false }], inputs: [] };
const fakeSys = {
  caps: () => ({ audio: true, outputs: true, mic: true, bt: true, bright: true, win: true, windows: true, darkmode: true, dnd: false, screenoff: true }),
  audio: async () => ({ ...sysState }),
  volume: async (o) => { calls.push(['volume', o]); },
  setDefault: async (id, input) => { calls.push(['default', id, input]); },
  bt: async () => ({ radio: true, devices: [{ id: 'aa', name: 'Buds', connected: true, audio: true }] }),
  btRadio: async (on) => { calls.push(['radio', on]); },
  btConnect: async (id, on) => { calls.push(['btconn', id, on]); },
  bright: async () => ({ displays: [{ id: '1', name: 'Built-in', level: 0.5, internal: true }] }),
  setBright: async (id, v) => { calls.push(['bright', id, Math.round(v * 100) / 100]); },
  wins: async () => ({ windows: [{ wid: 7, pid: 1, app: 'Notes', bundle: 'com.apple.Notes', title: 'A', x: 10, y: 10, w: 500, h: 400 }], front: 7 }),
  frame: async (wid, r) => { calls.push(['frame', wid, r]); },
  winOp: async (wid, op) => { calls.push(['winop', wid, op]); },
  displays: () => [{ id: 'd1', name: 'Built-in', main: true, x: 0, y: 25, w: 1200, h: 775 }, { id: 'd2', name: 'Studio', main: false, x: 1200, y: 0, w: 2400, h: 1300 }],
  sys: async (what) => { calls.push(['sys', what]); },
  winKeys: () => null,
  state: async () => ({ dark: true }),
  apps: async () => [{ id: 'com.apple.Notes', name: 'Notes', icon: 'data:x' }],
  openApp: async (id) => { calls.push(['app', id]); },
  open: async (p) => { calls.push(['open', p]); },
  script: async (p) => { calls.push(['script', p]); },
  url: async (u) => { calls.push(['url', u]); },
};

(async () => {
  const server = new FakeServer();
  let settings = { deck: withPaths };
  let changed = 0;
  const d = startDeck({ platform: 'mac', helper: fakeHelper, server, settings: () => settings, saveSettings: () => {}, readClipboard: () => 'clip!', onChange: () => changed++, sys: fakeSys });
  server.current = { os: 'android', name: 'Pixel' };
  server.emit('client', server.current);
  assert.deepStrictEqual(server.last(T.DECK_OFFER), { t: T.DECK_OFFER, v: 2 });
  server.emit(`t:${T.DECK_HELLO}`, {});
  const lay = server.last(T.DECK_LAYOUT);
  assert.ok(lay.layout && lay.mac === true && lay.can.includes('bt') && lay.caps.windows);
  assert.ok(!JSON.stringify(lay).includes('/Users/me'), 'no paths on the wire');
  assert.deepStrictEqual(d.view().surface, ['Pixel']);
  // Multi-device: one more phone's session through add(): both phones' Decks run here.
  const second = new FakeServer();
  d.add(second);
  second.current = { os: 'android', name: 'Tab' };
  second.emit('client', second.current);
  assert.deepStrictEqual(second.last(T.DECK_OFFER), { t: T.DECK_OFFER, v: 2 });
  second.emit(`t:${T.DECK_HELLO}`, {});
  assert.deepStrictEqual(d.view().surface.sort(), ['Pixel', 'Tab']);
  second.emit('closed');
  assert.deepStrictEqual(d.view().surface, ['Pixel']);

  // A device's save keeps the paths.
  const edit = JSON.parse(JSON.stringify(lay.layout));
  M.find(edit, 'sc').label = 'Nightly';
  server.emit(`t:${T.DECK_SAVE}`, { layout: edit });
  assert.strictEqual(M.find(settings.deck, 'sc').action.path, '/Users/me/backup.command');
  assert.strictEqual(M.find(settings.deck, 'sc').label, 'Nightly');

  const tileRun = async (action, id = 'tt') => {
    settings.deck = M.normalize({ spaces: [{ id: 's', kind: 'tiles', pages: [{ id: 'p', tiles: [{ id, x: 0, y: 0, action }] }] }] });
    calls.length = 0;
    helperSent.length = 0;
    server.emit(`t:${T.DECK_RUN}`, { id });
    await new Promise((r) => setTimeout(r, 70));
    return server.last(T.DECK_DONE);
  };
  assert.strictEqual((await tileRun({ k: 'script', path: '/x.command' })).ok, true);
  assert.deepStrictEqual(calls[0], ['script', '/x.command']);
  assert.strictEqual((await tileRun({ k: 'script', path: '' })).why, 'No script set for this tile');
  await tileRun({ k: 'volume', what: 'up', step: 10 });
  assert.deepStrictEqual(calls[0], ['volume', { level: 0.6 }]);
  await tileRun({ k: 'volume', what: 'toggle' });
  assert.deepStrictEqual(calls[0], ['volume', { mute: true }]);
  await tileRun({ k: 'mic', what: 'toggle' });
  assert.deepStrictEqual(calls[0], ['volume', { input: true, mute: true }]);
  await tileRun({ k: 'output' });
  assert.deepStrictEqual(calls[0], ['default', 'o2', false], 'the next output in turn');
  await tileRun({ k: 'bt', what: 'toggleconn', id: 'aa' });
  assert.deepStrictEqual(calls[0], ['btconn', 'aa', false], 'connected: disconnect');
  await tileRun({ k: 'bright', what: 'up' });
  assert.deepStrictEqual(calls[0], ['bright', '1', 0.6]);
  await tileRun({ k: 'win', what: 'right' });
  assert.deepStrictEqual(calls[0], ['frame', 0, { x: 600, y: 25, w: 600, h: 775 }]);
  await tileRun({ k: 'win', what: 'nextdisplay' });
  assert.strictEqual(calls[0][2].x > 1200, true, 'onto the next display');
  await tileRun({ k: 'media', what: 'next' });
  assert.deepStrictEqual(helperSent.map((x) => [x.ev.t, x.ev.code]), [[T.K_KEY_DOWN, 'MediaTrackNext'], [T.K_KEY_UP, 'MediaTrackNext']]);
  await tileRun({ k: 'macro', steps: [{ action: { k: 'keys', combo: 'Mod+KeyC' } }, { action: { k: 'url', url: 'example.com' }, wait: 5 }] });
  assert.deepStrictEqual(calls[0], ['url', 'https://example.com/']);
  assert.strictEqual(helperSent.length, 4);
  await tileRun({ k: 'clip', what: 'send' });
  assert.strictEqual(server.last(T.DECK_CLIP).text, 'clip!');
  assert.strictEqual((await tileRun({ k: 'sys', what: 'dnd' })).ok, false, 'not on a Mac');

  // A slider: the first value at once, the last one after the gap, the ones between dropped.
  settings.deck = M.normalize({ spaces: [{ id: 's', kind: 'tiles', pages: [{ id: 'p', tiles: [{ id: 'sl', x: 0, y: 0, w: 2, action: { k: 'slider', what: 'volume' } }] }] }] });
  calls.length = 0;
  for (const v of [0.1, 0.2, 0.3, 0.4]) server.emit(`t:${T.DECK_SET}`, { id: 'sl', value: v });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(calls.map((c) => c[1].level), [0.1, 0.4]);

  // State, the window space.
  server.emit(`t:${T.DECK_STATE}`, {});
  await new Promise((r) => setTimeout(r, 10));
  const st = server.last(T.DECK_STATE).state;
  assert.strictEqual(st.volume, 0.5);
  assert.strictEqual(st.bt.devices[0].name, 'Buds');
  assert.strictEqual(st.displays[0].id, '1');
  assert.strictEqual(st.dark, true);
  server.emit(`t:${T.DECK_WINS}`, {});
  await new Promise((r) => setTimeout(r, 10));
  const w = server.last(T.DECK_WINS);
  assert.strictEqual(w.apps[0].name, 'Notes');
  assert.strictEqual(w.apps[0].icon, 'data:x');
  assert.strictEqual(w.apps[0].windows[0].display, 'd1');
  assert.strictEqual(w.displays.length, 2);
  calls.length = 0;
  server.emit(`t:${T.DECK_PLACE}`, { wid: 7, display: 'd2', zone: { x: 0, y: 0, w: 6, h: 12 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(calls[0], ['frame', 7, { x: 1200, y: 0, w: 1200, h: 1300 }]);
  server.emit(`t:${T.DECK_PLACE}`, { wid: 7, display: 'd2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(calls[1][2].w, 500, 'onto a display: its size kept');
  assert.strictEqual(server.last(T.DECK_DONE).id, 'place');

  // Saved sets: kept by the model, their apps not running sent with names, arranged in one go.
  const setLay = M.normalize({ spaces: [{ id: 'wsp', kind: 'windows', sets: [
    { items: [{ key: 'com.apple.Notes', name: 'Notes', zone: { x: 0, y: 0, w: 6, h: 12 } }, { key: 'com.apple.Safari', name: 'Safari', zone: { x: 6, y: 0, w: 99, h: 12 } }] },
    { items: [] }, 'junk'] }] });
  const ws = setLay.spaces[0];
  assert.strictEqual(ws.sets.length, 1, 'empty and broken sets dropped');
  assert.strictEqual(ws.sets[0].name, 'Notes + Safari', 'named after its apps');
  assert.deepStrictEqual(ws.sets[0].items[1].zone, { x: 6, y: 0, w: 6, h: 12 }, 'zones clamped');
  settings.deck = setLay;
  server.emit(`t:${T.DECK_WINS}`, {});
  await new Promise((r) => setTimeout(r, 10));
  const w2 = server.last(T.DECK_WINS);
  assert.deepStrictEqual(w2.known.map((k) => k.key), ['com.apple.Safari'], 'only the set apps not running');
  assert.deepStrictEqual(w2.apps[0].windows[0].f, [0.008, -0.019, 0.417, 0.516], 'its place on its display');
  let safari = false;
  const realWins = fakeSys.wins, realApps = fakeSys.apps, realOpen = fakeSys.openApp;
  fakeSys.apps = async () => [{ id: 'com.apple.Notes', name: 'Notes' }, { id: 'com.apple.Safari', name: 'Safari' }];
  fakeSys.openApp = async (id) => { calls.push(['app', id]); safari = true; };
  fakeSys.wins = async () => ({ windows: [...(await realWins()).windows, ...(safari ? [{ wid: 9, pid: 2, app: 'Safari', bundle: 'com.apple.Safari', x: 0, y: 0, w: 900, h: 700 }] : [])], front: 7 });
  for (const x of Deck.all) x.arrangeWait = 5;
  calls.length = 0;
  server.emit(`t:${T.DECK_ARRANGE}`, { display: 'd1', items: ws.sets[0].items.concat([{ key: 'com.evil', zone: { x: 0, y: 0, w: 12, h: 12 } }]) });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'app'), [['app', 'com.apple.Safari']], 'opens only an app this Mac lists');
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'frame').map((c) => [c[1], c[2].x]), [[9, 600], [7, 0]], 'each into its zone, the first last (in front)');
  const ad = server.last(T.DECK_DONE);
  assert.strictEqual(ad.id, 'arrange');
  assert.strictEqual(ad.ok, true);
  assert.strictEqual(ad.why, 'That app isn’t on this Mac');
  fakeSys.wins = realWins; fakeSys.apps = realApps; fakeSys.openApp = realOpen;
  // Minimized windows: listed with their app (marked), a tap brings one back, a zone puts it there.
  fakeSys.wins = async () => ({ ...(await realWins()), minimized: [{ wid: 11, pid: 3, app: 'Code', bundle: 'com.microsoft.VSCode', title: 'main.js' }, { wid: 12, pid: 1, app: 'Notes', bundle: 'com.apple.Notes', title: 'B' }] });
  server.emit(`t:${T.DECK_WINS}`, {});
  await new Promise((r) => setTimeout(r, 10));
  const w3 = server.last(T.DECK_WINS);
  const code = w3.apps.find((a) => a.key === 'com.microsoft.VSCode');
  assert.strictEqual(code.min, true, 'an app with only minimized windows is marked');
  assert.deepStrictEqual(code.windows, [{ wid: 11, title: 'main.js', display: '', min: true }]);
  const notes = w3.apps.find((a) => a.key === 'com.apple.Notes');
  assert.strictEqual(notes.min, undefined, 'an app with a window showing is not');
  assert.deepStrictEqual(notes.windows.map((x) => !!x.min), [false, true]);
  calls.length = 0;
  server.emit(`t:${T.DECK_PLACE}`, { wid: 11, restore: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(calls, [['winop', 11, 'restore']]);
  server.emit(`t:${T.DECK_PLACE}`, { wid: 11, display: 'd1', zone: { x: 0, y: 0, w: 6, h: 12 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(calls[1][0], 'frame', 'into a zone: placed (which brings it back)');
  calls.length = 0;
  server.emit(`t:${T.DECK_ARRANGE}`, { display: 'd1', items: [{ key: 'com.microsoft.VSCode', zone: { x: 0, y: 0, w: 6, h: 12 } }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'frame').map((c) => c[1]), [11], 'arranged too');
  calls.length = 0;
  for (const op of ['close', 'min', 'full', 'max']) server.emit(`t:${T.DECK_PLACE}`, { wid: 7, op });
  server.emit(`t:${T.DECK_PLACE}`, { wid: 7, op: 'rm -rf' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls.slice(0, 3), [['winop', 7, 'close'], ['winop', 7, 'min'], ['winop', 7, 'full']], 'a window\'s own buttons');
  assert.strictEqual(calls[3][0], 'frame', 'Mac maximize: the whole display');
  assert.strictEqual(calls.length, 4, 'nothing else');
  fakeSys.wins = realWins;
  // Windows: a program matched to the Start menu app that starts it, nothing else.
  const opened = [];
  const wd = new Deck({ platform: 'win', server: new EventEmitter(), load: () => null, save: () => {}, helper: fakeHelper, onChange: () => {},
    sys: { ...fakeSys, apps: async () => [{ id: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Google\\Chrome\\Application\\chrome.exe', name: 'Chrome' }, { id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calculator' }], openApp: async (id) => opened.push(id) } });
  await wd._launch('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  await wd._launch('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
  await assert.rejects(wd._launch('C:\\Users\\me\\evil.exe'));
  assert.deepStrictEqual(opened, ['{6D809377-6AF0-444B-8957-A3773F02200E}\\Google\\Chrome\\Application\\chrome.exe', 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']);
  wd.shutdown();

  server.emit('closed');
  assert.deepStrictEqual(d.view().surface, []);
  assert.ok(changed > 0);
  for (const x of [...Deck.all]) x.shutdown();

  // The rule: no command lines from the Deck, and nothing started on Windows but through the helper.
  const src = fs.readFileSync(path.join(__dirname, '..', 'deck-sys.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'deck.js'), 'utf8');
  assert.ok(!/powershell|cmd\.exe|rundll32|wscript|cscript|mshta|reg\.exe|osascript|ExecutionPolicy|EncodedCommand|Add-Type/i.test(src), 'no shells or script hosts');
  const sysSrc = fs.readFileSync(path.join(__dirname, '..', 'deck-sys.js'), 'utf8');
  assert.ok(!/child_process/.test(fs.readFileSync(path.join(__dirname, '..', 'deck.js'), 'utf8')), 'the engine starts nothing');
  assert.deepStrictEqual(sysSrc.match(/require\('child_process'\)/g), ["require('child_process')"]);
  assert.strictEqual((sysSrc.match(/cp\.\w+/g) || []).join(), 'cp.execFile', 'only execFile, once, in run(): no shell, no spawn');
  assert.ok(/shell:\s*false/.test(sysSrc), 'Linux tools run directly');
  // run() is only reached on Linux: every call to it sits behind a Linux check in its method.
  const winMac = sys('win', { helper: { request: async (c) => { throw new Error('helper: ' + c); } }, press: () => {} });
  const ran = [];
  require('child_process').execFile = (...a) => { ran.push(a[0]); a[a.length - 1](new Error('no')); };
  for (const m of ['audio', 'bt', 'bright', 'state']) await winMac[m]().catch(() => {});
  await winMac.volume({ level: 0.5 }).catch(() => {});
  await winMac.sys('lock').catch(() => {});
  await winMac.setBright('', 0.5).catch(() => {});
  assert.deepStrictEqual(ran, [], 'Windows: nothing started, all through the helper');

  console.log('deck: ok');
})().catch((e) => { console.error(e); process.exit(1); });
