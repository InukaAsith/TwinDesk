// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keys in a phone's window (phoneview.js) and with the computer's keyboard on the phone
// (phone-bridge.js) that mean more than the key:
//   Enter sends the message in a chat app (Phone page › Settings › Enter sends messages, on), and
//   Shift+Enter is a new line there. Anywhere else Enter is Enter. With the phone's Accessibility
//   on (the full app), the phone clicks the app's own Send button (phone.send); without it,
//   Instagram's Send is reached with Tab, and WhatsApp and Telegram send on Enter once their own
//   "Enter is send" setting is on. Messenger has no such setting: it sends only with Accessibility
//   (#331), without it Enter stays its new line.
//   The arrow keys swipe the screen (Phone page › Settings › Arrow keys swipe, off): for feeds,
//   Reels and Shorts, a reader's pages. Off, they are arrow keys (text fields, games).
'use strict';

const CHATS = {
  'com.whatsapp': 'whatsapp', 'com.whatsapp.w4b': 'whatsapp',
  'com.instagram.android': 'instagram', 'com.instagram.lite': 'instagram',
  'org.telegram.messenger': 'telegram', 'org.telegram.messenger.web': 'telegram', 'org.telegram.plus': 'telegram',
  'com.facebook.orca': 'messenger', 'com.facebook.mlite': 'messenger',
};
const KEYCODE = { TAB: 61, ENTER: 66 };
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const MODS = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

const chatOf = (pkg) => CHATS[String(pkg || '').toLowerCase()] || '';

// Enter pressed (key down) in the app `pkg`: true when it was done here (the key itself is then
// left out, its release too), false for an ordinary Enter.
// o: {on (the setting), pkg, shift, a11y (the phone's Accessibility answers), phoneSend(),
//     tap(keycode), text(str) | null (the input can't type text)}
function enter(o) {
  const chat = o.on ? chatOf(o.pkg) : '';
  if (!chat) return false;
  if (o.shift) {
    if (!o.text) return false;
    o.text('\n');
    return true;
  }
  if (o.a11y) {
    o.phoneSend();
    return true;
  }
  if (chat === 'instagram') {
    o.tap(KEYCODE.TAB);
    setTimeout(() => o.tap(KEYCODE.ENTER), 40);
    return true;
  }
  return false;
}

// An arrow key's swipe direction, or '' (not an arrow, the setting off, or a modifier held).
// held: the KeyState's held codes.
function swipeOf(code, on, held) {
  if (!on || !ARROWS[code]) return '';
  for (const m of MODS) if (held.has(m)) return '';
  return ARROWS[code];
}

const isEnter = (code) => code === 'Enter' || code === 'NumpadEnter';

module.exports = { chatOf, enter, swipeOf, isEnter };
