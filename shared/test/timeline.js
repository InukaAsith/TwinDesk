// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Activity timeline: normalize clipboard, notifications, files and calls already in state.
// Run with: node shared/test/timeline.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TL = require('../timeline.js');
const Modules = require('../modules.js');
const Side = require('../sidebar-model.js');
const Search = require('../search-index.js');

const root = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

assert.deepStrictEqual(TL.KINDS, ['clip', 'notif', 'file', 'call']);
assert.strictEqual(TL.atOf(undefined), 0);
assert.strictEqual(TL.atOf(null), 0);
assert.strictEqual(TL.atOf(-5), 0);
assert.strictEqual(TL.atOf(0), 0);
assert.strictEqual(TL.atOf(NaN), 0);
assert.strictEqual(TL.atOf('nope'), 0);
assert.strictEqual(TL.atOf(' 1500 '), 1500);
assert.strictEqual(TL.atOf(42.5), 42.5);
assert.strictEqual(TL.str(null), '');
assert.strictEqual(TL.str({ a: 1 }), '');
assert.strictEqual(TL.str(false), 'false');
assert.strictEqual(TL.str(3), '3');
assert.strictEqual(TL.str('abcdef', 3), 'abc');
assert.strictEqual(TL.baseName('C:\\Users\\a\\Report.PDF'), 'Report.PDF');
assert.strictEqual(TL.baseName('/tmp/dir/notes.txt'), 'notes.txt');
assert.strictEqual(TL.baseName(''), '');

const xss = '<script>alert(1)</script>';
const raw = 'literal {name} &lt;b&gt;';
const long = ('line\n'.repeat(4000)) + 'TAIL';
const state = {
  clipboard: { history: [
    null, 1, 'nope',
    { dir: 'in', at: 3000, text: xss + ' hello', from: 'Pixel' },
    { dir: 'out', at: 1000, text: '   ' },
    { at: -8, text: 'old' },
    { at: 2500, text: '', image: { w: 10, h: 20, shot: true, copy: false } },
    { at: 2400, text: 'cap', image: { w: '4', h: 'no', copy: true } },
    { at: 2200, text: 'see', file: { name: 'shot.png', path: '/tmp/shot.png' } },
    { at: 2100, path: '/tmp/only.txt' },
    { at: 4000, text: long },
    { at: '1500', text: raw },
  ] },
  notifs: {
    history: [
      { id: 'nx', at: 100, appName: 'Mail', title: 'Hi', subtitle: 'Re', body: 'Body ' + xss },
      { id: 'n1', at: 5000, appName: 'Mail', title: 'Hi newer', body: 'updated' },
      { at: 800, title: 12, body: { no: true }, app: 7 },
    ],
    active: [{ id: 'n1', at: 100, title: 'stale' }],
  },
  files: {
    recent: [
      { name: 'Report.PDF', size: 3, path: '/Users/a/Report.PDF', at: 3500, ok: true },
      { name: '', path: '/tmp/noname.bin', at: 600, ok: false, error: 'disk full' },
    ],
    sent: [
      { name: 'up.txt', size: 1, path: '/secret/up.txt', at: 3400, ok: true, where: 'Phone/Downloads' },
      { name: 'bad.txt', at: 900, ok: false, error: 'refused' },
    ],
    outbox: [{ id: 'ob1', state: 'paused', name: '', files: 2, peerName: 'MacBook', at: 3300 }],
  },
  drop: { recent: [{ name: 'Report.PDF', path: '/Users/a/Report.PDF', at: 3500, ok: true }] },
  outbox: [{ id: 'ob1', state: 'paused', name: '', files: 2, peerName: 'MacBook', at: 100 }],
  hub: {
    calls: true,
    call: { state: 'offhook', number: '+15551212', name: 'Ada', dir: 'out', since: 4500 },
    ended: { state: 'ringing', number: '+15550000', name: 'Bea', dir: 'in', missed: true, at: 500 },
    callLog: [
      { number: '123', name: 'Cy', type: 'missed', at: 700, dur: 0 },
      { number: 404, type: 'out', at: 650 },
    ],
  },
  calls: [{ id: 'c9', number: '999', name: 'Dee', type: 'voicemail', at: 640 }],
};

const boom = {};
Object.defineProperty(boom, 'text', { get() { throw new Error('boom'); } });
assert.doesNotThrow(() => TL.build({
  clipboard: { history: [boom] }, notifs: null, files: 'nope', drop: 4,
  hub: { calls: true, call: 'nope', ended: [], callLog: 'x' }, calls: { no: true },
}));

const items = TL.build(state);
const byKind = (k) => items.filter((it) => it.kind === k);

const clipXss = items.find((it) => it.copyText && it.copyText.includes(xss) && it.kind === 'clip');
assert.ok(clipXss, 'clipboard text kept');
assert.strictEqual(clipXss.copyText, xss + ' hello');
assert.ok(!clipXss.copyText.includes('&lt;'), 'no HTML escaping');
assert.strictEqual(clipXss.title, xss + ' hello');
assert.strictEqual(clipXss.peer, 'Pixel');
assert.strictEqual(clipXss.at, 3000);

const blank = items.find((it) => it.meta && it.meta.blank);
assert.ok(blank, 'whitespace clip kept');
assert.strictEqual(blank.title, '');
assert.strictEqual(blank.copyText, '   ');

const old = items.find((it) => it.copyText === 'old');
assert.strictEqual(old.at, 0, 'negative time sorts as oldest');

const shot = items.find((it) => it.meta && it.meta.shot);
assert.strictEqual(shot.kind, 'clip');
assert.strictEqual(shot.meta.image, true);
assert.strictEqual(shot.meta.copy, false);
assert.strictEqual(shot.meta.w, 10);
assert.strictEqual(shot.path, '');

const pic = items.find((it) => it.meta && it.meta.image && !it.meta.shot);
assert.strictEqual(pic.meta.copy, true);
assert.strictEqual(pic.meta.w, 4);
assert.strictEqual(pic.meta.h, 0);

const clipFile = items.find((it) => it.kind === 'clip' && it.meta && it.meta.file && it.title === 'shot.png');
assert.ok(clipFile);
assert.strictEqual(clipFile.path, '/tmp/shot.png');
const clipPath = items.find((it) => it.path === '/tmp/only.txt');
assert.strictEqual(clipPath.kind, 'clip');

const big = items.find((it) => it.kind === 'clip' && it.copyText && it.copyText.length === TL.COPY);
assert.ok(big);
assert.ok(big.title.length <= TL.PREVIEW && big.title.startsWith('line'));
assert.ok(!big.title.includes('\n'));
assert.ok(big.copyText.includes('\n'), 'copy keeps whitespace');

const braces = items.find((it) => it.copyText === raw);
assert.strictEqual(braces.title, raw);
assert.strictEqual(braces.at, 1500);

const note = items.find((it) => it.id === 'notif:n1');
assert.ok(note);
assert.strictEqual(note.at, 5000, 'same id keeps the newer one');
assert.strictEqual(note.title, 'Hi newer');
assert.strictEqual(items.filter((it) => it.id === 'notif:n1').length, 1);
const noteBody = items.find((it) => it.kind === 'notif' && it.body && it.body.includes(xss));
assert.strictEqual(noteBody.body, 'Body ' + xss);
assert.strictEqual(noteBody.peer, 'Mail');
assert.ok(noteBody.copyText.includes('Hi') && noteBody.copyText.includes(xss));

const got = items.find((it) => it.path === '/Users/a/Report.PDF');
assert.ok(got);
assert.strictEqual(got.kind, 'file');
assert.strictEqual(items.filter((it) => it.path === '/Users/a/Report.PDF').length, 1, 'files.recent and drop.recent collapse');
const noname = items.find((it) => it.path === '/tmp/noname.bin');
assert.strictEqual(noname.title, 'noname.bin');
assert.strictEqual(noname.meta.ok, false);
assert.strictEqual(noname.body, 'disk full');

const sent = items.find((it) => it.title === 'up.txt');
assert.strictEqual(sent.path, '', 'a sent file has no local path to reveal');
assert.strictEqual(sent.subtitle, 'Phone/Downloads');
assert.strictEqual(sent.meta.dir, 'out');
const failed = items.find((it) => it.title === 'bad.txt');
assert.strictEqual(failed.meta.ok, false);
assert.strictEqual(failed.body, 'refused');

const wait = items.filter((it) => it.id === 'file:wait:ob1');
assert.strictEqual(wait.length, 1, 'the same outbox id collapses');
assert.strictEqual(wait[0].at, 3300);
assert.strictEqual(wait[0].meta.waiting, true);
assert.strictEqual(wait[0].meta.files, 2);
assert.strictEqual(wait[0].meta.state, 'paused');
assert.strictEqual(wait[0].peer, 'MacBook');

assert.ok(!items.some((it) => it.kind === 'call' && it.title === 'true'), 'hub.calls true is a setting, not a call');
const live = items.find((it) => it.meta && it.meta.live);
assert.strictEqual(live.kind, 'call');
assert.strictEqual(live.title, 'Ada');
assert.strictEqual(live.body, '+15551212');
assert.strictEqual(live.at, 4500);
assert.strictEqual(live.meta.dir, 'out');
const missed = items.find((it) => it.title === 'Bea');
assert.strictEqual(missed.meta.missed, true);
const cy = items.find((it) => it.title === 'Cy');
assert.strictEqual(cy.meta.type, 'missed');
const num = items.find((it) => it.title === '404');
assert.strictEqual(num.kind, 'call');
assert.strictEqual(num.meta.type, 'out');
const dee = items.find((it) => it.id === 'call:c9');
assert.strictEqual(dee.meta.type, 'voicemail');

for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at, 'newest first');
assert.strictEqual(items[items.length - 1].copyText, 'old');
const tied = TL.build({
  clipboard: { history: [{ at: 5, text: 'first' }] },
  notifs: { history: [{ at: 5, title: 'second' }] },
});
assert.deepStrictEqual(tied.map((it) => it.kind), ['clip', 'notif'], 'equal times keep source order');

assert.deepStrictEqual(byKind('clip').map((it) => it.kind).every((k) => k === 'clip'), true);
const clips = TL.filter(items, { category: 'clip' });
assert.ok(clips.length && clips.every((it) => it.kind === 'clip'));
assert.ok(TL.filter(items, { category: 'nope' }).length === items.length);
assert.deepStrictEqual(TL.filter(null, { category: 'file' }), []);

const found = TL.filter(items, { query: 'REPORT pdf' });
assert.deepStrictEqual(found.map((it) => it.path), ['/Users/a/Report.PDF']);
const both = TL.filter(items, { query: 'pixel SCRIPT' });
assert.ok(both.some((it) => it.copyText && it.copyText.startsWith(xss)));
assert.deepStrictEqual(TL.filter(items, { query: 'pixel missing' }), []);
assert.deepStrictEqual(TL.filter(items, { query: '   ' }).length, items.length);
assert.ok(TL.filter(items, { category: 'call', query: 'ADA' }).some((it) => it.title === 'Ada'));
assert.ok(TL.matchQuery({ title: 'A', subtitle: '', body: '', peer: 'Bee', path: '' }, 'bee'));
assert.ok(!TL.matchQuery({ title: 'A', subtitle: '', body: '', peer: '', path: '/x/y/Zed.txt' }, 'nope'));
assert.ok(TL.matchQuery({ title: '', subtitle: '', body: '', peer: '', path: '/x/y/Zed.txt' }, 'zed'));

const c = TL.counts(items, 'report');
assert.strictEqual(c.file, 1);
assert.strictEqual(c.all, 1);
assert.strictEqual(c.clip, 0);
const many = [];
for (let i = 0; i < 3; i++) many.push({ at: i + 1, text: 't' + i });
assert.strictEqual(TL.build({ clipboard: { history: many } }).length, 3);
const over = [];
for (let i = 0; i < 600; i++) over.push({ at: i + 1, text: 'n' + i });
assert.strictEqual(TL.build({ clipboard: { history: over } }).length, 500);

const meta = Object.create(null);
meta.__proto__ = 'nope';
meta['bad key'] = 1;
meta.ok = true;
assert.doesNotThrow(() => TL.build({ files: { recent: [{ name: 'm', path: '/m', at: 3, ok: true, extra: meta }] } }));

// Wiring: Mac, Windows and Linux, one-to-one and Mesh. No new protocol. Phones stay out.
const pageSrc = read('mac/ui-timeline.js');
assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(pageSrc));
assert.ok(!/search\.value\s*=/.test(pageSrc));
assert.ok(!/shell\.|exec\(|spawn\(/.test(pageSrc));
for (const html of ['mac/control.html', 'mac/mesh/control.html']) {
  const s = read(html);
  assert.ok(s.includes('../shared/timeline.js'), html);
  assert.ok(s.includes('data-src="ui-timeline.js"'), html);
  assert.ok(s.indexOf('../shared/timeline.js') < s.indexOf('data-src="ui-timeline.js"'), html);
}
for (const f of ['mac/ipc.js', 'mac/mesh/ipc.js']) {
  const s = read(f);
  assert.ok(s.includes('copyLiteral'), f);
  assert.ok(s.includes("'activity'"), f);
  assert.ok(!/copyLiteral\(text\) \{[^}]*shell/.test(s), f);
}
for (const f of ['mac/preload-control.js', 'mac/mesh/preload-control.js']) assert.ok(read(f).includes("'copyLiteral'"), f);
assert.strictEqual(Modules.ofPage('activity'), 'activity');
assert.ok(!Modules.scriptOn(['activity'], 'ui-timeline.js'));
assert.ok(Modules.scriptOn([], 'mac/ui-timeline.js'));
assert.ok(!Side.isScoped('activity'));
assert.ok(Side.sectionVisible('activity', 'phone') && Side.sectionVisible('activity', 'computer'));
assert.ok(Search.forApp('mac').some((e) => e.id === 'activity' && e.t === 'Activity'));
for (const os of ['windows', 'linux']) {
  assert.ok(Search.forApp(os).some((e) => e.id === 'activity' && e.page === 'activity' && e.t === 'Activity'), os);
}
for (const os of ['android', 'ios']) {
  assert.ok(!Search.forApp(os).some((e) => e.id === 'activity' || e.page === 'activity'), os);
}
assert.strictEqual(Search.match('activity timeline', Search.forApp('mac'))[0].t, 'Activity');
assert.strictEqual(Search.match('activity timeline', Search.forApp('windows'))[0].t, 'Activity');
assert.strictEqual(Search.match('activity timeline', Search.forApp('linux'))[0].t, 'Activity');
assert.ok(read('mac/control.js').includes("activity:"));
const pageSrcWin = read('shared/ui-timeline.js');
assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(pageSrcWin));
assert.ok(!/search\.value\s*=/.test(pageSrcWin));
assert.ok(!/shell\.|exec\(|spawn\(/.test(pageSrcWin));
assert.ok(pageSrcWin.includes('Show in Explorer') && pageSrcWin.includes('Show in folder'));
assert.ok(pageSrcWin.includes('TL.revealItem'));
assert.ok(!pageSrcWin.includes('showItemInFolder'));
for (const html of ['windows/app.html', 'windows/mesh/app.html', 'linux/app.html', 'linux/mesh/app.html']) {
  const s = read(html);
  assert.ok(s.includes('../shared/timeline.js'), html);
  assert.ok(s.includes('data-src="../shared/ui-timeline.js"'), html);
  assert.ok(s.indexOf('../shared/timeline.js') < s.indexOf('data-src="../shared/ui-timeline.js"'), html);
}
for (const f of ['windows/ipc.js', 'windows/mesh/ipc.js', 'linux/ipc.js', 'linux/mesh/ipc.js']) {
  const s = read(f);
  const i = s.indexOf("handle('copyLiteral'");
  assert.ok(i >= 0, f);
  const body = s.slice(i, i + 320);
  assert.ok(body.includes('256 * 1024'), f);
  assert.ok(!/shell|exec\(|spawn\(/.test(body), f);
  assert.ok(s.includes('revealDrop'), f);
  assert.ok(!/showItemInFolder/.test(s), f);
}
for (const f of ['windows/preload-app.js', 'windows/mesh/preload-app.js', 'linux/preload-app.js', 'linux/mesh/preload-app.js']) {
  const s = read(f);
  assert.ok(s.includes('copyLiteral'), f);
  assert.ok(s.includes('revealDrop'), f);
}
for (const f of ['windows/settings.js', 'linux/settings.js']) assert.ok(read(f).includes("'activity'"), f);
for (const f of ['windows/app.js', 'windows/mesh/app.js', 'linux/app.js', 'linux/mesh/app.js']) {
  const s = read(f);
  assert.ok(s.includes('activity: 4'), f);
  assert.ok(s.includes('activity: 39'), f);
}
for (const f of ['windows/ui-kit.js', 'linux/ui-kit.js']) assert.ok(read(f).includes('activity:'), f);
for (const f of ['windows/filerecv.js', 'linux/filerecv.js']) {
  const s = read(f);
  assert.ok(s.includes('reveal(index)'), f);
  assert.ok(!/reveal\s*\(\s*path/.test(s), f);
  assert.ok(s.includes('Number.isInteger(index)'), f);
  assert.ok(s.includes('showItemInFolder'), f);
}
for (const f of ['windows/main.js', 'windows/mesh/main.js', 'linux/main.js', 'linux/mesh/main.js']) {
  assert.ok(read(f).includes('fileRecv.recent'), f);
}
for (const locale of ['zh-CN', 'ru', 'pt-BR', 'tr']) {
  const catalog = require(`../lang/${locale}.js`);
  for (const key of ['Activity', 'No activity yet', 'No matching items', 'Search activity', 'Clipboard, notifications, files and calls, newest first.', 'Show in Explorer', 'Show in folder']) {
    assert.notStrictEqual(catalog[key], key, `${locale} ${key}`);
  }
}

// The page: literal text, search caret, copy and reveal, history unlock only while it is open.
function harness(api, src = 'mac/ui-timeline.js', platform = 'MacIntel') {
  class El {
    constructor(tag, props = {}, children = []) {
      this.tag = tag; this.children = []; this.attrs = {}; this.hidden = false; this._text = '';
      this.classList = { toggle: (c, on) => { const set = new Set((this.className || '').split(/\s+/).filter(Boolean)); if (on) set.add(c); else set.delete(c); this.className = [...set].join(' '); } };
      for (const [k, v] of Object.entries(props || {})) {
        if (k === 'class') this.className = v;
        else if (k === 'text') this.textContent = v;
        else if (k === 'attrs') for (const [a, av] of Object.entries(v)) this.setAttribute(a, av);
        else this[k] = v;
      }
      this.append(...[].concat(children || []));
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    append(...items) { for (const c of items) if (c != null && c !== false) this.children.push(c); }
    replaceChildren(...items) { this.children = items.filter((c) => c != null && c !== false); }
    get textContent() { return this._text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  }
  const el = (tag, props, children) => new El(tag, props, children);
  let tab;
  const UI = {
    api, state: null, tabs: [],
    tab(v) { tab = v; },
    el, icon: () => el('svg'),
    card(_t, rows) { return el('div', {}, rows); },
    button(label, onClick, cls) { const b = el('button', { class: cls || '', text: label }); b.onclick = onClick; return b; },
    ago: (ts) => (ts ? 'ago' : 'never'),
  };
  const I18n = { t: (s, v) => (v && v.count != null ? String(s).replace('{count}', v.count) : s) };
  const window = {};
  vm.runInNewContext(read('shared/timeline.js') + '\n' + read(src), { UI, I18n, window, navigator: { platform } }, { filename: src });
  const page = { isConnected: false, hidden: true, offsetParent: null };
  const body = el('div');
  const render = tab.build(body, page);
  const card = body.children[0];
  const search = card.children[0].children[0];
  const chips = card.children[0].children[1].children;
  const list = card.children[1];
  const empty = card.children[2];
  return { tab, render, page, search, chips, list, empty, UI };
}

{
  const { render, page, search, list, empty, tab } = harness(null);
  assert.strictEqual(tab.id, 'activity');
  assert.strictEqual(empty.textContent, 'No activity yet');
  assert.doesNotThrow(() => render({
    clipboard: { history: [{ at: 5, text: xss }] },
    history: { save: true, open: {} },
    hub: { calls: true },
  }));
  assert.strictEqual(list.children.length, 1);
  const title = list.children[0].children[1].children[0];
  assert.strictEqual(title.textContent, xss);
  assert.strictEqual(title.attrs['data-literal'], '');
  search.value = 'keep me';
  search.selectionStart = 4;
  render({ clipboard: { history: [{ at: 5, text: xss }] } });
  assert.strictEqual(search.value, 'keep me');
  assert.strictEqual(search.selectionStart, 4);
  page.isConnected = true; page.hidden = false; page.offsetParent = {};
  assert.doesNotThrow(() => render({ history: { save: true, open: {} }, clipboard: { history: [] } }));
  assert.strictEqual(empty.textContent, 'No activity yet');
}

{
  const calls = [];
  const unlocked = () => calls.map((m) => ({ do: String(m.do), what: String(m.what) }));
  const api = {
    history: (m) => calls.push(m),
    copyHistory: (i) => calls.push(['hist', i]),
    copyLiteral: (t) => calls.push(['lit', t]),
    copyText: (t) => calls.push(['short', t]),
    revealDrop: (i) => calls.push(['reveal', i]),
  };
  const h = harness(api);
  h.render({ history: { save: true, open: {} }, clipboard: { history: [{ at: 1, text: 'hidden' }] } });
  assert.deepStrictEqual(calls, [], 'locked history stays locked until the page is open');
  h.page.isConnected = true; h.page.hidden = false; h.page.offsetParent = {};
  h.render({ history: { save: true, open: {} }, clipboard: { history: [] } });
  assert.deepStrictEqual(calls.map((m) => m.what).sort(), ['clip', 'notifs']);
  calls.length = 0;
  h.render({ history: { save: true, open: {} }, clipboard: { history: [] } });
  assert.deepStrictEqual(calls, [], 'unlock once');
  h.render({ history: { save: false } });
  calls.length = 0;
  h.render({ history: { save: true, open: { clip: true, notifs: true } }, clipboard: { history: [] } });
  assert.deepStrictEqual(calls, [], 'already open: nothing to unlock');
  h.render({ history: { save: false } });
  h.render({ history: { save: true, open: { clip: true, notifs: false } }, clipboard: { history: [] } });
  assert.deepStrictEqual(unlocked(), [{ do: 'unlock', what: 'notifs' }]);

  const sample = {
    clipboard: { history: [
      { at: 20, dir: 'in', text: 'alpha {me}' },
      { at: 30, text: '', image: { w: 8, h: 9, copy: true } },
      { at: 28, text: '', image: { w: 1, h: 1, copy: false } },
    ] },
    notifs: { history: [{ id: 'z', at: 40, appName: 'Chat', title: 'Ping', body: 'hello {name}' }] },
    files: {
      recent: [{ name: 'a.txt', path: '/tmp/a.txt', at: 50, ok: true }, { name: 'b.txt', path: '/tmp/b.txt', at: 49, ok: true }],
      sent: [{ name: 'c.txt', path: '/tmp/c.txt', at: 48, ok: true, where: 'there' }],
      outbox: [{ id: 'w', state: 'queued', files: 3, peerName: 'Other', at: 47 }],
    },
    hub: { calls: false, call: { state: 'ringing', dir: 'in', since: 60 }, ended: { state: 'idle', number: '+100', name: 'Ada', dir: 'out', at: 10 } },
  };
  h.render(sample);
  assert.strictEqual(h.empty.hidden, true);
  assert.strictEqual(h.list.hidden, false);
  const rows = h.list.children;
  const titleOf = (row) => row.children[1].children[0].textContent;
  const buttons = (row) => row.children.filter((c) => c.tag === 'button').map((b) => b.textContent);
  assert.ok(rows.map(titleOf).includes('alpha {me}'));
  assert.ok(rows.map(titleOf).includes('Ping — hello {name}'));
  assert.ok(rows.map(titleOf).includes('Picture · 8 × 9'));
  assert.ok(rows.map(titleOf).includes('3 files'));
  assert.ok(rows.map(titleOf).includes('Unknown number'));
  const alpha = rows.find((r) => titleOf(r) === 'alpha {me}');
  assert.ok(alpha.children[1].children[0].attrs['data-literal'] === '');
  assert.ok(!rows.find((r) => titleOf(r) === 'Picture · 8 × 9').children[1].children[0].attrs['data-literal']);
  calls.length = 0;
  alpha.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['hist', 0]]);
  const pic = rows.find((r) => titleOf(r) === 'Picture · 8 × 9');
  calls.length = 0;
  pic.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['hist', 1]]);
  const locked = rows.find((r) => titleOf(r) === 'Picture · 1 × 1');
  assert.ok(!buttons(locked).includes('Copy'));
  const note = rows.find((r) => titleOf(r).startsWith('Ping'));
  calls.length = 0;
  note.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['lit', 'Ping\nhello {name}']]);
  const file = rows.find((r) => titleOf(r) === 'a.txt');
  assert.deepStrictEqual(buttons(file), ['Show in Finder']);
  calls.length = 0;
  file.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['reveal', 0]]);
  const other = rows.find((r) => titleOf(r) === 'b.txt');
  calls.length = 0;
  other.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['reveal', 1]]);
  const sent = rows.find((r) => titleOf(r) === 'c.txt');
  assert.ok(!buttons(sent).includes('Show in Finder'));
  assert.ok(sent.textContent.includes('there'));
  h.search.value = 'a.txt';
  h.search.oninput();
  assert.strictEqual(h.search.value, 'a.txt');
  assert.ok(h.list.children.every((r) => titleOf(r) === 'a.txt'));
  assert.strictEqual(h.chips[0].textContent.includes('1'), true);
  h.search.value = 'zzz qq';
  h.search.oninput();
  assert.strictEqual(h.empty.hidden, false);
  assert.strictEqual(h.empty.textContent, 'No matching items');
  h.search.value = '';
  h.search.oninput();
  const filesChip = h.chips[3];
  filesChip.onclick();
  assert.ok(h.list.children.every((r) => buttons(r).includes('Show in Finder') || titleOf(r) === 'c.txt' || titleOf(r) === '3 files'));
  assert.strictEqual(filesChip.attrs['aria-checked'], 'true');
}

{
  const calls = [];
  const h = harness({ copyText: (t) => calls.push(t) });
  h.render({ notifs: { history: [{ id: 's', at: 2, title: 'short' }] } });
  h.list.children[0].children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, ['short']);
  assert.doesNotThrow(() => h.render(null));
}

for (const [platform, label] of [['Win32', 'Show in Explorer'], ['Linux x86_64', 'Show in folder']]) {
  const calls = [];
  const h = harness({
    history: (m) => calls.push(m),
    copyLiteral: (t) => calls.push(['lit', t]),
    revealDrop: (i) => calls.push(['reveal', i]),
  }, 'shared/ui-timeline.js', platform);
  assert.strictEqual(h.tab.id, 'activity');
  h.render({ history: { save: true, open: {} }, clipboard: { history: [{ at: 1, text: 'hidden' }] } });
  assert.deepStrictEqual(calls, [], platform + ' stays locked until the page is open');
  h.page.isConnected = true; h.page.hidden = false; h.page.offsetParent = {};
  h.render({
    history: { save: true, open: { clip: true, notifs: true } },
    notifs: { history: [{ id: 'n', at: 8, title: 'Ping', body: 'hello' }] },
    files: {
      recent: [{ name: 'a.txt', path: '/tmp/a.txt', at: 50, ok: true }, { name: 'bad.txt', at: 49, ok: false }],
      sent: [{ name: 'c.txt', at: 48, ok: true }],
    },
  });
  const titleOf = (row) => row.children[1].children[0].textContent;
  const buttons = (row) => row.children.filter((c) => c.tag === 'button').map((b) => b.textContent);
  const file = h.list.children.find((r) => titleOf(r) === 'a.txt');
  assert.deepStrictEqual(buttons(file), [label], platform);
  assert.strictEqual(file.children[1].children[0].attrs['data-literal'], '');
  calls.length = 0;
  file.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['reveal', 0]], platform);
  const failed = h.list.children.find((r) => titleOf(r) === 'bad.txt');
  assert.ok(!buttons(failed).includes(label), platform);
  const sent = h.list.children.find((r) => titleOf(r) === 'c.txt');
  assert.ok(!buttons(sent).includes(label), platform);
  const note = h.list.children.find((r) => titleOf(r).startsWith('Ping'));
  calls.length = 0;
  note.children.find((c) => c.tag === 'button').onclick();
  assert.deepStrictEqual(calls, [['lit', 'Ping\nhello']], platform);
}

// Runtime FileRecv checks (Windows & Linux): failed or zero-placed paused batches must never
// record ok: true with a revealable reserved path in recent[].
{
  const Module = require('module');
  const os = require('os');
  const origLoad = Module._load;
  const fakeElectron = {
    app: { getPath: () => os.tmpdir() },
    shell: { showItemInFolder: () => {} },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return fakeElectron;
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    for (const rel of ['../../windows/filerecv.js', '../../linux/filerecv.js']) {
      delete require.cache[require.resolve(rel)];
      const mod = require(rel);
      const FileRecv = mod.FileRecv || mod;
      const sent = [];
      const link = { on() {}, send(m) { sent.push(m); } };
      const recv = new FileRecv({
        link,
        helper: { request: () => Promise.resolve() },
        settings: { files: { clipReceived: false } },
        onChange() {},
      });
      // Failed batch: placed[0] was pre-reserved by _offerBatch, but ok === 0.
      recv.batches.set('b-fail', {
        kind: 'send', dir: os.tmpdir(), count: 1, done: 0, ok: 0,
        tops: new Map(), placed: [path.join(os.tmpdir(), 'bad.txt')],
      });
      recv._batchStep('b-fail', false);
      assert.strictEqual(recv.recent.length, 1, rel + ': failed batch recorded');
      assert.strictEqual(recv.recent[0].name, 'bad.txt', rel);
      assert.strictEqual(recv.recent[0].ok, false, rel + ': failed batch must be ok: false');
      assert.strictEqual(recv.recent[0].path, '', rel + ': failed batch must have no revealable path');

      // Paused batch with zero files placed must not record a revealable ok: true entry.
      recv.recent.length = 0;
      recv.batches.set('b-pause-0', {
        kind: 'send', dir: os.tmpdir(), count: 2, done: 0, ok: 0,
        tops: new Map(), placed: [path.join(os.tmpdir(), 'unwritten.txt')],
      });
      recv._paused('b-pause-0');
      assert.strictEqual(recv.recent.length, 0, rel + ': paused batch with 0 ok must not record recent');

      // Paused batch with >= 1 file placed records ok: true with its path.
      recv.batches.set('b-pause-1', {
        kind: 'send', dir: os.tmpdir(), count: 2, done: 1, ok: 1,
        tops: new Map(), placed: [path.join(os.tmpdir(), 'done.txt')],
      });
      recv._paused('b-pause-1');
      assert.strictEqual(recv.recent.length, 1, rel + ': paused batch with >=1 ok records recent');
      assert.strictEqual(recv.recent[0].ok, true, rel);
      assert.strictEqual(recv.recent[0].path, path.join(os.tmpdir(), 'done.txt'), rel);
    }
  } finally {
    Module._load = origLoad;
  }
}

console.log('timeline: ok');
