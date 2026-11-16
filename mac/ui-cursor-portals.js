// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// A small accessible editor for one-to-one Mac cursor portals.
'use strict';

const CursorPortalsUI = {
  create() {
    const { el, api } = UI;
    let state = null, listKey = '';
    const label = (name, control) => { control.setAttribute('aria-label', name); return control; };
    const source = UI.select([], () => {}), target = UI.select([], () => {});
    label('Source display', source.el); label('Destination display', target.el);
    const sides = ['top', 'bottom', 'left', 'right'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
    const sourceSide = UI.select(sides, () => {}), targetSide = UI.select(sides, () => {});
    label('Source edge', sourceSide.el); label('Destination edge', targetSide.el);
    const number = (name, value) => el('input', { type: 'number', min: 0, max: 100, step: 1, value, attrs: { 'aria-label': name } });
    const sourceFrom = number('Source start percent', 0), sourceTo = number('Source end percent', 50);
    const targetFrom = number('Destination start percent', 0), targetTo = number('Destination end percent', 100);
    const modNames = ['Command', 'Control', 'Alt', 'Shift'];
    const mods = modNames.map((name) => {
      const box = el('input', { type: 'checkbox', attrs: { 'aria-label': name } });
      return { name, box, el: el('label', {}, [box, document.createTextNode(` ${name}`)]) };
    });
    const keyOptions = [{ value: '', label: 'None' }, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => ({ value: `Key${c}`, label: c })),
      ...'0123456789'.split('').map((c) => ({ value: `Digit${c}`, label: c })),
      ...Array.from({ length: 20 }, (_, i) => ({ value: `F${i + 1}`, label: `F${i + 1}` })),
      ...['Space', 'Tab', 'Escape', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
        'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((value) => ({ value, label: value }))];
    const key = UI.select(keyOptions, () => {}); label('Additional shortcut key', key.el);
    const status = el('span', { class: 'hint', attrs: { role: 'status' } });
    const list = el('div');
    const add = UI.button('Add portal', () => {
      if (!state || !state.client || !state.input || state.input.where !== 'home') return;
      const map = state.input.map, existing = (state.input.portals || {}).rules;
      if (!Array.isArray(existing)) { status.textContent = 'Saved portal settings are invalid.'; return; }
      const rule = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        source: { display: source.el.value, side: sourceSide.el.value, from: Number(sourceFrom.value) / 100, to: Number(sourceTo.value) / 100 },
        target: { display: target.el.value, side: targetSide.el.value, from: Number(targetFrom.value) / 100, to: Number(targetTo.value) / 100 },
        modifiers: mods.filter((m) => m.box.checked).map((m) => m.name), key: key.el.value };
      const next = CursorPortals.normalize([...existing, rule]);
      if (!next) { status.textContent = 'Check the ranges and shortcut; source ranges must not overlap.'; return; }
      if (!CursorPortals.usableSource(map.mine, rule) || !CursorPortals.usableTarget(map.theirs, rule.target)) {
        status.textContent = 'Occupied source edges need a held shortcut; choose available displays.'; return;
      }
      status.textContent = '';
      api.setPortals(next);
    });
    const card = UI.card('Cursor portals', [
      UI.row('Source display and edge', 'An edge next to a local display requires a held shortcut.', [source.el, sourceSide.el]),
      UI.row('Source range (%)', 'Start and end along the edge.', [sourceFrom, sourceTo]),
      UI.row('Destination display and edge', 'Return crosses this edge without a shortcut, including between local displays.', [target.el, targetSide.el]),
      UI.row('Destination range (%)', 'Start and end along the edge.', [targetFrom, targetTo]),
      UI.row('Hold to cross', 'Modifiers and an optional physical key; the shortcut also reaches the current app before crossing.', [...mods.map((m) => m.el), key.el]),
      UI.row('Add', 'Both Macs need a portal-capable build. Return goes to the source display.', [add]),
      UI.row('Status', '', [status]), list,
    ]);
    const displayOptions = (items) => (items || []).slice().sort((a, b) => a.x - b.x || a.y - b.y).map((d, i) => ({ value: d.id, label: `${i + 1}: ${d.name || 'Display'}` }));
    return {
      el: card,
      update(s) {
        state = s;
        const input = s.input || {}, p = input.portals || {}, map = input.map || {};
        source.options(displayOptions(map.mine)); target.options(displayOptions(map.theirs));
        add.disabled = !s.client || input.where !== 'home' || !p.supported;
        if (s.client && !p.supported) status.textContent = 'The other Mac does not support portals yet.';
        else if (status.textContent === 'The other Mac does not support portals yet.') status.textContent = '';
        const rules = Array.isArray(p.rules) ? p.rules : [];
        const nextKey = JSON.stringify([rules, map.mine, map.theirs, input.where]);
        if (listKey === nextKey) return;
        listKey = nextKey;
        list.replaceChildren(...rules.map((rule) => {
          const labelFor = (items, id) => (displayOptions(items).find((d) => d.value === id) || { label: 'Display unavailable' }).label;
          const shortcut = [...rule.modifiers, rule.key].filter(Boolean).join(' + ') || 'No shortcut';
          const text = `${labelFor(map.mine, rule.source.display)} ${rule.source.side} ${rule.source.from * 100}–${rule.source.to * 100}% → ${labelFor(map.theirs, rule.target.display)} ${rule.target.side} ${rule.target.from * 100}–${rule.target.to * 100}% · ${shortcut}`;
          const remove = UI.button('Remove', () => api.setPortals(rules.filter((r) => r.id !== rule.id)), 'small');
          remove.disabled = input.where !== 'home';
          return UI.row(text, '', [remove], { literal: true });
        }));
      },
    };
  },
};
