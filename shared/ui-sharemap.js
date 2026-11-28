// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share screen › the sharing map (Multi-device, phase 3 of the 2026-11-28 plan): this computer's screens on
// the left, every device of the mesh on the right. Drag a screen onto a device (or select a screen, then
// the device) and that device's window opens with it: a real screen is mirrored, TwinDesk Virtual Display
// is TwinDesk's virtual display (one device at a time). Each device says what it gets; Stop sharing here, and
// Stop all in the bar below. Devices not connected are shown with Wake. Mac, Windows and Linux; each page
// maps its own state into the model below (docs/screen-mesh.md, the stream table).
//
//   const m = ShareMap.create({ assign(id, {mode: 'off'|'mirror'|'extend', displayId}), wake(id) })
//   body.append(m.el)
//   m.render({ displays: [{id, name, w, h, primary}], virtual: {can, why},
//              targets: [{id, name, os, mode, displayId, status}], offline: [{id, name, os}], selected: id })
// The selected device (the one in use: where the pointer is, Multi-device's selection) comes first, marked.
'use strict';

(function () {
  const OSNAME = { mac: 'macOS', win: 'Windows', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS', ipados: 'iPadOS' };
  const VIRTUAL = '\u0000virtual';

  function create(opts) {
    const t = (k, v) => I18n.t(k, v);
    const el = UI.el('div', { class: 'sm' });
    const side = UI.el('div', { class: 'sm-side' });
    const grid = UI.el('div', { class: 'sm-grid' });
    const count = UI.el('span', { class: 'sm-count' });
    const main = UI.el('div', { class: 'sm-main' }, [UI.el('div', { class: 'sm-head' }, [UI.el('h3', { text: t('Devices') }), count]), grid]);
    const bar = UI.el('div', { class: 'sm-bar' });
    el.append(UI.el('div', { class: 'sm-body' }, [side, main]), bar);
    let m = null, key = '', picked = null, dragging = null;

    const screenName = (id) => {
      if (id === VIRTUAL) return t('TwinDesk Virtual Display');
      const d = (m.displays || []).find((x) => x.id === id);
      return d ? UI.monitorLabel(d.name) : t('Screen');
    };
    // What a target gets, as a screen key: a display id, VIRTUAL, or ''.
    const gets = (x) => (x.mode === 'mirror' ? String(x.displayId || '') : x.mode === 'extend' ? VIRTUAL : '');
    const give = (id, screen) => {
      if (screen === VIRTUAL) opts.assign(id, { mode: 'extend' });
      else opts.assign(id, { mode: 'mirror', displayId: screen });
      picked = null;
    };

    function tile(screen, label, sub, to) {
      const off = screen === VIRTUAL && !m.virtual.can;
      const b = UI.el('button', { class: 'sm-tile' + (screen === VIRTUAL ? ' virtual' : '') + (to.length ? ' on' : '') + (picked === screen ? ' picked' : ''), attrs: { draggable: off ? 'false' : 'true', 'data-literal': '', 'aria-pressed': String(picked === screen) }, disabled: off }, [
        UI.el('span', { class: 'sm-screen' }, [UI.el('b', { text: label })]),
        UI.el('small', { text: off ? m.virtual.why || '' : to.length ? t('Shared to {devices}', { devices: to.join(', ') }) : sub }),
      ]);
      b.addEventListener('dragstart', (e) => { dragging = screen; e.dataTransfer.setData('text/plain', 'td-screen'); e.dataTransfer.effectAllowed = 'copy'; el.classList.add('dragging'); });
      b.addEventListener('dragend', () => { dragging = null; el.classList.remove('dragging'); grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
      b.onclick = () => { picked = picked === screen ? null : screen; draw(); };
      return b;
    }

    function card(x) {
      const now = gets(x);
      const drop = UI.el('div', { class: 'sm-drop' + (now ? ' has' : ''), attrs: { role: 'button', tabindex: '0', 'data-literal': '' } });
      const hint = UI.el('span', { class: 'sm-drop-hint' });
      const fill = () => {
        drop.textContent = '';
        const s = dragging || picked;
        if (s && s !== now) {
          drop.append(UI.el('b', { text: t('Drop to share {screen} here', { screen: screenName(s) }) }));
        } else if (now) {
          drop.append(UI.el('b', { text: now === VIRTUAL ? t('TwinDesk Virtual Display (Extend)') : t('{screen} (Mirror)', { screen: screenName(now) }) }),
            UI.el('span', { text: x.status === 'starting' ? t('Starting…') : t('Window open on {name}', { name: x.name }) }));
        } else drop.append(UI.el('span', { text: t('Drop a screen') }));
        drop.append(hint);
      };
      fill();
      drop.addEventListener('dragover', (e) => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; c.classList.add('over'); });
      drop.addEventListener('dragleave', () => c.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); c.classList.remove('over'); if (dragging && dragging !== now) give(x.id, dragging); dragging = null; });
      const pick = () => { if (picked && picked !== now) give(x.id, picked); };
      drop.onclick = pick;
      drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      const current = x.id === m.selected;
      const c = UI.el('div', { class: 'sm-card' + (now ? ' sharing' : '') + (picked ? ' target' : '') + (current ? ' current' : ''), attrs: { 'data-literal': '' } }, [
        UI.el('div', { class: 'sm-card-head' }, [
          UI.el('b', { text: x.name }),
          ...(current ? [UI.el('span', { class: 'sm-badge', text: t('In use') })] : []),
          UI.el('span', { class: 'sm-os on', text: OSNAME[x.os] || t('Connected') }),
        ]),
        drop,
        ...(x.error ? [UI.el('div', { class: 'sm-err', text: t(x.error) })] : []),
        ...(now ? [UI.button(t('Stop sharing here'), () => opts.assign(x.id, { mode: 'off' }), 'small danger')] : []),
      ]);
      c.refill = fill;
      return c;
    }

    function offlineCard(x) {
      return UI.el('div', { class: 'sm-card offline', attrs: { 'data-literal': '' } }, [
        UI.el('div', { class: 'sm-card-head' }, [UI.el('b', { text: x.name }), UI.el('span', { class: 'sm-os', text: t('Not connected') })]),
        UI.el('div', { class: 'sm-drop' }, [UI.el('span', { text: t('Not connected') })]),
        ...(opts.wake && !/^(android|ios|ipados)$/.test(x.os || '') ? [UI.button(t('Wake'), () => opts.wake(x.id), 'small')] : []),
      ]);
    }

    function draw() {
      const targets = (m.targets || []).slice().sort((a, b) => (b.id === m.selected) - (a.id === m.selected));
      const sharedTo = (screen) => targets.filter((x) => gets(x) === screen).map((x) => x.name);
      side.textContent = '';
      side.append(UI.el('div', { class: 'sm-side-title', text: t('Screens on this computer') }), UI.el('div', { class: 'sm-tip', text: t('Drag a screen onto a device.') }));
      for (const d of m.displays || []) side.append(tile(d.id, UI.monitorLabel(d.name) + (d.primary ? t(' (main)') : ''), `${d.w} × ${d.h}`, sharedTo(d.id)));
      if (m.virtual) side.append(tile(VIRTUAL, t('TwinDesk Virtual Display'), t('A new screen beside these'), sharedTo(VIRTUAL)));

      grid.textContent = '';
      const phones = targets.filter((x) => /^(android|ios|ipados)$/.test(x.os || '')).length;
      count.textContent = targets.length + (m.offline || []).length ? t('{connected} connected', { connected: targets.length }) + (phones ? ', ' + t(phones === 1 ? '1 phone' : '{count} phones', { count: phones }) : '') : '';
      for (const x of targets) grid.append(card(x));
      for (const x of m.offline || []) grid.append(offlineCard(x));
      if (!targets.length && !(m.offline || []).length) grid.append(UI.el('div', { class: 'sm-empty', text: t('No devices connected') }));

      bar.textContent = '';
      const live = targets.filter((x) => gets(x));
      bar.append(UI.el('b', { text: t('Sharing now') }));
      if (!live.length) bar.append(UI.el('span', { class: 'sm-none', text: t('Nothing') }));
      for (const x of live) bar.append(UI.el('span', { class: 'sm-chip', attrs: { 'data-literal': '' }, text: `${screenName(gets(x))} → ${x.name}` }));
      bar.append(UI.el('span', { class: 'sm-grow' }));
      if (live.length) bar.append(UI.button(t('Stop all'), () => { for (const x of live) opts.assign(x.id, { mode: 'off' }); }, 'small danger'));
    }

    // While dragging, every card says where the screen would go.
    el.addEventListener('dragstart', () => setTimeout(() => grid.querySelectorAll('.sm-card').forEach((c) => c.refill && c.refill()), 0));
    el.addEventListener('dragend', () => grid.querySelectorAll('.sm-card').forEach((c) => c.refill && c.refill()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picked) { picked = null; draw(); } });

    return {
      el,
      render(model) {
        const k = JSON.stringify(model || null);
        if (k === key || dragging) return;
        key = k;
        m = model || {};
        el.hidden = !model;
        if (model) draw();
      },
    };
  }

  window.ShareMap = { create };
})();
