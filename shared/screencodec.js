// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screen share codec: which encoder this computer sends its screen with.
// The setting (Share screen › Picture › Encoder, sharing.codec / pcScreen.codec):
//   'h264' (default): H.264 only, High before Main before Baseline (better quality per bit).
//   'h265': H.265 only, for testing it; the other computer must decode it too, else nothing shows.
//           Without an H.265 encoder here it's H.264. (A saved 'auto', from before, is 'h264'.)
// Chromium's WebRTC lists H.265 only with WebRtcAllowH265Send / WebRtcAllowH265Receive, so every app
// switches them on at start (one enable-features switch, merged with its others): the setting then
// works on the next share, without a restart. With an older app the SDP negotiation picks H.264 by
// itself. Env TWINDESK_SCREEN_CODEC overrides the setting; TWINDESK_NO_H265=1 leaves the features off.
// A plain <script> in the pages too: everything in its own scope, so nothing collides with the
// page's own top-level names (`api`, `RTPMAP`…).
(function () {
'use strict';

const H265_FEATURES = ['WebRtcAllowH265Send', 'WebRtcAllowH265Receive'];
const MODES = ['h264', 'h265'];
const DEFAULT = 'h264';

const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);

// The mode to send with: the env, else the setting, else the default.
function mode(setting) {
  const e = env('TWINDESK_SCREEN_CODEC');
  if (MODES.includes(e)) return e;
  return MODES.includes(setting) ? setting : DEFAULT;
}

// The app's single enable-features switch: `others` plus H.265 (unless TWINDESK_NO_H265).
function features(others = []) {
  return [...others, ...(env('TWINDESK_NO_H265') ? [] : H265_FEATURES)].join(',');
}

const isH265 = (c) => /h265|hevc/i.test(String((c && c.mimeType) || ''));
const isVideo = (c) => /^video\/(h264|h265|hevc|vp8|vp9|av1)$/i.test(String((c && c.mimeType) || ''));

// Lower is better: H.265, H.264 High, Main, Baseline, other H.264, then the rest in their order.
function rank(c) {
  const mime = String((c && c.mimeType) || '');
  if (isH265(c)) return 0;
  if (!/h264/i.test(mime)) return 9;
  const p = /profile-level-id=(..)/i.exec((c && c.sdpFmtpLine) || '');
  return { 64: 1, '4d': 2, '42': 3 }[p ? p[1].toLowerCase() : ''] ?? 4;
}

// The codecs (from getCapabilities), best first; a stable sort, so ties keep Chromium's order.
// m: the sender's mode (above); none (a viewer): every codec, H.265 first, so the sender decides.
// rtx / red / ulpfec / flexfec always stay.
function order(codecs, m) {
  let list = (codecs || []).slice();
  if (m === 'h264') list = list.filter((c) => !isH265(c));
  else if (m === 'h265' && list.some(isH265)) list = list.filter((c) => isH265(c) || !isVideo(c));
  return list.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

// The video payload types whose fmtp lines get the bitrate hints (withBitrate in the senders).
const RTPMAP = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//i;

// The video codec an SDP (the answer) settled on: the first payload type of its m=video line, by name.
function negotiated(sdp) {
  const m = /^m=video \S+ \S+ (\d+)/m.exec(String(sdp || ''));
  if (!m) return '';
  const r = new RegExp(`^a=rtpmap:${m[1]} ([^/\\s]+)`, 'm').exec(sdp);
  return r ? r[1] : '';
}

// Playback › Steady: an SDP without the playout-delay header extension. Every app sends each frame
// with "show it now" (playout delay 0/0, the main.js field trial), which shows frames the moment they
// are decoded; without the extension in the answer it never goes out, and the viewer paces the
// frames itself (WebRTC's jitter buffer, as a web browser plays it). The sender leaves it out of its
// offer, the viewer out of its answer: either side alone is enough.
const NO_DELAY = /^a=extmap:[^\r\n]*\/playout-delay\r?\n/gm;
function steady(sdp) { return String(sdp || '').replace(NO_DELAY, ''); }

// Frames per second to send: the display's refresh rate (30–120), at most `cap` (Share screen › Frame
// rate: 30 or 60; 0 = the display's).
const FPS_CAPS = [0, 30, 60];
function fps(hz, cap) {
  const rate = Math.min(120, Math.max(30, Math.round(Number(hz) || 60)));
  return FPS_CAPS.includes(cap) && cap ? Math.min(cap, rate) : rate;
}

const api = { mode, features, negotiated, rank, order, steady, fps, FPS_CAPS, RTPMAP, H265_FEATURES, MODES, DEFAULT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.TwinDeskScreenCodec = api;
})();
