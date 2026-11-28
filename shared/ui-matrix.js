// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Multi-device tab's matrix (step 6 of docs/mesh-graph.md): for one feature at a time, which device
// sends it to which, the whole mesh (state.matrix, from shared/mesh-edges.js). Providers in rows,
// receivers in columns; a cell is on when the row's device sends it and the column's takes it, lit when
// they're connected now; the reason on hover. This computer's row (what it sends) and column (what it
// takes) are switches; every other device's cells are theirs, shown as they told.
//   const mx = MeshMatrix.create({ toggle(id, feature, dir, on), setApp(from, app, name, show) })
//   body.append(mx.el); mx.render(state.matrix, state.notifs && state.notifs.appsFrom)
// Notifications also list, below the grid, each sending device's apps with a switch each: shown here
// or not (this computer's column; shared/notifrules.js fromApps).
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
      drawApps();
    });
    seg.set(feature);
    const grid = UI.el('div', { class: 'mx-grid', attrs: { role: 'grid' } });
    const hint = UI.note('info', t('Rows send to columns. This computer’s row and column can be changed here.'));
    const appsBox = UI.el('div', { class: 'mx-apps' });
    el.append(seg.el, grid, hint, appsBox);
    let appsFrom = {};
    const openApps = new Set();

    function drawApps() {
      appsBox.textContent = '';
      const m = last;
      if (feature !== 'notifs' || !m || !m.devices) return;
      const senders = m.devices.filter((d) => !d.self && (appsFrom[d.id] || []).length);
      if (!senders.length) return;
      const rows = [];
      for (const d of senders) {
        const list = appsFrom[d.id];
        const off = list.filter((a) => a.hidden).length;
        const shown = openApps.has(d.id);
        rows.push(UI.row(d.name, off ? t('{count} of {total} apps hidden', { count: off, total: list.length }) : t('All apps shown'), [
          UI.osIcon(d.os),
          UI.button(shown ? t('Done') : t('Apps'), () => { shown ? openApps.delete(d.id) : openApps.add(d.id); drawApps(); }, 'small'),
        ], { literal: true }));
        if (shown) {
          for (const a of list) {
            const sw = UI.switch((v) => opts.setApp && opts.setApp(d.id, a.app, a.name, v), { label: a.name });
            sw.set(!a.hidden);
            const r = UI.row(a.name, '', [sw], { literal: true });
            r.classList.add('mx-app');
            rows.push(r);
          }
        }
      }
      appsBox.append(UI.card(t('Apps by device'), rows));
    }

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
      render(m, apps) {
        const key = JSON.stringify([m || null, apps || null]);
        if (key === el.dataset.key) return;
        el.dataset.key = key;
        last = m;
        appsFrom = apps && typeof apps === 'object' ? apps : {};
        el.hidden = !m || !m.devices || m.devices.length < 2;
        draw();
        drawApps();
      },
    };
  }

  window.MeshMatrix = { create };
})();
