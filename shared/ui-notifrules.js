// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications › Showing here (Mac, PC and Linux, one-to-one and Multi-device): how the other
// device's notifications show on this computer (shared/notifrules.js, settings.notifs):
//   Pop-ups        TwinDesk's own (Reply, its buttons, pictures, progress), the system's, or none (Recent only)
//   Copy codes by themselves
//   Pause pop-ups on a schedule, from … to …
//   each phone app: Show, No pop-ups (Recent only) or Hide
// UI.notifShowCard() → {el, update(state)}; state.notifs is settings.notifs with notifs.js's view.
'use strict';

UI.notifShowCard = () => {
  const t = (...a) => (typeof I18n === 'undefined' ? a[0] : I18n.t(...a));
  const { el, api } = UI;
  const set = (p) => api.setNotifs(p);
  const mac = /Mac/.test(navigator.platform || navigator.userAgent);

  const style = UI.segmented([{ value: 'twindesk', label: t('TwinDesk') }, { value: 'system', label: t('System') }, { value: 'none', label: t('None') }], (v) => set({ style: v }));
  const styleRow = UI.row(t('Pop-ups'), '', [style.el]);

  const otp = UI.switch((v) => set({ otpCopy: v }), { label: t('Copy codes by themselves') });
  const otpRow = UI.row(t('Copy codes by themselves'), t('A one-time code goes straight on the clipboard: never to other devices or the clipboard history, and off it after 2 minutes'), [otp]);

  // The schedule: a switch, then from and to (time inputs, saved when changed).
  const time = (key) => {
    const i = el('input', { type: 'time', class: 'notif-time', attrs: { 'aria-label': key === 'from' ? t('From') : t('To') } });
    i.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(i.value)) set({ quiet: { [key]: i.value } }); });
    return i;
  };
  const from = time('from');
  const to = time('to');
  const quiet = UI.switch((v) => set({ quiet: { on: v } }), { label: t('Pause pop-ups on a schedule') });
  const quietRow = UI.row(t('Pause pop-ups on a schedule'), '', [quiet]);
  const hours = el('span', { class: 'notif-hours' }, [from, el('span', { class: 'hint', text: '–' }), to]);
  const hoursRow = UI.row(t('Paused'), t('Overnight works too: 22:00 to 07:00'), [hours]);

  // Each phone app: Show, No pop-ups or Hide.
  const appsBox = el('div');
  const appsHead = el('div', { class: 'notif-apps-head hint', text: t('Each app') });
  const MODES = [{ value: 'show', label: t('Show') }, { value: 'quiet', label: t('No pop-ups') }, { value: 'hide', label: t('Hide') }];

  const card = UI.card(t('Showing here'), [styleRow, otpRow, quietRow, hoursRow, appsHead, appsBox]);
  let key = '';

  return {
    el: card,
    update(s) {
      const n = s.notifs || {};
      card.hidden = !n.receive;
      if (card.hidden) return;
      const st = n.style === 'twindesk' || n.style === 'none' ? n.style : 'system';
      style.set(st);
      styleRow.setHint(st === 'none' ? t('No pop-ups, and nothing in the system’s notification center: they go in Recent only') : st === 'twindesk' ? t('TwinDesk’s own: Reply, the app’s buttons, pictures and progress right in it') : mac ? t('macOS notifications, with Reply and the app’s buttons') : t('The system’s notifications'));
      otp.set(!!n.otpCopy);
      const q = n.quiet || { on: false, from: '22:00', to: '07:00' };
      quiet.set(!!q.on);
      quietRow.setHint(q.on ? t('Notifications still go in Recent and Messages') : t('No pop-ups at night or in meetings; they still go in Recent'));
      hoursRow.hidden = !q.on;
      if (document.activeElement !== from) from.value = q.from || '22:00';
      if (document.activeElement !== to) to.value = q.to || '07:00';

      // The apps: those that sent something lately, and those set to No pop-ups or Hide.
      const own = n.phoneApps || {};
      const seen = new Map();
      for (const h of n.history || []) if (h.app && !seen.has(h.app)) seen.set(h.app, h.appName || h.app);
      for (const [app, v] of Object.entries(own)) if (!seen.has(app)) seen.set(app, v.name || app);
      const icons = n.historyIcons || {};
      const list = [...seen].sort((a, b) => a[1].localeCompare(b[1]));
      const k = JSON.stringify([list, own, Object.keys(icons)]);
      appsHead.hidden = !list.length;
      if (k === key) return;
      key = k;
      appsBox.replaceChildren(...list.map(([app, name]) => {
        const seg = UI.segmented(MODES, (v) => set({ phoneApp: { app, name, mode: v } }));
        seg.set((own[app] && own[app].mode) || 'show');
        const r = UI.row(name, '', [seg.el], { literal: true });
        const ico = icons[app] ? el('img', { class: 'notif-app-ico', src: icons[app], alt: '' }) : UI.avatar ? UI.avatar(name) : null;
        if (ico) { ico.classList.add('notif-app-ico'); r.prepend(ico); }
        return r;
      }));
    },
  };
};
