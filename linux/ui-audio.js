// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio tab (copy of windows/ui-audio.js): sound both ways, each its own stream: play the
// other computer's sound here, and send this computer's sound there (PulseAudio/PipeWire loopback,
// loopback.js). Screen sound lives in Share screen.
'use strict';

UI.tab({
  id: 'audio',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  order: 70,
  title: I18n.t('Audio'),
  color: 'linear-gradient(#ff6482, #ff2d55)',
  desc: I18n.t('Hear one computer on the other.'),
  master: { get: (s) => s.audio.send || s.audio.receive, set: (v) => UI.api.setAudio({ send: v, receive: v }) },
  badge: (s) => (s.audio.receiving || s.audio.sending ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const set = (partial) => api.setAudio(partial);
    const volume = UI.slider({ min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%' }, (v) => set({ volume: v }));
    const mute = UI.switch((v) => set({ muteLocal: v }), { label: I18n.t('Mute {me} while sending') });
    const recvState = UI.row('', '', [], { literal: true });
    const sendState = UI.row('', '', [], { literal: true });
    const pair = UI.dirCards(
      { on: { get: (s) => s.audio.receive, set: (v) => set({ receive: v }) }, label: I18n.t('Play {name}’s sound on {me}'), rows: [
        UI.row(I18n.t('Volume'), '', [volume]),
        recvState,
      ] },
      { on: { get: (s) => s.audio.send, set: (v) => set({ send: v }) }, label: I18n.t('Play {me}’s sound on {name}'), rows: [
        sendState,
      ] },
    );
    const phoneCard = UI.phoneAudioCard(); // a phone: its sound here over Bluetooth, its media controls
    const micCard = UI.micCard ? UI.micCard() : null; // Microphone, each way (shared/ui-mic.js)
    body.append(
      pair.el,
      ...(micCard ? [micCard.el] : []),
      phoneCard.el,
    );
    return (s) => {
      phoneCard.update(s);
      if (micCard) { micCard.update(s); }
      const a = s.audio;
      const connected = s.link.state === 'connected';
      pair.update(s);
      volume.set(a.volume);
      mute.set(a.muteLocal); // not on Linux: the loopback hears what the speakers play
      recvState.hidden = !a.receive;
      const nm = UI.peer(s).name;
      const phone = UI.phoneSound && UI.phoneSound(s);
      recvState.label.textContent = phone != null ? phone : a.receiving ? I18n.t('Playing {device}', { device: nm }) : connected ? I18n.t('Turned off on {device}', { device: nm }) : I18n.t('Waiting for {device}', { device: nm });
      sendState.hidden = !a.send && !a.error;
      sendState.label.textContent = a.sending ? I18n.t('Playing on {device}', { device: nm }) : !connected ? I18n.t('Waiting for {device}', { device: nm }) : !a.macAccepts ? I18n.t('Turned off on {device}', { device: nm }) : I18n.t('Connecting…');
      sendState.setHint(I18n.t(a.error || ''));
    };
  },
});
