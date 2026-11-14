// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const shortcut = require('../../mac/emergency-shortcut');
for (const value of [shortcut.DEFAULT, 'Control+Alt+R', 'F14', 'Command+Shift+Left', 'Command+Escape']) assert.equal(shortcut.valid(value), value);
for (const value of ['', 'R', 'Shift+R', 'Control+Control+R', 'Control+F24', 'Foo+R', null]) assert.equal(shortcut.valid(value), shortcut.DEFAULT);
let handler, saved;
const doc = { createElement() { return { classList: { toggle() {} }, setAttribute() {} }; } };
const ctx = { document: doc, MacShareProtocol: { HOTKEYS: [], hotkeyName: () => '' }, macshare: {}, I18n: { t: (s) => s },
  addEventListener(_, cb) { handler = cb; }, removeEventListener() { handler = null; } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require.resolve('../../mac/control.js'), 'utf8'), ctx);
const recorder = ctx.UI.keyRecorder((value) => { saved = value; }, { bare: true, allowEscape: true, valid: (v) => shortcut.valid(v) === v });
const press = (key, code, mods = {}) => handler({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {}, ...mods });
recorder.el.onclick(); press('r', 'KeyR', { ctrlKey: true, altKey: true });
assert.equal(saved, 'Control+Alt+R');
recorder.el.onclick(); press('Escape', 'Escape', { ctrlKey: true, altKey: true, metaKey: true });
assert.equal(saved, shortcut.DEFAULT, 'modified Escape can be recorded');
recorder.el.onclick(); press('Escape', 'Escape');
assert.equal(saved, shortcut.DEFAULT, 'bare Escape cancels recording');
recorder.el.onclick(); press('F24', 'F24');
assert.equal(saved, shortcut.DEFAULT, 'unsupported keys do not replace the recovery shortcut');
recorder.el.onclick();
console.log('emergency shortcut settings and recorder: ok');
