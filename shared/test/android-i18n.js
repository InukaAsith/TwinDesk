// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Android app's translations (android/app/src/main/java/.../I18n.kt): every English text the app
// passes to tr() — in Kotlin, in the WebView pages' t() and their data-i18n/aria-label — has its
// translation in every assets/i18n/<language>.json (zh-CN, ru, tr, pt-BR), with the same {placeholders},
// and nothing else is there.
// `node shared/test/android-i18n.js --keys` prints the keys (for a new catalog).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '../../android/app/src/main');
const KT = path.join(APP, 'java/com/twindesk/android');
const WEB = path.join(APP, 'assets/web');

// Texts tr() gets from a variable: the pages' titles (MainActivity's Tab), the link's name
// (Netlink.via) and trCount()'s words.
const DYNAMIC = [
  'Overview', 'Connection', 'Calls', 'Messages', 'Photos', 'File access', 'Screen', 'Mouse', 'Keyboard', 'Remote',
  'Clipboard', 'Notifications', 'Files', 'ReZume', 'Sound', 'Media', 'Camera', 'General', 'About',
  'USB', 'Bluetooth', 'Wi-Fi', 'Hotspot', 'Wi-Fi Direct', 'Temporary Hotspot', 'Temporary Wi-Fi Direct',
  '1 file', '{count} files', '1 item', '{count} items',
];

// A Kotlin "…" literal's text, from just after its opening quote: [text, end] (null for a template).
function kotlinString(src, i) {
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"') return [out, i + 1];
    if (c === '$' && /[A-Za-z_{]/.test(src[i + 1])) return [null, i];
    if (c !== '\\') { out += c; continue; }
    const n = src[++i];
    if (n === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)); i += 4; } else out += { n: '\n', t: '\t', r: '\r', b: '\b' }[n] || n;
  }
  return [null, i];
}

function keys() {
  const found = new Set(DYNAMIC);
  for (const f of fs.readdirSync(KT).filter((n) => n.endsWith('.kt'))) {
    const src = fs.readFileSync(path.join(KT, f), 'utf8');
    for (const m of src.matchAll(/\btr\(\s*"/g)) {
      const [text] = kotlinString(src, m.index + m[0].length);
      if (text !== null) found.add(text);
    }
  }
  for (const f of fs.readdirSync(WEB)) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    if (f.endsWith('.js')) {
      for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) found.add(m[1].replace(/\\(.)/g, '$1'));
    } else if (f.endsWith('.html')) {
      for (const m of src.matchAll(/<[^>]*\bdata-i18n(?:="([^"]*)")?[^>]*>([^<]*)</g)) found.add(m[1] || m[2].trim());
      for (const m of src.matchAll(/aria-label="([^"]+)"/g)) found.add(m[1]);
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
for (const k of wanted) assert.ok(!/\$\{|\$[A-Za-z]/.test(k), `no Kotlin template left in a key: ${k}`);

const LANGS = { 'zh-CN': 'zh-rCN', ru: 'ru', tr: 'tr', 'pt-BR': 'pt-rBR' };
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();
const resNames = [...fs.readFileSync(path.join(APP, 'res/values/strings.xml'), 'utf8').matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]);
for (const [lang, res] of Object.entries(LANGS)) {
  const catalog = JSON.parse(fs.readFileSync(path.join(APP, `assets/i18n/${lang}.json`), 'utf8'));
  const have = Object.keys(catalog);
  assert.deepStrictEqual(wanted.filter((k) => !(k in catalog)), [], `every text has ${lang}`);
  assert.deepStrictEqual(have.filter((k) => !wanted.includes(k)), [], `no text the app no longer uses in ${lang}`);
  for (const [k, v] of Object.entries(catalog)) {
    assert.ok(typeof v === 'string' && v.trim(), `a ${lang} translation for ${k}`);
    assert.deepStrictEqual(placeholders(v), placeholders(k), `${lang} placeholders for ${k}`);
    assert.ok(!v.includes('|'), `no context left in the ${lang} translation of ${k}`);
  }
  // Android's own labels (share sheet, Quick Settings, shortcuts, Accessibility).
  const xml = fs.readFileSync(path.join(APP, `res/values-${res}/strings.xml`), 'utf8');
  for (const name of resNames) assert.ok(xml.includes(`<string name="${name}">`), `Android's own labels in ${lang}: ${name}`);
}

// The language picker and the fallbacks (I18n.kt): English keys, the phone's language first.
const i18n = fs.readFileSync(path.join(KT, 'I18n.kt'), 'utf8');
for (const [code, name] of [['zh-CN', '简体中文'], ['ru', 'Русский'], ['tr', 'Türkçe'], ['pt-BR', 'Português (Brasil)']]) {
  assert.ok(i18n.includes(`"${code}" to "${name}"`), `General offers ${name}`);
}
assert.ok(/system\.language == "pt" -> "pt-BR"/.test(i18n), 'a Portuguese phone starts in Brazilian Portuguese');
assert.ok(/system\.language == "ru" -> "ru"/.test(i18n) && /system\.language == "tr" -> "tr"/.test(i18n), 'Russian and Turkish phones start in their language');
console.log(`android-i18n: ${wanted.length} texts in ${Object.keys(LANGS).length} languages, placeholders and Android's labels checked`);
