// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Each control window loads every script its tabs need (#142: the Multi-device pages left out
// shared/ui-look.js, so General threw on UI.themeRow and stayed blank). Reads each page's real
// <script> list: every UI.name(…) one of them calls must be defined by one of them (the UI kit's
// literal or a UI.name = …), and every api.name(…) General calls must be in that window's preload.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const PAGES = [
  ['mac/control.html', 'mac/preload-control.js'], ['mac/mesh/control.html', 'mac/mesh/preload-control.js'],
  ['windows/app.html', 'windows/preload-app.js'], ['windows/mesh/app.html', 'windows/mesh/preload-app.js'],
  ['linux/app.html', 'linux/preload-app.js'], ['linux/mesh/app.html', 'linux/mesh/preload-app.js'],
];

function scripts(page) {
  const file = path.join(root, page);
  const html = fs.readFileSync(file, 'utf8');
  const base = (html.match(/<base href="([^"]+)"/) || [])[1] || './';
  const dir = path.resolve(path.dirname(file), base);
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => {
    const p = path.join(dir, m[1]);
    assert.ok(fs.existsSync(p), `${page}: ${m[1]} doesn't exist`);
    return { src: m[1], code: fs.readFileSync(p, 'utf8') };
  });
}

// The UI kit's own members: the keys of `const UI = {` … `};` written at its first indent.
function kitKeys(code) {
  const m = /^const UI = \{\n([\s\S]*?)^\};/m.exec(code);
  return m ? [...m[1].matchAll(/^  (?:async\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*[(:]/gm)].map((x) => x[1]) : [];
}

for (const [page, preload] of PAGES) {
  const list = scripts(page);
  const defined = new Set();
  for (const { code } of list) {
    for (const k of kitKeys(code)) defined.add(k);
    for (const m of code.matchAll(/\bUI\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) defined.add(m[1]);
  }
  for (const { src, code } of list) {
    for (const m of code.matchAll(/\bUI\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (new RegExp(`\\bUI\\.${m[1]}\\s*(\\?|&&|\\))|typeof UI\\.${m[1]}\\b`).test(code)) continue; // optional: used only where it's there
      assert.ok(defined.has(m[1]), `${page}: ${src} calls UI.${m[1]}() but no script on the page defines it`);
    }
  }
  const general = list.find((s) => /(^|\/)ui-general\.js$/.test(s.src));
  assert.ok(general, `${page}: no General tab`);
  const bridge = fs.readFileSync(path.join(root, preload), 'utf8');
  for (const m of new Set([...general.code.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]))) {
    assert.ok(new RegExp(`\\b${m}\\b`).test(bridge), `${page}: General calls api.${m}() but ${preload} has no ${m}`);
  }
}
console.log('page-scripts: ok');
