// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Modules (shared/modules.js): settings, pages, scripts, the tray, restart and restore.
// Run with: node shared/test/modules.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../modules.js');
const tray = require('../traymenu.js');

assert.deepStrictEqual(M.normalize(undefined), { off: [], was: [] });
assert.deepStrictEqual(M.normalize({ off: ['terminal', 'nope', 'terminal', 'general'], was: 3 }), { off: ['terminal'], was: [] }, 'unknown, fixed and repeated ids dropped');
for (const id of M.FIXED) assert.strictEqual(M.ofPage(id), null, `${id} is never a module`);
assert.strictEqual(M.ofPage('pc-mac'), 'share');
assert.strictEqual(M.ofPage('mac-pc'), 'receive');
assert.strictEqual(M.ofPage('ios-mirror'), 'mirror');
assert.ok(M.pageOff(['web'], 'wd-overview'));
assert.ok(!M.pageOff(['web'], 'general'));

// Scripts: a module's own is skipped, a shared one stays while any of its modules is on.
assert.ok(!M.scriptOn(['terminal'], 'ui-terminal.js'));
assert.ok(!M.scriptOn(['calls'], '../shared/ui-calls.js'));
assert.ok(M.scriptOn(['cursor'], '../shared/mesh-intro.js'), 'Multi-device still needs it');
assert.ok(!M.scriptOn(['cursor', 'multi'], '../shared/mesh-intro.js'));
assert.ok(M.scriptOn(['mirror'], '../shared/ui-mirror.js'), 'Phone apps still needs it');
assert.ok(M.scriptOn(['web', 'airplay'], '../shared/ui-web.js'), 'shared by core pages: always loaded');

// Off remembers whether its page was on; on again restores it after the restart.
let c = M.set({}, 'camera', false, true);
assert.deepStrictEqual(c, { off: ['camera'], was: ['camera'] });
assert.deepStrictEqual(M.view(c, []), { off: ['camera'], atStart: [], restart: true, restore: [] }, 'off: restart, nothing to restore yet');
assert.strictEqual(M.view(c, ['camera']).restart, false, 'restarted');
c = M.set(c, 'camera', true);
assert.deepStrictEqual(M.view(c, ['camera']).restore, [], 'switched back on, not yet restarted');
assert.deepStrictEqual(M.view(c, []).restore, ['camera'], 'after the restart: its page goes back on');
c = M.restored(c, 'camera');
assert.deepStrictEqual(c, { off: [], was: [] });
assert.deepStrictEqual(M.set({}, 'files', false, false).was, [], 'it was off: stays off');
assert.strictEqual(M.offQuery({ off: ['a', 'terminal', 'deck'] }), 'terminal,deck');

// Every module script named in SCRIPTS that a window lists goes through modload.js, and every module
// page script is listed somewhere.
for (const html of ['mac/control.html', 'windows/app.html', 'linux/app.html']) {
  const s = fs.readFileSync(path.join(__dirname, '..', '..', html), 'utf8');
  for (const [, src] of s.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    assert.ok(!M.SCRIPTS[src.split('/').pop()], `${html}: ${src} is a module script, load it with modload.js`);
  }
  assert.ok(s.indexOf('shared/modules.js') < s.indexOf('modload.js'), `${html}: modules.js before the first module script`);
  assert.ok(s.indexOf('shared/ui-kinds.js') < s.indexOf('shared/modules.js'), `${html}: modules.js wraps ui-kinds' UI.tab`);
}

// The tray: menus of modules that are off aren't there.
const sw = () => ({ checked: false, set() {} });
const model = (off) => ({ off, connected: true, status: 'x', shared: sw(), keyboard: sw(), drive: { label: 'd', ...sw() }, popup: sw(), screen: [{ label: 's', ...sw() }],
  clipboard: sw(), sound: sw(), drag: sw(), shortcuts: { label: 'k', ...sw() }, found: [], byAddress() {}, lookAgain() {}, open() {}, quit() {} });
const labels = (tpl) => tpl.map((i) => i.label).filter(Boolean);
assert.deepStrictEqual(labels(tray.template(model([]))), ['x', 'Cursor Sharing', 'Mouse and Keyboard', 'Screen', 'Clipboard and Sound', 'Files', 'Connection', 'Open TwinDesk…', 'Quit TwinDesk']);
assert.deepStrictEqual(labels(tray.template(model(['cursor', 'keyboard', 'share', 'receive', 'files', 'clipboard', 'audio']))), ['x', 'Connection', 'Open TwinDesk…', 'Quit TwinDesk']);
const mk = tray.template(model(['cursor'])).find((i) => i.label === 'Mouse and Keyboard');
assert.deepStrictEqual(mk.submenu.map((i) => i.label), ['Share Keyboard']);
const cs = tray.template(model(['audio'])).find((i) => i.label === 'Clipboard and Sound');
assert.deepStrictEqual(cs.submenu.map((i) => i.label), ['Share Clipboard']);

console.log('modules: ok');
