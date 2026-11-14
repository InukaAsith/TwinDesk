// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The iPhone app's translations (ios/TwinDesk/Core/I18n.swift): every English text the app passes to
// tr() — in the app, the Share and Broadcast extensions, and the Android web pages it shows (their
// t() and data-i18n/aria-label, through TD.tr) — has a translation in every ios/TwinDesk/Lang/<language>.json,
// with the same {placeholders}, and nothing else is there.
// `node shared/test/ios-i18n.js --keys` prints the keys (for a new catalog).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const IOS = path.join(__dirname, '../../ios');
const LANG = path.join(IOS, 'TwinDesk/Lang');
const WEB = path.join(__dirname, '../../android/app/src/main/assets/web');

// trCount()'s words.
const DYNAMIC = ['1 file', '{count} files', '1 item', '{count} items'];

function swiftFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...swiftFiles(p));
    else if (e.name.endsWith('.swift')) out.push(p);
  }
  return out;
}

// A Swift "…" literal's text, from just after its opening quote: [text, end] (null with \( … )).
function swiftString(src, i) {
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"') return [out, i + 1];
    if (c !== '\\') { out += c; continue; }
    const n = src[++i];
    if (n === '(') return [null, i];
    if (n === 'u' && src[i + 1] === '{') { const end = src.indexOf('}', i); out += String.fromCodePoint(parseInt(src.slice(i + 2, end), 16)); i = end; } else out += { n: '\n', t: '\t', r: '\r', 0: '\0' }[n] || n;
  }
  return [null, i];
}

function keys() {
  const found = new Set(DYNAMIC);
  for (const f of [...swiftFiles(path.join(IOS, 'TwinDesk')), ...swiftFiles(path.join(IOS, 'Share')), ...swiftFiles(path.join(IOS, 'Broadcast'))]) {
    if (path.basename(f) === 'I18n.swift') continue; // trCount builds its keys
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\btr\(\s*"/g)) {
      const [text] = swiftString(src, m.index + m[0].length);
      assert.ok(text !== null, `${path.basename(f)}: a key with \\( … ) in it, use {name} instead`);
      found.add(text);
    }
  }
  for (const f of fs.readdirSync(WEB)) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    if (f.endsWith('.js')) {
      for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) found.add(m[1].replace(/\\(.)/g, '$1'));
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

const wanted = keys();
assert.ok(wanted.length > 500, 'the app wraps its text in tr()');
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();
const LANGS = ['zh-CN', 'ru', 'tr', 'pt-BR'];
for (const lang of LANGS) {
  const catalog = JSON.parse(fs.readFileSync(path.join(LANG, `${lang}.json`), 'utf8'));
  assert.deepStrictEqual(wanted.filter((k) => !(k in catalog)), [], `every text has ${lang}`);
  assert.deepStrictEqual(Object.keys(catalog).filter((k) => !wanted.includes(k)), [], `no text the app no longer uses in ${lang}`);
  for (const [k, v] of Object.entries(catalog)) {
    assert.ok(typeof v === 'string' && v.trim(), `a ${lang} translation for ${k}`);
    assert.deepStrictEqual(placeholders(v), placeholders(k), `${lang} placeholders for ${k}`);
    assert.ok(!v.includes('|'), `no context left in the ${lang} translation of ${k}`);
  }
}

// The picker (with flags), the iPhone's language first, and the extensions get the catalogs too.
const i18n = fs.readFileSync(path.join(IOS, 'TwinDesk/Core/I18n.swift'), 'utf8');
for (const [code, name, flag] of [['en', 'English', '🇬🇧'], ['zh-CN', '简体中文', '🇨🇳'], ['ru', 'Русский', '🇷🇺'], ['tr', 'Türkçe', '🇹🇷'], ['pt-BR', 'Português (Brasil)', '🇧🇷']]) {
  assert.ok(i18n.includes(`("${code}", "${name}", "${flag}")`), `General offers ${name} with its flag`);
}
const project = fs.readFileSync(path.join(IOS, 'project.yml'), 'utf8');
assert.strictEqual((project.match(/path: TwinDesk\/Core\/I18n\.swift/g) || []).length, 2, 'Share and Broadcast build I18n.swift');
assert.strictEqual((project.match(/path: TwinDesk\/Lang\b/g) || []).length, 2, 'Share and Broadcast carry the catalogs');
// Shortcuts, Siri and iOS's own prompts follow the iPhone's language: <lang>.lproj has every title,
// description, phrase and permission text, so none is left English.
const intents = fs.readFileSync(path.join(IOS, 'TwinDesk/Core/Intents.swift'), 'utf8');
const titles = [...intents.matchAll(/(?:LocalizedStringResource = |IntentDescription\(|@Parameter\(title: )"([^"]+)"/g)].map((m) => m[1]);
const phrases = [...intents.matchAll(/phrases: \["([^"]+)"\]/g)].map((m) => m[1].replace('\\(.applicationName)', '${applicationName}'));
const usage = [...fs.readFileSync(path.join(IOS, 'TwinDesk/Info.plist'), 'utf8').matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map((m) => m[1]);
assert.ok(titles.length >= 10 && phrases.length >= 6 && usage.length >= 6);
const strings = (f) => Object.fromEntries([...fs.readFileSync(f, 'utf8').matchAll(/^"?([^"=\n]+?)"? = "((?:[^"\\]|\\.)*)";$/gm)].map((m) => [m[1], m[2]]));
for (const lp of ['zh-Hans', 'ru', 'tr', 'pt-BR']) {
  const dir = path.join(IOS, `TwinDesk/${lp}.lproj`);
  for (const [file, want] of [['Localizable.strings', titles], ['AppShortcuts.strings', phrases], ['InfoPlist.strings', usage]]) {
    const have = strings(path.join(dir, file));
    assert.deepStrictEqual(want.filter((k) => !have[k]), [], `${lp}/${file} has every text`);
  }
  for (const v of Object.values(strings(path.join(dir, 'AppShortcuts.strings')))) assert.ok(v.includes('${applicationName}'), `${lp}: a phrase names the app`);
  assert.ok(strings(path.join(IOS, `Share/${lp}.lproj/InfoPlist.strings`)).CFBundleDisplayName, `${lp}: Send to Computer's name`);
}

console.log(`ios-i18n: ${wanted.length} texts in ${LANGS.length} languages, placeholders checked`);
