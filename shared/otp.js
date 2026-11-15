// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A one-time code in a notification's text ("Your code is 482913", "G-482913 is your Google
// verification code", "OTP: 4829-13"): the digits, for a Copy button on the notification here and
// in the lists. Only next to a word that says it's a code, so an order number or a price doesn't
// count. otpOf(text) → '482913' | ''. Main process (require) and pages (window.Otp).
'use strict';

(function (root) {
  const WORDS = /\b(?:code|otp|one[- ]time|passcode|pass code|verification|verify|security|login|log-in|sign[- ]in|2fa|two[- ]factor|pin|token|authenticat\w*|confirm\w*)\b|кода?|код\b|コード|验证码|驗證碼|인증|รหัส|कोड|رمز|කේතය/i;
  // 4–8 digits, alone or in two groups ("482 913", "4829-13"); a G- prefix (Google) is allowed.
  const CODE = /(?:^|[^\w.,:/+-])(?:G-)?(\d{3,4}[ -]\d{2,4}|\d{4,8})(?![\w%/]|[.,]\d|:\d)/g;

  function otpOf(text) {
    const t = String(text || '');
    if (!t || !WORDS.test(t)) return '';
    let best = '';
    for (const m of t.matchAll(CODE)) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length < 4 || digits.length > 8) continue;
      if (/^(19|20)\d\d$/.test(digits) && !/\d[ -]\d/.test(m[1])) continue; // a year
      best = digits;
      // The first code after a code word wins ("Code 1234 for order 99887766").
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      if (WORDS.test(before)) return digits;
    }
    return best;
  }

  // A code put on the clipboard by itself (Notifications › Copy codes by themselves): kept out of
  // clipboard sync and history (each clipboard module asks isQuiet before sending or keeping), and
  // taken off the clipboard after 2 minutes if it's still there. Main process only.
  const quiet = new Map(); // text -> until
  function isQuiet(text) {
    const now = Date.now();
    for (const [k, until] of quiet) if (until < now) quiet.delete(k);
    return typeof text === 'string' && quiet.has(text.trim());
  }
  function quietCopy(code, clipboard) {
    if (!code) return;
    const cb = clipboard || require('electron').clipboard;
    quiet.set(code, Date.now() + 5 * 60000);
    cb.writeText(code);
    const t = setTimeout(() => { Promise.resolve().then(() => cb.readText()).then((now) => { if (String(now || '') === code) cb.writeText(''); }).catch(() => {}); }, 120000);
    if (t && t.unref) t.unref();
  }

  const api = { otpOf, isQuiet, quietCopy };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Otp = api;
})(typeof window !== 'undefined' ? window : globalThis);
