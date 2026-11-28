// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Multi-device tab's matrix (step 6 of docs/mesh-graph.md): for one feature at a time, which device
// sends it to which, the whole mesh (state.matrix, from shared/mesh-edges.js). Providers in rows,
// receivers in columns; a cell is on when the row's device sends it and the column's takes it, lit when
// they're connected now; the reason on hover. This computer's row (what it sends) and column (what it
// takes) are switches; every other device's cells are theirs, shown as they told.
//   const mx = MeshMatrix.create({ toggle(id, feature, dir, on) })
//   body.append(mx.el); mx.render(state.matrix)
// Notifications are not in it: the Notifications page has their grid (MeshMatrix.notifs), where a cell
// says All, the number of apps, or Off, and selecting one of this computer's cells opens its panel.
//   const g = MeshMatrix.notifs({ toggle(id, dir, on), setCell(from, to, on), setApp(from, app, name, show), showAll(from), takeAll(on) })
// Another two devices' cell opens too when its owners accept changes (cell.edit, shared/mesh-edges.js): All or Off.
//   body.append(g.el); g.render(state.matrix, state.notifs)
'use strict';

(function () {
  // The matrix's features and their names on the pages (the same words as their tabs).
  const LABELS = { clipboard: 'Clipboard', notifs: 'Notifications', audio: 'Sound', files: 'Files', cursor: 'Mouse and keyboard', terminal: 'Terminal', apps: 'Apps' };

  function create(opts) {
    const t = (k, v) => I18n.t(k, v);
    const el = UI.el('div', { class: 'mx' });
    let feature = 'clipboard';
    let last = null;
    const seg = UI.segmented(Object.keys(LABELS).map((k) => ({ value: k, label: t(LABELS[k]) })), (v) => {
      feature = v;
      seg.set(v);
      draw();
    });
    seg.set(feature);
    const grid = UI.el('div', { class: 'mx-grid', attrs: { role: 'grid' } });
    const hint = UI.note('info', t('Rows send to columns. This computer’s row and column can be changed here.'));
    el.append(seg.el, grid, hint);

    const head = (d) => {
      const h = UI.el('div', { class: 'mx-head' + (d.self ? ' self' : ''), attrs: { 'data-literal': '' } }, [UI.osIcon(d.os), UI.el('span', { text: d.name })]);
      h.title = d.name;
      return h;
    };

    function draw() {
      const m = last;
      grid.textContent = '';
      if (!m || !m.devices || m.devices.length < 2) return;
      if (!m.features.includes(feature)) feature = m.features[0];
      seg.set(feature);
      const devs = m.devices;
      const name = (id) => (devs.find((d) => d.id === id) || { name: String(id).slice(0, 8) }).name;
      const byPair = new Map((m.cells[feature] || []).map((c) => [c.from + '>' + c.to, c]));
      grid.style.gridTemplateColumns = `minmax(7em, auto) repeat(${devs.length}, minmax(3.2em, 1fr))`;
      grid.append(UI.el('div', { class: 'mx-corner', text: t('From ↓ · to →') }));
      for (const d of devs) grid.append(head(d));
      for (const u of devs) {
        grid.append(head(u));
        for (const v of devs) {
          if (u.id === v.id) {
            grid.append(UI.el('div', { class: 'mx-cell mx-self', attrs: { 'aria-hidden': 'true' } }));
            continue;
          }
          const c = byPair.get(u.id + '>' + v.id) || { on: false, live: false, why: null, mine: '' };
          const why = c.why ? t(c.why.key, { from: name(u.id), to: name(v.id), who: name(c.why.who) }) : t('Live');
          const cell = UI.el(c.mine ? 'button' : 'div', {
            class: `mx-cell${c.on ? ' on' : ''}${c.live ? ' live' : ''}${c.mine ? ' mine' : ''}${c.why && c.why.who ? ' unknown' : ''}`,
            attrs: { role: c.mine ? 'switch' : 'gridcell', 'aria-checked': String(!!c.on), 'aria-label': `${name(u.id)} → ${name(v.id)}: ${why}` },
          }, [UI.el('span', { class: 'mx-dot' })]);
          cell.title = why;
          if (c.mine) cell.onclick = () => opts.toggle(c.mine === 'out' ? v.id : u.id, feature, c.mine, !c.on);
          grid.append(cell);
        }
      }
    }

    return {
      el,
      render(m) {
        const key = JSON.stringify(m || null);
        if (key === el.dataset.key) return;
        el.dataset.key = key;
        // Notifications have their own grid on the Notifications page (notifs() below).
        last = m && { ...m, features: (m.features || []).filter((f) => f !== 'notifs') };
        el.hidden = !m || !m.devices || m.devices.length < 2;
        draw();
      },
    };
  }

  const PHONES = ['android', 'ios', 'ipados'];

  function notifs(opts) {
    const t = (k, v) => I18n.t(k, v);
    const allSw = UI.switch((v) => opts.takeAll(v), { label: t('Receive all notifications') });
    const allRow = UI.row(t('Receive all notifications'), t('From every device and app'), [allSw]);
    const grid = UI.el('div', { class: 'ng-grid', attrs: { role: 'grid' } });
    const legend = UI.el('div', { class: 'ng-legend' }, [
      UI.el('span', { class: 'ng-key ng-all' }), UI.el('span', { text: t('All apps') }),
      UI.el('span', { class: 'ng-key ng-some' }), UI.el('span', { text: t('Some apps') }),
      UI.el('span', { class: 'ng-key ng-off' }), UI.el('span', { text: t('Off') }),
      UI.el('span', { class: 'ng-tip', text: t('Rows send, columns show. Select a cell to choose apps.') }),
    ]);
    const panel = UI.el('div', { class: 'ng-panel' });
    const body = UI.el('div', { class: 'ng-body' }, [UI.el('div', { class: 'ng-main' }, [grid, legend]), panel]);
    const card = UI.card(t('Across devices'), [allRow, body], { cls: 'keep-on' });
    let m = null, nf = {}, sel = null; // sel: 'from>to'
    const some = new Set(); // cells set to Some with every app still on

    const hiddenOf = (from) => (((nf.appsFrom || {})[from]) || []).filter((a) => a.hidden).length;
    const appsOf = (from) => ((nf.appsFrom || {})[from]) || [];
    const nameOf = (id) => { const d = m.devices.find((x) => x.id === id); return d ? (d.self ? t('This computer') : d.name) : String(id).slice(0, 8); };
    const cellOf = (from, to) => (m.cells.notifs || []).find((c) => c.from === from && c.to === to) || { on: false, mine: '' };
    const modeOf = (from, to, c) => {
      if (!c.on) return 'off';
      const self = m.devices.find((d) => d.self);
      if (self && to === self.id && (hiddenOf(from) || some.has(from + '>' + to))) return 'some';
      return 'all';
    };

    function drawGrid() {
      grid.textContent = '';
      const devs = m.devices;
      grid.style.gridTemplateColumns = `minmax(8em, auto) repeat(${devs.length}, minmax(4.5em, 1fr))`;
      grid.append(UI.el('div', { class: 'ng-corner', text: t('From ↓  To →') }));
      for (const d of devs) grid.append(UI.el('div', { class: 'ng-col' + (d.self ? ' self' : ''), text: d.self ? t('This computer') : d.name, attrs: { 'data-literal': '' } }));
      for (const u of devs) {
        grid.append(UI.el('div', { class: 'ng-rowhead', attrs: { 'data-literal': '' } }, [
          UI.el('b', { text: u.self ? t('This computer') : u.name }),
          UI.el('small', { text: PHONES.includes(u.os) ? t('Phone') : t('Computer') }),
        ]));
        for (const v of devs) {
          if (u.id === v.id) { grid.append(UI.el('div', { class: 'ng-cell ng-self', text: '—', attrs: { 'aria-hidden': 'true' } })); continue; }
          const c = cellOf(u.id, v.id);
          const mode = modeOf(u.id, v.id, c);
          const shown = appsOf(u.id).length - hiddenOf(u.id);
          const text = mode === 'off' ? t('Off') : mode === 'some' ? t(shown === 1 ? '1 app' : '{count} apps', { count: shown }) : t('All');
          const key = u.id + '>' + v.id;
          const open = c.mine || c.edit;
          const b = UI.el(open ? 'button' : 'div', { class: `ng-cell ng-${mode}${open ? ' mine' : ''}${sel === key ? ' sel' : ''}`, text, attrs: { 'aria-label': `${nameOf(u.id)} → ${nameOf(v.id)}: ${text}` } });
          b.title = open ? '' : t('Turned off for other devices on {name}', { name: nameOf(v.id) });
          if (open) b.onclick = () => { sel = key; draw(); };
          grid.append(b);
        }
      }
    }

    function drawPanel() {
      panel.textContent = '';
      const [from, to] = sel ? sel.split('>') : [];
      const c = sel && cellOf(from, to);
      if (c && !c.mine && c.edit) {
        const seg = UI.segmented([{ value: 'all', label: t('All') }, { value: 'off', label: t('Off') }], (v) => opts.setCell(from, to, v === 'all'));
        seg.set(c.on ? 'all' : 'off');
        panel.append(UI.el('h3', { text: `${nameOf(from)} → ${nameOf(to)}`, attrs: { 'data-literal': '' } }), seg.el);
        return;
      }
      if (!c || !c.mine) { panel.append(UI.el('div', { class: 'hint', text: t('Select a cell to choose apps.') })); return; }
      const mode = modeOf(from, to, c);
      const takes = c.mine === 'in';
      const opts2 = [{ value: 'all', label: t('All') }, ...(takes ? [{ value: 'some', label: t('Some') }] : []), { value: 'off', label: t('Off') }];
      const seg = UI.segmented(opts2, (v) => {
        const id = c.mine === 'out' ? to : from;
        if (v === 'off') { some.delete(sel); if (c.on) opts.toggle(id, c.mine, false); return; }
        if (!c.on) opts.toggle(id, c.mine, true);
        if (v === 'all') { some.delete(sel); if (hiddenOf(from)) opts.showAll(from); draw(); }
        if (v === 'some') { some.add(sel); draw(); }
      });
      seg.set(mode);
      panel.append(UI.el('h3', { text: `${nameOf(from)} → ${nameOf(to)}`, attrs: { 'data-literal': '' } }), seg.el);
      if (mode !== 'some') return;
      const apps = appsOf(from);
      if (!apps.length) { panel.append(UI.el('div', { class: 'hint', text: t('Apps appear after their first notification') })); return; }
      for (const a of apps) {
        const sw = UI.switch((v) => opts.setApp(from, a.app, a.name, v), { label: a.name });
        sw.set(!a.hidden);
        panel.append(UI.row(a.name, '', [sw], { literal: true }));
      }
    }

    function draw() { drawGrid(); drawPanel(); }

    return {
      el: card,
      render(matrix, notifState) {
        const n = notifState || {};
        const key = JSON.stringify([matrix || null, n.appsFrom || null, !!n.takeAll, sel, [...some]]);
        if (key === card.dataset.key) return;
        card.dataset.key = key;
        card.hidden = !matrix || !matrix.devices || matrix.devices.length < 2 || !(matrix.features || []).includes('notifs');
        if (card.hidden) return;
        m = matrix; nf = n;
        allSw.set(!!n.takeAll);
        body.classList.toggle('ng-bypass', !!n.takeAll);
        body.inert = !!n.takeAll;
        if (!sel) {
          const self = m.devices.find((d) => d.self);
          const first = self && m.devices.find((d) => !d.self && cellOf(d.id, self.id).mine);
          if (first) sel = first.id + '>' + self.id;
        }
        draw();
      },
    };
  }

  window.MeshMatrix = { create, notifs };
})();
