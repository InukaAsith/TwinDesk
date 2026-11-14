// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications tab: the other computer's notifications here as Windows
// toasts from TwinDesk, and this PC's on the other computer (read from Windows' notification
// database by the helper). Two direction cards, then the apps seen sending.
'use strict';

UI.tab({
  id: 'notifications',
  order: 45,
  title: I18n.t('Notifications'),
  icon: 'bell',
  color: 'linear-gradient(#ff6961, #ff3b30)',
  desc: I18n.t('See one computer’s notifications on the other.'),
  // One switch for the whole tab (both directions); each direction is shared with the
  // other computer per pair (pair.sync), so flipping it there flips it here.
  master: { get: (s) => s.notifs.send || s.notifs.receive, set: (v) => UI.api.setNotifs({ send: v, receive: v }) },
  badge: (s) => (s.notifs.send || s.notifs.receive ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const hideSw = UI.switch((v) => api.setNotifs({ hideText: v }), { label: I18n.t('Hide message text') });
    const hideRow = UI.row(I18n.t('Hide message text'), I18n.t('Only the app and the title'), [hideSw]);
    const note = UI.note('info', '');
    const pair = UI.dirCards(
      { on: { get: (s) => s.notifs.receive, set: (v) => api.setNotifs({ receive: v }) }, label: I18n.t('Show {name}’s notifications on {me}'), rows: [] },
      { on: { get: (s) => s.notifs.send, set: (v) => api.setNotifs({ send: v }) }, label: I18n.t('Show {me}’s notifications on {name}'), rows: [hideRow] },
    );
    const recvRow = pair.a.main, sendRow = pair.b.main;
    const apps = el('div');

    const hist = UI.historyCard('notifs', { list: true });
    body.append(note, pair.el, UI.card(I18n.t('Apps'), [apps]), hist.el);

    let key = '';
    return (s) => {
      const n = s.notifs;
      hist.update(s);
      const p = UI.peer(s);
      const connected = s.link.state === 'connected';
      pair.update(s);
      note.set('');
      hideSw.set(n.hideText);
      recvRow.setHint(n.receive && n.shown ? I18n.t('{count} shown', { count: n.shown }) : I18n.t('As desktop notifications, from TwinDesk'));
      sendRow.setHint(n.readable === false ? I18n.t('Can’t read this desktop’s notifications (dbus-monitor missing)')
        : !n.send ? '' : !connected ? I18n.t('Also switches it on the other computer') : n.sent ? I18n.t('{count} sent', { count: n.sent }) : I18n.t('As native notifications there'));
      const k = JSON.stringify([n.apps.map((a) => a.app), n.muted]);
      if (k === key) return;
      key = k;
      apps.replaceChildren(...(n.apps.length
        ? n.apps.map((a) => {
          const sw = UI.switch((v) => api.muteNotifApp({ app: a.app, muted: !v }), { label: I18n.t('Send {app}', { app: a.appName }) });
          sw.set(!n.muted.includes(a.app));
          return UI.row(a.appName, '', [sw], { literal: true });
        })
        : [UI.row(I18n.t('No notifications yet'), I18n.t('Apps show up here after their first notification while sending is on'))]));
    };
  },
});
