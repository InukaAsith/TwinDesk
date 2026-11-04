// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio tab: sound on its own, both ways, independent of the screen.
'use strict';

UI.tab({
  id: 'audio',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  group: 'More',
  order: 70,
  title: I18n.t('Audio'),
  desc: I18n.t('Hear one computer on the other.'),
  color: 'linear-gradient(#ff6482, #ff2d55)',
  master: { get: (s) => !!(s.audio && (s.audio.send || s.audio.receive)), set: (v) => UI.api.setAudio({ send: v, receive: v }) },
  badge: (s) => (s.audio && (s.audio.send || s.audio.receive) ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const sendSw = UI.switch((v) => api.setAudio({ send: v }), { label: I18n.t('Send sound') });
    const mute = UI.switch((v) => api.setAudio({ muteLocal: v }), { label: I18n.t('Mute while sending') });
    const recvSw = UI.switch((v) => api.setAudio({ receive: v }), { label: I18n.t('Play sound here') });
    const vol = UI.slider({ min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }, (v) => api.setAudio({ volume: v }));
    const sendRow = UI.row(I18n.t('Play {me}’s sound on {name}'), '', [sendSw], { literalHint: true });
    const recvRow = UI.row(I18n.t('Play {name}’s sound on {me}'), '', [recvSw], { literalHint: true });
    const phoneCard = UI.phoneAudioCard(); // a phone: its media controls on Overview
    const micCard = UI.micCard ? UI.micCard() : null; // Microphone, each way (shared/ui-mic.js)
    body.append(
      UI.pair(
        UI.dir('m2w', [sendRow, UI.row(I18n.t('Mute {me} while sending'), '', [mute])]),
        UI.dir('w2m', [recvRow, UI.row(I18n.t('Volume'), '', [vol])]),
      ),
      ...(micCard ? [micCard.el] : []),
      phoneCard.el,
    );
    const live = (x) => x && x.status === 'live';
    return (s) => {
      const a = s.audio;
      if (!a) return;
      phoneCard.update(s);
      if (micCard) { micCard.update(s); }
      sendSw.set(a.send);
      mute.set(a.muteLocal);
      recvSw.set(a.receive);
      vol.set(a.volume);
      const pc = UI.peer(s).name;
      sendRow.setHint(!a.send || !s.client ? ''
        : a.screenCarries ? I18n.t('Playing with the screen')
          : !a.peerAccepts ? I18n.t('Turned off on {device}', { device: pc })
            : a.error ? I18n.t('Can’t capture sound: {error}', { error: a.error })
              : live(a.sending) ? I18n.t('Playing on {device}', { device: pc }) : I18n.t('Connecting…'));
      const phone = UI.phoneSound && UI.phoneSound(s);
      recvRow.setHint(!a.receive ? '' : phone != null ? phone : !s.client ? '' : live(a.receiving) ? I18n.t('Playing {device}', { device: pc }) : I18n.t('Waiting for {device}', { device: pc }));
    };
  },
});
