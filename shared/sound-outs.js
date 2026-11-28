// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// In a hidden sound window (windows/linux sound-renderer.js, mac/audio-rtc.js): another computer's
// sound on several of this computer's speakers at once, each at its own volume (the route,
// shared/sound-route.js). One Web Audio context per speaker (AudioContext sinkId), fed from the one
// received track; a muted <audio> element keeps Chromium's WebRTC playout running for it.
//
// Also: the speakers this computer has (listed while the sound plays and when they change), the delay
// heard (network + jitter buffer, read every 2 s while it plays), and Keep speakers in sync: the
// receiver's jitter buffer held so network + buffer = the sender's delay, the same on every computer.
//
// window.SoundOuts.create(onInfo) → {play(stream, receiver, pc), stop(), route({outs, sync, volume}),
//   volume(v), info()}; onInfo({outs, lat}) when the list or the delay changes.
'use strict';

(function () {
  const HIDE = /TwinDesk-(Capture|Sound)|twindesk_(cap|sound)/i; // Linux: our own sink and source (loopback.js)

  function create(onInfo) {
    let stream = null;
    let receiver = null;
    let pc = null;
    let outs = null; // the route [{id, vol}] or null
    let master = 1; // the Volume, when there is no route
    let sync = 0;
    let list = []; // [{id, name, def}]
    let defId = '';
    let lat = 0;
    let oneWay = 0;
    let timer = null;
    let keep = null; // the muted element
    const ctxs = new Map(); // speaker id → {ctx, gain, src}

    async function relist() {
      try {
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications' && !HIDE.test(d.label));
        const def = all.find((d) => d.deviceId === 'default');
        const defName = def ? def.label.replace(/^Default\s*[-–]\s*/i, '') : '';
        const real = all.filter((d) => d.deviceId !== 'default');
        const match = real.find((d) => d.label === defName);
        defId = match ? match.deviceId : '';
        list = real.map((d) => ({ id: d.deviceId, name: d.label || 'Speaker', ...(d.deviceId === defId ? { def: true } : {}) }));
        if (!list.length) list = [{ id: '', name: defName || 'Speakers', def: true }];
      } catch (_) { /* keep the last */ }
    }

    // Where it plays: the route's speakers that are here, else the default one at the Volume.
    function targets() {
      const have = new Set(list.map((d) => d.id));
      if (outs) return outs.filter((o) => have.has(o.id));
      return [{ id: defId, vol: master }];
    }

    function apply() {
      const want = stream ? targets() : [];
      const ids = new Set(want.map((t) => t.id));
      for (const [id, c] of ctxs) {
        if (ids.has(id)) continue;
        c.ctx.close().catch(() => {});
        ctxs.delete(id);
      }
      for (const t of want) {
        let c = ctxs.get(t.id);
        if (!c) {
          try {
            const opts = { latencyHint: 'interactive' };
            if (t.id) opts.sinkId = t.id;
            const ctx = new AudioContext(opts);
            const src = ctx.createMediaStreamSource(stream);
            const gain = ctx.createGain();
            src.connect(gain).connect(ctx.destination);
            ctx.resume().catch(() => {});
            c = { ctx, gain, src };
            ctxs.set(t.id, c);
          } catch (e) {
            console.error('sound output', t.id, e && e.message);
            continue;
          }
        }
        c.gain.gain.value = Math.max(0, Math.min(1, Number(t.vol) || 0));
      }
    }

    // Keep speakers in sync: network + buffer = sync. Off: the buffer as small as it can be.
    function hold() {
      if (!receiver) return;
      const ms = sync ? Math.max(0, Math.min(4000, sync - oneWay)) : 0;
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
      else receiver.playoutDelayHint = ms / 1000;
    }

    async function measure() {
      if (!receiver || !pc) return;
      try {
        let jb = 0, rtt = 0;
        (await receiver.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp' && r.jitterBufferEmittedCount > 0) jb = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
        });
        (await pc.getStats()).forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
        });
        oneWay = rtt / 2;
        const next = Math.round(oneWay + jb);
        if (sync) hold();
        if (Math.abs(next - lat) >= 3) { lat = next; onInfo(info()); }
      } catch (_) { /* closed meanwhile */ }
    }

    function info() {
      return { outs: list, lat: stream ? lat : 0 };
    }

    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await relist();
      apply();
      onInfo(info());
    });

    return {
      async play(s, rcv, p) {
        this.stop(true);
        stream = s;
        receiver = rcv || null;
        pc = p || null;
        keep = new Audio();
        keep.muted = true;
        keep.srcObject = s;
        keep.play().catch(() => {});
        hold();
        await relist();
        if (stream !== s) return;
        apply();
        timer = setInterval(measure, 2000);
        onInfo(info());
      },
      stop(quiet) {
        clearInterval(timer);
        timer = null;
        for (const c of ctxs.values()) c.ctx.close().catch(() => {});
        ctxs.clear();
        if (keep) keep.srcObject = null;
        keep = null;
        stream = receiver = pc = null;
        lat = oneWay = 0;
        if (!quiet) onInfo(info());
      },
      route(m) {
        outs = Array.isArray(m.outs) ? m.outs : null;
        if (typeof m.volume === 'number') master = m.volume;
        sync = Number(m.sync) || 0;
        hold();
        apply();
      },
      volume(v) {
        master = Math.max(0, Math.min(1, Number(v) || 0));
        apply();
      },
      info,
    };
  }

  window.SoundOuts = { create };
})();
