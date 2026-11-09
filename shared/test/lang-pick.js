// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A window loads English and its own language only; the main process reads a catalog when it's used.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const pick = fs.readFileSync(path.join(ROOT, 'shared/lang/pick.js'), 'utf8');
function written(search, src = 'file:///Applications/TwinDesk.app/Contents/Resources/app/shared/lang/pick.js') {
  const out = [];
  vm.runInNewContext(pick, { URLSearchParams, location: { search }, document: { currentScript: { src }, write: (s) => out.push(s) } });
  return out;
}
assert.deepStrictEqual(written('?language=ru&look=glass'), ['<script src="file:///Applications/TwinDesk.app/Contents/Resources/app/shared/lang/ru.js"></script>']);
assert.deepStrictEqual(written('?kind=mic&language=pt-BR', 'file:///C:/TwinDesk/resources/app/shared/lang/pick.js?v=1'), ['<script src="file:///C:/TwinDesk/resources/app/shared/lang/pt-BR.js"></script>']);
for (const s of ['', '?language=en', '?language=xx', '?language=../../evil', '?language=%22%3E%3Cscript%3E']) assert.deepStrictEqual(written(s), [], s);

// Every page that reads English also reads pick.js (and no other catalog by name), right after it.
const pages = require('child_process').execSync("git ls-files '*.html'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
let n = 0;
for (const p of pages) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  if (!/lang\/en\.js/.test(html)) continue;
  n++;
  assert.ok(/lang\/en\.js"><\/script>\s*<script src="[^"]*lang\/pick\.js"><\/script>\s*<script src="[^"]*i18n\.js">/.test(html), `${p} loads en, pick, then i18n`);
  assert.ok(!/lang\/(zh-CN|ru|tr|pt-BR)\.js/.test(html), `${p} names no other catalog`);
}
assert.ok(n >= 20, 'found the pages');

// Node: only the catalogs used are read.
const catalogs = () => Object.keys(require.cache).filter((k) => k.includes(`${path.sep}lang${path.sep}`)).map((k) => path.basename(k)).sort();
const I18n = require('../i18n.js');
assert.deepStrictEqual(catalogs(), []);
assert.strictEqual(I18n.create('ru').t('General'), require('../lang/ru.js').General);
assert.deepStrictEqual(catalogs(), ['en.js', 'ru.js']);
assert.strictEqual(I18n.create('xx').locale, 'en');
assert.deepStrictEqual(catalogs(), ['en.js', 'ru.js']);
console.log(`lang-pick: ${n} pages load one language; the main process reads catalogs on use`);
