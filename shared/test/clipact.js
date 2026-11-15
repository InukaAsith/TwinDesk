// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/clipact.js: a link, an email address and a phone number get their button; a sentence, a
// code, a date, a price or a link with a login in it don't.
// Run with: node shared/test/clipact.js
'use strict';

const assert = require('assert');
const { of } = require('../clipact.js');

const k = (s) => { const a = of(s); return a && a.kind; };
const u = (s) => { const a = of(s); return a && a.url; };

assert.strictEqual(u('https://example.com/a?b=1'), 'https://example.com/a?b=1');
assert.strictEqual(u('  http://example.com  '), 'http://example.com/');
assert.strictEqual(u('www.example.co.uk/path'), 'https://www.example.co.uk/path');
assert.strictEqual(u('someone@example.com'), 'mailto:someone@example.com');
assert.strictEqual(u('mailto:a.b+c@mail.example.org'), 'mailto:a.b+c@mail.example.org');
assert.strictEqual(u('+44 7911 123456'), 'tel:+447911123456');
assert.strictEqual(u('(650) 555-0100'), 'tel:6505550100');
assert.strictEqual(u('071 234 5678'), 'tel:0712345678');
assert.strictEqual(u('tel:+94771234567'), 'tel:+94771234567');

for (const s of [
  '', '   ', 'hello world', 'see https://example.com for more', 'javascript:alert(1)', 'file:///etc/passwd',
  'https://bank.com@evil.example/', 'ftp://example.com', '482910', '1234567', '2026-11-15', '12.11.2026',
  '1250.00', '3.14159', 'abc@def', 'x'.repeat(3000), '12--34567890', '123',
]) assert.strictEqual(k(s), null, s);

console.log('clipact: ok');
