// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio tab: sound both ways, each its own stream: play the Mac's sound (Mac → PC)
// and send this PC's sound (PC → Mac). Screen sound lives in Display.
'use strict';

UI.tab({
  id: 'audio',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  order: 70,
  title: 'Audio',
  color: 'linear-gradient(#ff6482, #ff2d55)',
  desc: 'Hear one computer on the other.',
  master: { get: (s) => s.audio.send || s.audio.receive, set: (v) => UI.api.setAudio({ send: v, receive: v }) },
  badge: (s) => (s.audio.receiving || s.audio.sending ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const set = (partial) => api.setAudio(partial);
    const volume = UI.slider({ min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%' }, (v) => set({ volume: v }));
    const mute = UI.switch((v) => set({ muteLocal: v }), { label: 'Mute {me} while sending' });
    const recvState = UI.row('', '');
    const sendState = UI.row('', '');
    const pair = UI.dirCards(
      { on: { get: (s) => s.audio.receive, set: (v) => set({ receive: v }) }, label: 'Play {name}’s sound on {me}', rows: [
        UI.row('Volume', '', [volume]),
        recvState,
      ] },
      { on: { get: (s) => s.audio.send, set: (v) => set({ send: v }) }, label: 'Play {me}’s sound on {name}', rows: [
        UI.row('Mute {me} while sending', '', [mute]),
        sendState,
      ] },
    );
    body.append(
      pair.el,
    );
    return (s) => {
      const a = s.audio;
      const connected = s.link.state === 'connected';
      pair.update(s);
      volume.set(a.volume);
      mute.set(a.muteLocal);
      recvState.hidden = !a.receive;
      const nm = UI.peer(s).name;
      const phone = UI.phoneSound && UI.phoneSound(s);
      recvState.label.textContent = phone != null ? phone : a.receiving ? 'Playing ' + nm : connected ? 'Turned off on ' + nm : 'Waiting for ' + nm;
      sendState.hidden = !a.send && !a.error;
      sendState.label.textContent = a.sending ? 'Playing on ' + nm : !connected ? 'Waiting for ' + nm : !a.macAccepts ? 'Turned off on ' + nm : 'Connecting…';
      sendState.setHint(a.error || '');
    };
  },
});
