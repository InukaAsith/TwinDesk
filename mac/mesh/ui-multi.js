// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Multi-device tab with it on (docs/multi-device.md): what only several devices need, in one place.
// Turn off (TwinDesk restarts one to one), where the devices sit (the shared layout's grid, docs/mesh.md
// "Shared layout"), and Join every device automatically (docs/mesh.md "Joining everyone").
'use strict';

UI.tab({
  id: 'multi',
  order: 95,
  title: I18n.t('Multi-device'),
  heading: I18n.t('Multi-device · Mesh mode'),
  desc: I18n.t('Several computers and phones connected at once'),
  color: 'linear-gradient(#5e5ce6, #3634a3)',
  bottom: true,
  build(body) {
    const { el, api } = UI;
    const turnOff = UI.button(I18n.t('Turn off'), () => {
      turnOff.disabled = true;
      turnOff.textContent = I18n.t('Restarting…');
      api.setMulti(false);
    }, 'small');

    // ---- the layout: a grid of tiles (docs/mesh.md, "Shared layout") ----
    // Every device is a tile; its edges lead to the nearest tile on its row or column. Click a tile and
    // then an empty place to move it there, or then another tile to swap the two. Each change goes through
    // setLayoutCell, so every computer shows the same grid.
    // Tiles sit side by side, with no empty space between them: a tile goes only next to another one by a
    // side (not a corner), the places it may go are lit (layout.targets), and the rest close up behind it.
    let picked = null; // the device id picked, waiting for a place or another tile
    let last = null; // the last state, to draw the grid again
    const layoutHint = UI.note('info', '');
    const reachNote = UI.note('warn', '', { literal: true }); // the devices the pointer can't get to from here, and why
    const gridEl = el('div', { class: 'layout-map' });

    const cellOf = (id) => (last && last.layout && last.layout.cells[id]) || null;

    // An empty place the picked tile may go to: next to another tile by a side (layout.targets, from
    // shared/layout.js). A tile on its own may go anywhere.
    function canGo(id, x, y) {
      const lay = last && last.layout;
      const t = lay && lay.targets && lay.targets[id];
      if (!Array.isArray(t) || Object.keys(lay.cells).length < 2) return true;
      return t.includes(x + ',' + y);
    }

    function move(id, x, y) {
      api.setLayoutCell({ id, x, y });
    }

    function pick(id) {
      picked = id;
      if (last) drawLayout(last);
    }

    // A tile was clicked: it is picked; a picked tile clicked again is put down; with a tile already picked,
    // the two swap places.
    function onTile(id) {
      if (picked === id) return pick(null);
      if (!picked) return pick(id);
      const from = picked;
      const to = cellOf(id);
      pick(null);
      if (to) move(from, to.x, to.y);
    }

    // An empty place was clicked: the picked device moves there.
    function onPlace(x, y) {
      if (!picked || !canGo(picked, x, y)) return;
      const id = picked;
      pick(null);
      move(id, x, y);
    }

    // reach (L.reach, from layout-sync): 'blocked', the pointer stops before it, shown red when the device
    // is in the mesh but not connected to this Mac (one that is off is just off); 'behind', only past such a
    // device, greyed: the mouse and keyboard here get to neither (docs/mesh.md, "Chains").
    function tile(id, info, reach) {
      const red = reach === 'blocked' && info.via;
      const state = info.self ? I18n.t('This Mac') : red ? I18n.t('Not paired here') : reach === 'behind' ? I18n.t('Out of reach')
        : info.connected ? I18n.t('Connected') : I18n.t('Not connected');
      const why = red ? I18n.t(': not connected to this Mac, so the pointer stops before it')
        : reach === 'behind' ? I18n.t(': the pointer gets there only past a device it can\'t reach from here') : '';
      return el('button', {
        class: 'lay-tile' + (info.self ? ' here' : '') + (info.connected || info.self || red ? '' : ' off') + (red ? ' blocked' : '')
          + (reach === 'behind' ? ' behind' : '') + (picked === id ? ' picked' : ''),
        attrs: { type: 'button', title: `${info.name} — ${state}${why}` },
        onclick: () => onTile(id),
      }, [
        UI.osIcon(info.os),
        el('span', { class: 'lay-name', text: info.name }),
        el('span', { class: 'lay-state', text: state }),
      ]);
    }

    function place(x, y) {
      const ok = !!picked && canGo(picked, x, y);
      return el('button', {
        class: 'lay-place' + (ok ? ' target' : ''),
        disabled: !!picked && !ok,
        attrs: { type: 'button', 'aria-label': ok ? I18n.t('Move here') : I18n.t('Empty place') },
        onclick: () => onPlace(x, y),
      });
    }

    function drawLayout(s) {
      const lay = s && s.layout;
      if (!lay || !lay.grid) return;
      if (picked && !lay.cells[picked]) picked = null; // a device that is gone cannot be moved
      const people = new Map([[s.macId, { name: s.macName || I18n.t('This Mac'), os: 'mac', connected: true, self: true }]]);
      for (const d of s.peers || []) {
        if (d && d.id) people.set(d.id, { name: d.name || d.id.slice(0, 8), os: d.os, connected: !!d.connected, self: false, via: d.state === 'via' });
      }
      const at = new Map();
      for (const id of Object.keys(lay.cells)) at.set(`${lay.cells[id].x},${lay.cells[id].y}`, id);
      const g = lay.grid;
      gridEl.style.gridTemplateColumns = `repeat(${g.maxX - g.minX + 1}, minmax(96px, 1fr))`;
      const cells = [];
      for (let y = g.minY; y <= g.maxY; y++) {
        for (let x = g.minX; x <= g.maxX; x++) {
          const id = at.get(`${x},${y}`);
          cells.push(id ? tile(id, people.get(id) || { name: id.slice(0, 8), os: '', connected: false, self: false }, lay.reach && lay.reach[id]) : place(x, y));
        }
      }
      gridEl.replaceChildren(...cells);
      const reach = lay.reach || {};
      const red = Object.keys(reach).filter((id) => reach[id] === 'blocked' && (people.get(id) || {}).via);
      const behind = Object.values(reach).includes('behind');
      const autoJoin = (s.mesh || {}).autoJoin === true;
      reachNote.set(red.length ? I18n.t(behind
        ? autoJoin ? '{devices} are not connected to this Mac, so the pointer stops before them and does not get to the devices past them. Pair them with this Mac.' : '{devices} are not connected to this Mac, so the pointer stops before them and does not get to the devices past them. Pair them with this Mac, or turn on Join every device automatically.'
        : autoJoin ? '{devices} are not connected to this Mac, so the pointer stops before them. Pair them with this Mac.' : '{devices} are not connected to this Mac, so the pointer stops before them. Pair them with this Mac, or turn on Join every device automatically.', { devices: red.map((id) => people.get(id).name).join(', ') }) : '');
      layoutHint.set(picked
        ? I18n.t('Now click a lit place next to another device to move it there, or another device to swap places.')
        : I18n.t('Click a device, then a place next to another device to move it there, or another device to swap places. Devices sit side by side, with no empty space between them.'));
    }


    const joinSw = UI.switch((v) => api.setMesh({ autoJoin: v }), { label: I18n.t('Join every device automatically') });
    const joinRow = UI.row(I18n.t('Join every device automatically'), '', [joinSw]);

    body.append(
      UI.card(I18n.t('Mesh mode'), [
        UI.row(I18n.t('Use several devices at once'), I18n.t('On. TwinDesk restarts when you turn it on or off'), [turnOff]),
      ]),
      UI.card(I18n.t('Layout'), [gridEl, reachNote, layoutHint], { cls: 'keep-on' }),
      UI.card(I18n.t('Joining'), [joinRow]),
    );

    return (s) => {
      last = s;
      drawLayout(s);
      const jn = !!(s.mesh && s.mesh.autoJoin === true);
      joinSw.set(jn);
      joinRow.setHint(jn ? I18n.t('Pair with one device and the rest connect to this Mac by themselves. Devices you pair with can introduce others, without a pairing code')
        : I18n.t('Off: this Mac neither introduces devices to each other nor accepts an introduction. Pair each device yourself'));
    };
  },
});
