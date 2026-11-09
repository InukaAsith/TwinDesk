// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's translations (web/app.js tr(), web/lang/pick.js): every English text the page passes to
// tr() or trNodes() — and the phone app's pages it shows in a frame (android/…/assets/web: their t()
// and data-i18n/aria-label/placeholder, through TD.tr) and the bridge — has a translation in every
// web/lang/<language>.js, with the same {placeholders}, and nothing else is there.
// `node shared/test/web-i18n.js --keys` prints the keys.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '../../web');
const TD = path.join(__dirname, '../../android/app/src/main/assets/web');
const unq = (s) => s.replace(/\\(.)/g, '$1');

function keys() {
  const found = new Set();
  for (const f of ['app.js', 'td-bridge.js']) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    for (const m of src.matchAll(/\b(?:tr|trNodes|TD\.tr)\(\s*'((?:[^'\\]|\\.)*)'/g)) found.add(unq(m[1]));
    for (const m of src.matchAll(/\b(?:tr|trNodes)\(\s*`/g)) assert.fail(`${f}: a key in backquotes, use '…' with {name}`);
  }
  for (const f of fs.readdirSync(TD)) {
    const src = fs.readFileSync(path.join(TD, f), 'utf8');
    if (f.endsWith('.js')) {
      for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) found.add(unq(m[1]));
    } else if (f.endsWith('.html')) {
      for (const m of src.matchAll(/<[^>]*\bdata-i18n(?:="([^"]*)")?[^>]*>([^<]*)</g)) found.add(m[1] || m[2].trim());
      for (const m of src.matchAll(/aria-label="([^"]+)"/g)) found.add(m[1]);
      for (const m of src.matchAll(/placeholder="([^"]+)"/g)) found.add(m[1]);
    }
  }
  return [...found].sort();
}

if (process.argv.includes('--keys')) {
  console.log(JSON.stringify(keys(), null, 1));
  return;
}

const catalog = (lang) => {
  const win = {};
  new Function('window', fs.readFileSync(path.join(WEB, 'lang', `${lang}.js`), 'utf8'))(win);
  assert.strictEqual(win.TwinDeskWeb.lang, lang, `${lang}.js says which language it is`);
  return win.TwinDeskWeb.messages;
};

const wanted = keys();
assert.ok(wanted.length > 500, 'the page wraps its text in tr()');
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();
const tags = (s) => (s.match(/<\/?\w+>/g) || []).sort();
const LANGS = ['zh-CN', 'ru', 'tr', 'pt-BR'];
for (const lang of LANGS) {
  const m = catalog(lang);
  assert.deepStrictEqual(wanted.filter((k) => !(k in m)), [], `every text has ${lang}`);
  assert.deepStrictEqual(Object.keys(m).filter((k) => !wanted.includes(k)), [], `no text the page no longer uses in ${lang}`);
  for (const [k, v] of Object.entries(m)) {
    assert.ok(typeof v === 'string' && v.trim(), `a ${lang} translation for ${k}`);
    assert.deepStrictEqual(placeholders(v), placeholders(k), `${lang} placeholders for ${k}`);
    assert.deepStrictEqual(tags(v), tags(k), `${lang} keeps the <b> of ${k}`);
    assert.ok(!v.includes('|'), `no context left in the ${lang} translation of ${k}`);
  }
}

// The picker (with flags), pick.js before the page, and the same languages in both.
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
for (const [code, name, flag] of [['en', 'English', '🇬🇧'], ['zh-CN', '简体中文', '🇨🇳'], ['ru', 'Русский', '🇷🇺'], ['tr', 'Türkçe', '🇹🇷'], ['pt-BR', 'Português (Brasil)', '🇧🇷']]) {
  assert.ok(app.includes(`['${code}', '${name}', '${flag}']`), `General offers ${name} with its flag`);
}
const pick = fs.readFileSync(path.join(WEB, 'lang/pick.js'), 'utf8');
assert.ok(pick.includes(JSON.stringify(LANGS).replace(/"/g, "'").replace(/,/g, ', ')), 'pick.js knows every language');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
assert.ok(html.indexOf('/lang/pick.js') > 0 && html.indexOf('/lang/pick.js') < html.indexOf('/app.js'), 'the language comes before the page');
assert.ok(fs.existsSync(path.join(WEB, 'lang/flags.woff2')), 'flags for Windows and Linux');
console.log(`web-i18n: ${wanted.length} texts in ${LANGS.length} languages, placeholders and <b> checked`);
