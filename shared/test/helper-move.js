// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Each app's Helper.sendMove writes the same line as send('inject', {ev: {t: 'k.mm', dx, dy}}).
'use strict';
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..', '..');
for (const os of ['mac', 'windows', 'linux']) {
  const mod = require(path.join(root, os, 'helper.js'));
  const Helper = mod.Helper || mod;
  const h = Object.create(Helper.prototype);
  const lines = [];
  h.proc = { stdin: { write: (s) => lines.push(s) } };
  for (const [dx, dy] of [[1, 2], [-0.5, 3.25], [1e-7, -1e21], [0.1 + 0.2, -0], [NaN, Infinity]]) {
    lines.length = 0;
    h.sendMove(dx, dy);
    h.send('inject', { ev: { t: 'k.mm', dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 } });
    assert.strictEqual(lines[0], lines[1], `${os}: ${dx}, ${dy}`);
    assert.deepStrictEqual(JSON.parse(lines[0]).ev.t, 'k.mm');
  }
  h.proc = null;
  assert.strictEqual(h.sendMove(1, 1), false, `${os}: no helper running`);
}
console.log('helper-move: ok');
