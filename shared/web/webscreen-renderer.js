// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A web device's own screen on this computer (shared/web/webrecv.js, kind 'scr'): the page offers
// its shared screen (and the sound with it, when the browser gives it), we answer and show it.
'use strict';

const api = window.webrecv;
const video = document.getElementById('v');
let cur = null;

function stop() {
  if (!cur) return;
  const c = cur;
  cur = null;
  try { c.pc.close(); } catch (_) {}
  video.srcObject = null;
  api.send({ t: 'state', kind: 'scr', dev: c.dev, status: 'off' });
}

async function offer(m) {
  stop();
  const pc = new RTCPeerConnection({ iceServers: [] });
  const c = { pc, dev: m.dev, remoteSet: false, pending: [], stream: new MediaStream() };
  cur = c;
  pc.onicecandidate = (e) => e.candidate && cur === c && api.send({ t: 'scr.ice', dev: m.dev, candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if (cur !== c) return;
    const st = pc.connectionState;
    api.send({ t: 'state', kind: 'scr', dev: m.dev, status: st === 'connected' ? 'live' : st });
    if (st === 'failed' || st === 'closed') stop();
  };
  pc.ontrack = (e) => {
    if (cur !== c) return;
    c.stream.addTrack(e.track);
    video.srcObject = c.stream;
    video.play().catch(() => {});
  };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    c.remoteSet = true;
    for (const x of c.pending.splice(0)) await pc.addIceCandidate(x);
    await pc.setLocalDescription(await pc.createAnswer());
    api.send({ t: 'scr.answer', dev: m.dev, sdp: pc.localDescription.sdp });
  } catch (e) {
    api.send({ t: 'state', kind: 'scr', dev: m.dev, status: `error: ${e.message}` });
    stop();
  }
}

api.on((m) => {
  if (m.t === 'scr.offer') return offer(m);
  if (m.t === 'scr.stop') return stop();
  if (m.t === 'scr.opts') { video.muted = m.sound === false; return; }
  if (m.t === 'scr.ice' && m.candidate && cur) {
    if (cur.remoteSet) cur.pc.addIceCandidate(m.candidate).catch(() => {});
    else cur.pending.push(m.candidate);
  }
});
document.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}));
