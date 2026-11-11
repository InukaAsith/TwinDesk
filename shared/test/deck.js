// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck: the layout (shared/deck-model.js) and the computer's side (shared/deck.js) with a fake
// phone session and helper. Run with: node shared/test/deck.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const M = require('../deck-model.js');
const P = require('../protocol.js');
const { Deck, startDeck } = require('../deck.js');

const T = P.T;

// ---- model ----
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
assert.deepStrictEqual(M.action({ k: 'sys', what: 'shutdown' }), { k: 'none' }, 'only lock and sleep');
assert.deepStrictEqual(M.action({ k: 'evil' }), { k: 'none' });

const starter = M.normalize(null);
assert.strictEqual(starter.pages.length, 2, 'a first layout to start from');
assert.ok(starter.pages[0].buttons.some((b) => b.action.k === 'media'));
{
  const l = M.normalize({ cols: 99, rows: 1, pages: [{ id: 'a', name: 'A', buttons: [
    { id: 'x', slot: 0, label: 'X', action: { k: 'keys', combo: 'Mod+KeyZ' } },
    { id: 'y', slot: 0, label: 'dup slot' },
    { id: 'z', slot: 50, label: 'past the grid' },
    { id: 'w', slot: 1, label: 'to gone page', action: { k: 'page', to: 'nope' } },
  ] }] });
  assert.strictEqual(l.cols, 8);
  assert.strictEqual(l.rows, 2);
  assert.deepStrictEqual(l.pages[0].buttons.map((b) => b.id), ['x', 'w']);
  assert.deepStrictEqual(l.pages[0].buttons[1].action, { k: 'none' });
  // Moves: onto an empty slot, a swap, onto another page.
  let m = M.move(l, 'a', 'x', 'a', 5);
  assert.strictEqual(M.find(m, 'a', 'x').slot, 5);
  m = M.move(m, 'a', 'w', 'a', 5);
  assert.strictEqual(M.find(m, 'a', 'w').slot, 5);
  assert.strictEqual(M.find(m, 'a', 'x').slot, 1, 'swapped');
  m.pages.push({ id: 'b', name: 'B', buttons: [] });
  m = M.move(m, 'a', 'x', 'b', 0);
  assert.ok(M.find(m, 'b', 'x') && !M.find(m, 'a', 'x'));
}

// ---- the computer's side ----
function fake(os = 'android') {
  const server = new EventEmitter();
  server.sent = [];
  server.current = { name: 'Pixel', os };
  server.sendToClient = (m) => server.sent.push(m);
  const helper = { log: [], send(cmd, a) { this.log.push([cmd, a]); }, request: async () => ({ apps: [{ id: 'com.x', name: 'X' }] }) };
  return { server, helper };
}
(async () => {
  {
    const { server, helper } = fake();
    let saved = null;
    const opened = [];
    const deck = new Deck({ server, helper, platform: 'mac', load: () => saved, save: (l) => { saved = l; },
      devLocal: () => ({ can: () => ({ lock: true }), do: async (c) => opened.push(['sys', c.do]) }),
      apps: { list: async () => [{ id: 'a', name: 'A' }], open: async (id) => opened.push(['app', id]) },
      bright: { can: () => false, step() {} }, openUrl: (u) => opened.push(['url', u]), readClipboard: () => 'clip!', onChange() {} });
    assert.deepStrictEqual(server.sent, [{ t: T.DECK_OFFER, v: 1 }], 'offered to the phone already there');
    server.emit(`t:${T.DECK_RUN}`, { page: 'main', id: 's1' });
    assert.strictEqual(helper.log.length, 0, 'nothing runs before the phone says it has a Deck');
    server.emit(`t:${T.DECK_HELLO}`, {});
    const lay = server.sent.find((m) => m.t === T.DECK_LAYOUT);
    assert.ok(lay && lay.mac && lay.layout.pages.length === 2);
    assert.ok(lay.can.includes('sys') && !lay.can.includes('bright'), 'only what this computer can do');
    assert.deepStrictEqual(Deck.view().surface, ['Pixel']);

    await deck.run('main', 's1'); // Play/Pause
    assert.deepStrictEqual(helper.log.map(([, a]) => [a.ev.t, a.ev.code]), [[T.K_KEY_DOWN, 'MediaPlayPause'], [T.K_KEY_UP, 'MediaPlayPause']]);
    assert.deepStrictEqual(server.sent.pop(), { t: T.DECK_DONE, id: 's1', ok: true });
    await new Promise((r) => setTimeout(r, 80));
    helper.log.length = 0;
    await deck.run('keys', 's2'); // Undo: ⌘Z on a Mac
    assert.deepStrictEqual(helper.log.map(([, a]) => `${a.ev.t === T.K_KEY_DOWN ? 'd' : 'u'}${a.ev.code}`), ['dMetaLeft', 'dKeyZ', 'uKeyZ', 'uMetaLeft']);
    await new Promise((r) => setTimeout(r, 80));
    await deck.run('main', 'nope');
    assert.strictEqual(server.sent.pop().ok, false);
    await new Promise((r) => setTimeout(r, 80));
    await deck.run('main', 's10'); // Lock
    assert.deepStrictEqual(opened.pop(), ['sys', 'lock']);

    // Edited on the phone: normalized, kept, sent back.
    server.emit(`t:${T.DECK_SAVE}`, { layout: { cols: 3, rows: 2, pages: [{ id: 'p', name: 'P', buttons: [{ id: 'u', slot: 0, action: { k: 'url', url: 'example.com' } }] }] } });
    assert.strictEqual(saved.cols, 3);
    assert.deepStrictEqual(server.sent.pop().layout, saved);
    await new Promise((r) => setTimeout(r, 80));
    await deck.run('p', 'u');
    assert.deepStrictEqual(opened.pop(), ['url', 'https://example.com/']);
    await deck.exec({ k: 'clip', what: 'send' });
    assert.deepStrictEqual(server.sent.pop(), { t: T.DECK_CLIP, text: 'clip!' });

    server.emit(`t:${T.DECK_APPS}`, {});
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(server.sent.pop(), { t: T.DECK_APPS, apps: [{ id: 'a', name: 'A' }] });

    server.emit('closed');
    assert.deepStrictEqual(Deck.view().surface, []);
    deck.shutdown();
  }
  {
    // A computer in session gets no offer; startDeck takes the phones' session later.
    const { server, helper } = fake('win');
    let settings = { deck: null };
    const d = startDeck({ platform: 'win', helper: () => helper, server: null, settings: () => settings, saveSettings() {}, devLocal: () => null, openUrl() {}, readClipboard: () => '', onChange() {} });
    d.attach(server);
    assert.deepStrictEqual(server.sent, [], 'no Deck offered to a computer');
    server.current = { name: 'Phone', os: 'ios' };
    server.emit('client', server.current);
    assert.deepStrictEqual(server.sent, [{ t: T.DECK_OFFER, v: 1 }]);
    d.save({ pages: [{ id: 'q', name: 'Q', buttons: [] }] });
    assert.strictEqual(settings.deck.pages[0].id, 'q');
    for (const x of [...Deck.all]) x.shutdown();
  }
  console.log('deck: ok');
})().catch((e) => { console.error(e); process.exit(1); });
