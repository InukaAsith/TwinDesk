// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps tab: Mac apps on the PC and PC apps on this Mac, in equal places.
'use strict';

UI.tab({
  id: 'apps',
  hidden: (s) => UI.isPhone(s), // the Phone page has the phone's screen, sound and apps
  group: 'More',
  order: 80,
  title: 'Apps',
  desc: 'Open apps from the other computer in their own windows.',
  color: 'linear-gradient(#bf5af2, #5e5ce6)',
  master: { get: (s) => !!((s.apps && s.apps.offer) || (s.papps && s.papps.on)), set: (v) => { UI.api.setApps({ offer: v }); UI.api.setPcApps({ on: v }); } },
  badge: (s) => ((s.apps && s.apps.offer) || (s.papps && s.papps.on) ? 'on' : ''),
  build(body) {
    const { api, el } = UI;
    const offerSw = UI.switch((v) => api.setApps({ offer: v }), { label: 'Share apps' });
    const offerRow = UI.row('Open {me}’s apps on {name}', '', [offerSw]);
    const usage = UI.row('Open there now', '');
    const pcSw = UI.switch((v) => api.setPcApps({ on: v }), { label: 'Show apps here' });
    const pcRow = UI.row('Open {name}’s apps on {me}', '', [pcSw]);
    const pcUsage = UI.row('Open here now', '');
    const grid = el('div', { class: 'app-grid' });
    const refresh = UI.button('Refresh', () => api.listPcApps(), 'small');
    const filter = el('input', { class: 'app-filter', type: 'search', placeholder: 'Search apps' });
    const gridCard = UI.card('{Name}’s apps', [el('div', { class: 'app-tools' }, [filter, refresh]), grid], { cls: 'keep-on' });
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
        const b = el('button', { class: `app-tile${open.has(a.id) ? ' running' : ''}`, title: st && st !== 'ok' ? `Couldn’t open: ${st}` : `Open ${a.name} on ${UI.peer(UI.state).name}` }, [
          UI.appIcon(a.icon),
          el('span', { class: 'app-name', text: a.name }),
          el('span', { class: 'app-state', text: open.has(a.id) ? 'Open' : st === '' ? 'Opening…' : st && st !== 'ok' ? 'Failed' : '' }),
        ]);
        b.onclick = () => api.openPcApp(a.id);
        // Pin: keep it in the Dock (and Launchpad), like a Mac app.
        const pin = el('span', { class: 'app-pin', title: `Add ${a.name} to the Dock`, attrs: { role: 'button', 'aria-label': `Add ${a.name} to the Dock` } }, [UI.icon('pin')]);
        pin.onclick = (e) => { e.stopPropagation(); api.keepPcAppInDock(a.id); };
        b.append(pin);
        b.oncontextmenu = (e) => { e.preventDefault(); api.keepPcAppInDock(a.id); };
        return b;
      }));
      if (!apps.length) grid.append(el('div', { class: 'app-empty', text: p.listing ? `Loading ${UI.peer(UI.state).name}’s apps…` : q ? 'No app matches' : 'No apps yet. Press Refresh.' }));
    }
    body.append(
      UI.pair(
        UI.dir('m2w', [
          offerRow,
          usage,
        ]),
        UI.dir('w2m', [pcRow, pcUsage]),
      ),
      gridCard,
    );
    return (s) => {
      const a = s.apps;
      if (!a) return;
      offerSw.set(a.offer);
      offerRow.setHint(!a.offer ? ''
        : !s.sharing || !s.sharing.on ? 'Screen sharing turns on while an app is open'
          : !s.permissions.accessibility ? 'Needs Accessibility (General)' : '');
      const p = s.papps;
      if (p) {
        pcSw.set(p.on);
        pcRow.setHint(p.on && !s.client ? `Waiting for ${UI.peer(s).name}` : '');
        pcUsage.setHint(p.windows.length ? `${p.windows.length} window${p.windows.length > 1 ? 's' : ''}` : 'Nothing open');
        gridCard.hidden = !p.on || !s.client;
        draw(p);
      }
      usage.setHint(a.launched.length ? `${a.launched.length} app${a.launched.length > 1 ? 's' : ''}` : 'Nothing open');
    };
  },
});
