// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What a copied text is, for the button beside it in Clipboard › Recent (every computer, and the
// phone's page in Multi-device): a web link → Open, an email address → Email, a phone number → Call
// (the computer's own app for tel:, FaceTime or Phone Link). Only when the whole text is that one
// thing: a sentence with a link in it gets no button. The app opens it again from its own copy
// (openClip, by the item's place in the list), never from a URL the page hands over.
//   ClipAct.of(text) → {kind: 'link'|'mail'|'call', url} | null
'use strict';

(function (root) {
  const MAX = 2048;

  function of(text) {
    if (typeof text !== 'string' || text.length > MAX) return null;
    const s = text.trim();
    if (!s || /\s/.test(s)) {
      // A phone number may have spaces: +44 7911 123456, (650) 555-0100.
      return call(s);
    }
    if (/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s)) return link(s);
    if (/^www\.[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return link('https://' + s);
    const mail = /^(mailto:)?([a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})$/i.exec(s);
    if (mail) return { kind: 'mail', url: 'mailto:' + mail[2] };
    return call(s);
  }

  function link(s) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.username || u.password) return null; // https://bank.com@evil.example
      return { kind: 'link', url: u.href };
    } catch (_) { return null; }
  }

  // 7 to 15 digits, an optional leading +, and only the usual separators between.
  function call(s) {
    if (!/^(tel:)?\+?[\d\s().-]+$/i.test(s)) return null;
    const plain = s.replace(/^tel:/i, '');
    const digits = plain.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    if (/^\d+$/.test(plain) && plain.length < 9) return null; // 1234567: a code or a number, not a phone
    if (/[.-]{2}|\(\s*\)/.test(plain)) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(plain) || /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(plain)) return null; // a date
    if (/^\d+\.\d+$/.test(plain)) return null; // a decimal
    return { kind: 'call', url: 'tel:' + (plain.trim().startsWith('+') ? '+' : '') + digits };
  }

  const ClipAct = { of };
  if (typeof module !== 'undefined' && module.exports) module.exports = ClipAct;
  else root.ClipAct = ClipAct;
})(typeof window !== 'undefined' ? window : globalThis);
