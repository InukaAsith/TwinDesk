// TwinDesk Screen Viewer (WebRTC stream display + desktop top bar)
// Apple Pencil / Touch tracking + Screen WakeLock
'use strict';

(() => {
  const q = new URLSearchParams(location.search);
  const token = q.get('token') || '';

  const backBtn = document.getElementById('btn-bar-back');
  if (backBtn && token) {
    backBtn.href = `index.html?token=${encodeURIComponent(token)}`;
  }

  const video = document.getElementById('screen-video');
  const overlay = document.getElementById('overlay');
  const bar = document.getElementById('bar');
  const barStatus = document.getElementById('bar-status');
  const btnMirror = document.getElementById('btn-bar-mirror');
  const btnExtend = document.getElementById('btn-bar-extend');
  const btnFg = document.getElementById('btn-bar-fg');
  const btnFull = document.getElementById('btn-bar-full');

  // Prevent iPad/phone screen from dimming/sleeping
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').catch(() => {});
      }
    });
  }

  // Auto-hide floating top bar
  let barTimer = null;
  function showBar() {
    if (!bar) return;
    bar.classList.remove('hidden');
    clearTimeout(barTimer);
    barTimer = setTimeout(() => {
      bar.classList.add('hidden');
    }, 3200);
  }

  document.addEventListener('mousemove', (e) => {
    if (e.clientY < 64) showBar();
  });
  document.addEventListener('pointerdown', showBar);
  showBar();

  // Fullscreen button
  if (btnFull) {
    btnFull.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
        btnFull.classList.add('on');
      } else {
        document.exitFullscreen().catch(() => {});
        btnFull.classList.remove('on');
      }
    });
  }

  // Display mode (Mirror / Extend)
  if (btnMirror && btnExtend) {
    btnMirror.addEventListener('click', () => {
      btnMirror.classList.add('on');
      btnExtend.classList.remove('on');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'screen-mode', mode: 'mirror' }));
      }
    });
    btnExtend.addEventListener('click', () => {
      btnExtend.classList.add('on');
      btnMirror.classList.remove('on');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'screen-mode', mode: 'extend' }));
      }
    });
  }

  // Frame generation toggle
  let fgActive = false;
  if (btnFg) {
    btnFg.addEventListener('click', () => {
      fgActive = !fgActive;
      btnFg.classList.toggle('on', fgActive);
    });
  }

  // WebSocket signaling
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  let pc = null;

  function initWebRTC() {
    pc = new RTCPeerConnection({ iceServers: [] });

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        video.srcObject = event.streams[0];
        if (overlay) overlay.style.display = 'none';
        if (barStatus) barStatus.textContent = '60 FPS · Live';
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'rtc-ice', candidate: e.candidate }));
      }
    };

    // Ask host for screen stream
    ws.send(JSON.stringify({ t: 'rtc-request', kind: 'screen' }));
  }

  ws.onopen = () => {
    if (barStatus) barStatus.textContent = 'Signaling…';
    initWebRTC();
  };

  ws.onmessage = async (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'rtc-offer' && m.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: m.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ t: 'rtc-answer', sdp: answer.sdp }));
      } else if (m.t === 'rtc-ice' && m.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(m.candidate));
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    if (barStatus) {
      barStatus.textContent = 'Disconnected';
      barStatus.style.color = '#ff453a';
    }
    if (overlay) {
      overlay.style.display = 'block';
      overlay.textContent = 'Disconnected from screen stream';
    }
  };

  // Apple Pencil & Touch Input Tracking
  function handlePointer(type, e) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (type !== 'up') return;
    }

    const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    ws.send(JSON.stringify({
      t: 'pointer',
      action: type,
      x: normX,
      y: normY,
      pointerType: e.pointerType || 'touch',
      pressure: e.pressure || 0,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      buttons: e.buttons,
    }));
  }

  video.addEventListener('pointerdown', (e) => handlePointer('down', e));
  video.addEventListener('pointermove', (e) => handlePointer('move', e));
  video.addEventListener('pointerup', (e) => handlePointer('up', e));
  video.addEventListener('pointercancel', (e) => handlePointer('up', e));
})();
