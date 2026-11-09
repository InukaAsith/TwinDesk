// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps tab: Mac apps on the PC and PC apps on this Mac, in equal places.
'use strict';

UI.tab({
  id: 'apps',
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  group: 'More',
  order: 80,
  title: I18n.t('Apps'),
  desc: I18n.t('Open apps from the other computer in their own windows.'),
  color: 'linear-gradient(#bf5af2, #5e5ce6)',
  master: { get: (s) => !!((s.apps && s.apps.offer) || (s.papps && s.papps.on)), set: (v) => { UI.api.setApps({ offer: v }); UI.api.setPcApps({ on: v }); } },
  badge: (s) => ((s.apps && s.apps.offer) || (s.papps && s.papps.on) ? 'on' : ''),
  build(body) {
    const { api, el } = UI;
    const offerSw = UI.switch((v) => api.setApps({ offer: v }), { label: I18n.t('Share apps') });
    const offerRow = UI.row(I18n.t('Open {me}’s apps on {name}'), '', [offerSw]);
    const usage = UI.row(I18n.t('Open there now'), '');
    // apps.onVirtual (apps.js _holdVirtual): off by default, apps open on the shared screen as before.
    const vdSw = UI.switch((v) => api.setApps({ onVirtual: v }), { label: I18n.t('Open on a virtual display') });
    const vdRow = UI.row(I18n.t('Open on a virtual display'), I18n.t('Apps open on their own virtual display, in Mirror mode too. Off: they open on the shared screen, as before'), [vdSw]);
    const pcSw = UI.switch((v) => api.setPcApps({ on: v }), { label: I18n.t('Show apps here') });
    const pcRow = UI.row(I18n.t('Open {name}’s apps on {me}'), '', [pcSw], { literalHint: true });
    const pcUsage = UI.row(I18n.t('Open here now'), '');
    const grid = el('div', { class: 'app-grid' });
    const refresh = UI.button(I18n.t('Refresh'), () => api.listPcApps(), 'small');
    const filter = el('input', { class: 'app-filter', type: 'search', placeholder: I18n.t('Search apps') });
    const gridCard = UI.card(I18n.t('{Name}’s apps'), [el('div', { class: 'app-tools' }, [filter, refresh]), grid], { cls: 'keep-on' });
    let lastKey = '';
    let last = null;
    filter.oninput = () => { lastKey = ''; if (last) draw(last); };
    function draw(p) {
      last = p;
      const q = filter.value.trim().toLowerCase();
      const apps = p.apps.filter((a) => !q || a.name.toLowerCase().includes(q));
      const key = JSON.stringify([q, apps.map((a) => a.id), p.launch, p.windows.map((w) => w.id)]);
      if (key === lastKey) return;
      lastKey = key;
      const open = new Set(p.windows.map((w) => w.id));
      grid.replaceChildren(...apps.map((a) => {
        const st = p.launch[a.id];
        const b = el('button', { class: `app-tile${open.has(a.id) ? ' running' : ''}`, title: st && st !== 'ok' ? I18n.t('Couldn’t open: {error}', { error: st }) : I18n.t('Open {app} on {device}', { app: a.name, device: UI.peer(UI.state).name }) }, [
          UI.appIcon(a.icon),
          el('span', { class: 'app-name', text: a.name }),
          el('span', { class: 'app-state', text: open.has(a.id) ? I18n.t('Open') : st === '' ? I18n.t('Opening…') : st && st !== 'ok' ? I18n.t('Failed') : '' }),
        ]);
        b.onclick = () => api.openPcApp(a.id);
        // Pin: keep it in the Dock (and Launchpad), like a Mac app.
        const pin = el('span', { class: 'app-pin', title: I18n.t('Add {app} to the Dock', { app: a.name }), attrs: { role: 'button', 'aria-label': I18n.t('Add {app} to the Dock', { app: a.name }) } }, [UI.icon('pin')]);
        pin.onclick = (e) => { e.stopPropagation(); api.keepPcAppInDock(a.id); };
        b.append(pin);
        b.oncontextmenu = (e) => { e.preventDefault(); api.keepPcAppInDock(a.id); };
        return b;
      }));
      if (!apps.length) grid.append(el('div', { class: 'app-empty', text: p.listing ? I18n.t('Loading {device}’s apps…', { device: UI.peer(UI.state).name }) : q ? I18n.t('No app matches') : I18n.t('No apps yet. Press Refresh.') }));
    }
    // Move windows (movewin.js): the key held, a window clicked and dragged past the shared edge moves
    // to the other computer (and back the same way). Off: nothing of it is loaded.
    // Right Command first: most Mac keyboards have no Right Control.
    const MOVE_KEYS = [['MetaRight', I18n.t('Right Command')], ['AltRight', I18n.t('Right Option')], ['ControlRight', I18n.t('Right Control')], ['ControlLeft', I18n.t('Left Control')],
      ['AltLeft', I18n.t('Left Option')], ['MetaLeft', I18n.t('Left Command')], ['ShiftRight', I18n.t('Right Shift')], ['ShiftLeft', I18n.t('Left Shift')]];
    const moveSw = UI.switch((v) => api.setApps({ moveWindows: v }), { label: I18n.t('Move windows') });
    const moveKey = UI.select(MOVE_KEYS.map(([value, label]) => ({ value, label })), (v) => api.setApps({ moveKey: v }));
    const moveRow = UI.row(I18n.t('Move windows to {name}'), I18n.t('Drag a window past the edge with the key held: it opens on {name} and leaves this screen. Drag it back or close it there to bring it home'), [moveSw]);
    const moveKeyRow = UI.row(I18n.t('Key to hold'), I18n.t('Hold it, then click anywhere in a window and drag'), [moveKey]);
    const moveCard = UI.card(I18n.t('Move windows'), [moveRow, moveKeyRow]);
    const rezume = UI.rezumeCard ? UI.rezumeCard() : { el: UI.el('div', { hidden: true }), update() {} }; // the other computer's ReZume (shared/ui-rezume.js; not in Multi-device)
    body.append(
      UI.pair(
        UI.dir('m2w', [
          offerRow,
          vdRow,
          usage,
        ]),
        UI.dir('w2m', [pcRow, pcUsage]),
      ),
      rezume.el,
      gridCard,
      moveCard, // below the apps list
    );
    return (s) => {
      rezume.update(s);
      const a = s.apps;
      if (!a) return;
      offerSw.set(a.offer);
      vdSw.set(!!a.onVirtual);
      vdRow.hidden = !a.offer;
      moveSw.set(!!a.moveWindows);
      moveKey.set(a.moveKey || 'MetaRight');
      moveKeyRow.hidden = !a.moveWindows;
      moveRow.setHint(a.moveWindows && !s.permissions.accessibility ? I18n.t('Needs Accessibility (General)') : I18n.t('Drag a window past the edge with the key held: it opens on {name} and leaves this screen. Drag it back or close it there to bring it home'));
      offerRow.setHint(!a.offer ? ''
        : !s.sharing || !s.sharing.on ? I18n.t('Screen sharing turns on while an app is open')
          : !s.permissions.accessibility ? I18n.t('Needs Accessibility (General)') : '');
      const p = s.papps;
      if (p) {
        pcSw.set(p.on);
        pcRow.setHint(p.on && !s.client ? I18n.t('Waiting for {device}', { device: UI.peer(s).name }) : '');
        pcUsage.setHint(p.windows.length ? I18n.t(p.windows.length === 1 ? '{count} window' : '{count} windows', { count: p.windows.length }) : I18n.t('Nothing open'));
        gridCard.hidden = !p.on || !s.client;
        draw(p);
      }
      usage.setHint(a.launched.length ? I18n.t(a.launched.length === 1 ? '{count} app' : '{count} apps', { count: a.launched.length }) : I18n.t('Nothing open'));
    };
  },
});
