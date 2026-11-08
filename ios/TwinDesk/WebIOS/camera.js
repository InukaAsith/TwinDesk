// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's camera on the computer (shared/camshare.js there, as camera-send.js does for a
// computer): one WebRTC video track (we offer, the computer's viewer answers recvonly), 1280 × 720
// at 30 fps, up to 4 Mb/s. Shown here too (the preview). The app drives it through tdRecv:
// {t: 'start', facing: 'user'|'environment'} · {t: 'answer', sdp} · {t: 'ice', candidate} · {t: 'stop'}.
'use strict';

(() => {
  const TD = window.TD;
  const send = (m) => TD.send(JSON.stringify(m));
  const video = document.getElementById('v');
  const MBPS = 4;
  let me = null; // {pc, stream, pending}

  const status = (s, error = '') => send({ t: 'cam.state', status: s, error });

  function stop() {
    const cur = me;
    me = null;
    if (!cur) return;
    if (cur.pc) cur.pc.close();
    if (cur.stream) cur.stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  async function start(facing) {
    stop();
    const cur = (me = { pc: null, stream: null, pending: [] });
    const alive = () => me === cur;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing || 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
      if (!alive()) return stream.getTracks().forEach((t) => t.stop());
      cur.stream = stream;
      video.srcObject = stream;
      video.classList.toggle('front', facing === 'user');
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      track.onended = () => { if (alive()) { status('failed', 'the camera went away'); stop(); } };
      const pc = (cur.pc = new RTCPeerConnection({ iceServers: [] }));
      const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      pc.onicecandidate = (e) => e.candidate && alive() && send({ t: 'cam.ice', from: 'send', candidate: e.candidate.toJSON() });
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        if (pc.connectionState === 'connected') status('live');
        else if (pc.connectionState === 'failed') status('failed', 'no network path to the computer');
      };
      const offer = await pc.createOffer();
      if (!alive()) return;
      await pc.setLocalDescription(offer);
      if (!alive()) return;
      send({ t: 'cam.offer', sdp: pc.localDescription.sdp });
      const p = tr.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], { maxBitrate: MBPS * 1e6, maxFramerate: 30 });
      await tr.sender.setParameters(p).catch(() => {});
    } catch (e) {
      if (!alive()) return;
      status('failed', e.name === 'NotAllowedError' ? 'the camera isn’t allowed for TwinDesk on this iPhone' : e.message);
      stop();
    }
  }

  async function answer(sdp) {
    const cur = me;
    if (!cur || !cur.pc) return;
    try {
      await cur.pc.setRemoteDescription({ type: 'answer', sdp });
      const q = cur.pending;
      cur.pending = null;
      for (const c of q || []) await cur.pc.addIceCandidate(c).catch(() => {});
    } catch (e) {
      if (me === cur) status('failed', e.message);
    }
  }

  window.tdRecv = (m) => {
    switch (m.t) {
      case 'start': start(m.facing); break;
      case 'answer': answer(m.sdp); break;
      case 'ice':
        if (!me || !me.pc || !m.candidate) break;
        if (me.pending) me.pending.push(m.candidate);
        else me.pc.addIceCandidate(m.candidate).catch(() => {});
        break;
      case 'stop': stop(); break;
      default: break;
    }
  };
  TD.ready();
})();
