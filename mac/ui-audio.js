// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio tab: sound on its own, both ways, independent of the screen.
'use strict';

UI.tab({
  id: 'audio',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  group: 'More',
  order: 70,
  title: 'Audio',
  desc: 'Hear one computer on the other.',
  color: 'linear-gradient(#ff6482, #ff2d55)',
  master: { get: (s) => !!(s.audio && (s.audio.send || s.audio.receive)), set: (v) => UI.api.setAudio({ send: v, receive: v }) },
  badge: (s) => (s.audio && (s.audio.send || s.audio.receive) ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const sendSw = UI.switch((v) => api.setAudio({ send: v }), { label: 'Send sound' });
    const mute = UI.switch((v) => api.setAudio({ muteLocal: v }), { label: 'Mute while sending' });
    const recvSw = UI.switch((v) => api.setAudio({ receive: v }), { label: 'Play sound here' });
    const vol = UI.slider({ min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }, (v) => api.setAudio({ volume: v }));
    const sendRow = UI.row('Play {me}’s sound on {name}', '', [sendSw]);
    const recvRow = UI.row('Play {name}’s sound on {me}', '', [recvSw]);
    body.append(
      UI.pair(
        UI.dir('m2w', [sendRow, UI.row('Mute {me} while sending', '', [mute])]),
        UI.dir('w2m', [recvRow, UI.row('Volume', '', [vol])]),
      ),
    );
    const live = (x) => x && x.status === 'live';
    return (s) => {
      const a = s.audio;
      if (!a) return;
      sendSw.set(a.send);
      mute.set(a.muteLocal);
      recvSw.set(a.receive);
      vol.set(a.volume);
      const pc = UI.peer(s).name;
      sendRow.setHint(!a.send || !s.client ? ''
        : a.screenCarries ? 'Playing with the screen'
          : !a.peerAccepts ? `Turned off on ${pc}`
            : a.error ? `Can’t capture sound: ${a.error}`
              : live(a.sending) ? `Playing on ${pc}` : 'Connecting…');
      const phone = UI.phoneSound && UI.phoneSound(s);
      recvRow.setHint(!a.receive ? '' : phone != null ? phone : !s.client ? '' : live(a.receiving) ? `Playing ${pc}` : `Waiting for ${pc}`);
    };
  },
});
