// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications tab: the other computer's notifications here as Windows
// toasts from TwinDesk, and this PC's on the other computer (read from Windows' notification
// database by the helper). Two direction cards, then the apps seen sending.
'use strict';

UI.tab({
  id: 'notifications',
  order: 45,
  title: 'Notifications',
  icon: 'bell',
  color: 'linear-gradient(#ff6961, #ff3b30)',
  desc: 'See one computer’s notifications on the other.',
  // One switch for the whole tab (both directions); each direction is shared with the
  // other computer per pair (pair.sync), so flipping it there flips it here.
  master: { get: (s) => s.notifs.send || s.notifs.receive, set: (v) => UI.api.setNotifs({ send: v, receive: v }) },
  badge: (s) => (s.notifs.send || s.notifs.receive ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const hideSw = UI.switch((v) => api.setNotifs({ hideText: v }), { label: 'Hide message text' });
    const hideRow = UI.row('Hide message text', 'Only the app and the title', [hideSw]);
    const note = UI.note('info', '');
    const pair = UI.dirCards(
      { on: { get: (s) => s.notifs.receive, set: (v) => api.setNotifs({ receive: v }) }, label: 'Show {name}’s notifications on {me}', rows: [] },
      { on: { get: (s) => s.notifs.send, set: (v) => api.setNotifs({ send: v }) }, label: 'Show {me}’s notifications on {name}', rows: [hideRow] },
    );
    const recvRow = pair.a.main, sendRow = pair.b.main;
    const histList = el('div');
    const clearBtn = UI.button('Clear', () => api.clearNotifHistory(), 'small');
    const histCard = UI.card('Recent Notifications', [histList], clearBtn);
    const apps = el('div');

    body.append(note, pair.el, histCard, UI.card('Apps', [apps]));

    let key = '';
    let histKey = '';
    return (s) => {
      const n = s.notifs;
      const p = UI.peer(s);
      const connected = s.link.state === 'connected';
      pair.update(s);
      note.set('');
      hideSw.set(n.hideText);
      recvRow.setHint(n.receive && n.shown ? n.shown + ' shown' : 'As Windows notifications, from TwinDesk');
      sendRow.setHint(n.readable === false ? 'Windows’ notification list can’t be read'
        : !n.send ? '' : !connected ? 'Also switches it on the other computer' : n.sent ? n.sent + ' sent' : 'As native notifications there');

      // Recent notifications
      const history = n.history || [];
      const hk = JSON.stringify(history.map((h) => [h.id, h.at]));
      if (hk !== histKey) {
        histKey = hk;
        if (history.length) {
          histList.replaceChildren(...history.map((item) => {
            const appName = item.appName || item.app;
            const isPhone = UI.isPhone(s);
            const openBtn = isPhone && item.app ? UI.button('Open', () => api.openNotifiedApp({ app: item.app, appName }), 'small') : null;
            const time = UI.ago(item.at);
            const topText = [appName, item.title].filter(Boolean).join(' · ');
            const subText = [item.subtitle, item.body].filter(Boolean).join(' — ') || 'Notification';
            const r = UI.row(topText, `${subText} · ${time}`, [openBtn]);
            if (item.icon) {
              const img = el('img', { src: item.icon, style: 'width: 20px; height: 20px; border-radius: 4px; margin-right: 8px; vertical-align: middle; flex-shrink: 0;' });
              r.querySelector('.text').prepend(img);
              r.classList.add('with-ico');
            }
            return r;
          }));
        } else {
          histList.replaceChildren(UI.row('No notifications yet', 'Incoming notifications from WhatsApp, Instagram, and other apps will appear here in real-time.'));
        }
      }

      const k = JSON.stringify([n.apps.map((a) => a.app), n.muted]);
      if (k === key) return;
      key = k;
      apps.replaceChildren(...(n.apps.length
        ? n.apps.map((a) => {
          const sw = UI.switch((v) => api.muteNotifApp({ app: a.app, muted: !v }), { label: 'Send ' + a.appName });
          sw.set(!n.muted.includes(a.app));
          return UI.row(a.appName, '', [sw]);
        })
        : [UI.row('No notifications yet', 'Apps show up here after their first notification while sending is on')]));
    };
  },
});
