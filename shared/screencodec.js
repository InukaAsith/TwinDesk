// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screen share codec (docs/perf-plan.md P5). HEVC (H.265) when both computers have it in hardware,
// else H.264 as always: High before Main before Baseline (better quality per bit), the rest after.
//
// Chromium's WebRTC lists H.265 only with the WebRtcAllowH265Send / WebRtcAllowH265Receive features,
// so the hidden setting decides at start whether they're switched on, and the renderers simply put
// H.265 first whenever it is listed. With an older app the SDP negotiation picks H.264 by itself.
//
// The hidden setting: `screenCodec` in perf.json in the app's data folder ('auto' | 'h264'), or env
// TWINDESK_SCREEN_CODEC. Default: h264, until the glass-to-glass numbers of P5 say HEVC is no slower
// and sharper at the same Mbps.
'use strict';

const H265_FEATURES = ['WebRtcAllowH265Send', 'WebRtcAllowH265Receive'];
const DEFAULT = 'h264';

// 'auto' | 'h264', from the env or perf.json in `dir` (main process only).
function pref(dir) {
  const env = typeof process !== 'undefined' && process.env ? process.env.TWINDESK_SCREEN_CODEC : '';
  if (env === 'auto' || env === 'h264') return env;
  try {
    const fs = require('fs');
    const path = require('path');
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'perf.json'), 'utf8')).screenCodec;
    if (v === 'auto' || v === 'h264') return v;
  } catch (_) { /* none: the default */ }
  return DEFAULT;
}

// The features to add to the app's single enable-features switch (merged with `others`), or the others.
function enableFeatures(p, others = []) {
  return [...others, ...(p === 'auto' ? H265_FEATURES : [])].join(',');
}

// Lower is better: H.265, H.264 High, Main, Baseline, other H.264, then the rest in their order.
function rank(c) {
  const mime = String((c && c.mimeType) || '');
  if (/h265|hevc/i.test(mime)) return 0;
  if (!/h264/i.test(mime)) return 9;
  const p = /profile-level-id=(..)/i.exec((c && c.sdpFmtpLine) || '');
  return { 64: 1, '4d': 2, '42': 3 }[p ? p[1].toLowerCase() : ''] ?? 4;
}

// The codecs (from getCapabilities), best first; a stable sort, so ties keep Chromium's order.
function order(codecs) {
  return (codecs || []).map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

// The video payload types whose fmtp lines get the bitrate hints (withBitrate in the senders).
const RTPMAP = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//i;

const api = { pref, enableFeatures, rank, order, RTPMAP, H265_FEATURES, DEFAULT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.TwinDeskScreenCodec = api;
