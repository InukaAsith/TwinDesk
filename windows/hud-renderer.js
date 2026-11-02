// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const $ = (id) => document.getElementById(id);
const pill = $('pill');
const card = $('card');
// Only marked local messages are translated; raw names and native errors stay literal.
const format = (value) => value && typeof value === 'object' && typeof value.key === 'string'
  ? window.PlayerI18n.t(value.key, Object.fromEntries(Object.entries(value.vars || {}).map(([key, item]) => [key, format(item)])))
  : value == null ? '' : String(value);
let current = null;
function renderText() {
  if (!current) return;
  const { kind, text, sub } = current;
  if (kind === 'linkOn' || kind === 'linkOff') {
    $('card-text').textContent = format(text);
    $('card-sub').textContent = format(sub);
  } else $('text').textContent = format(text);
}
window.PlayerI18n.onChange(renderText);
window.hud.on((message) => {
  const { kind } = message;
  if (kind === 'hide') {
    current = null;
    pill.classList.remove('on');
    card.classList.remove('on');
    return;
  }
  const big = kind === 'linkOn' || kind === 'linkOff';
  document.body.classList.toggle('big', big);
  const el = big ? card : pill;
  current = message;
  renderText();
  el.className = (big ? 'card ' : 'pill ') + kind;
  void el.offsetWidth; // restart the animation
  el.classList.add('on');
});
