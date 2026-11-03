// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/screencodec.js (docs/perf-plan.md P5): the codec order, the hidden setting, the one switch.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../screencodec.js');

const v = (mimeType, sdpFmtpLine = '') => ({ mimeType, sdpFmtpLine });
const caps = [
  v('video/VP8'), v('video/H264', 'profile-level-id=42e01f'), v('video/AV1'),
  v('video/H264', 'profile-level-id=640c1f'), v('video/H265'), v('video/H264', 'profile-level-id=4d001f'), v('video/rtx'),
];
assert.deepStrictEqual(C.order(caps).map((c) => `${c.mimeType} ${c.sdpFmtpLine}`.trim()), [
  'video/H265', 'video/H264 profile-level-id=640c1f', 'video/H264 profile-level-id=4d001f', 'video/H264 profile-level-id=42e01f',
  'video/VP8', 'video/AV1', 'video/rtx',
], 'H.265, H.264 High, Main, Baseline, then the rest in their order');
// Without H.265 (the features off, or an older app): exactly the order the senders had before.
const noHevc = caps.filter((c) => !/H265/.test(c.mimeType));
assert.strictEqual(C.order(noHevc)[0].sdpFmtpLine, 'profile-level-id=640c1f');

assert.ok(C.RTPMAP.test('a=rtpmap:96 H265/90000') && C.RTPMAP.test('a=rtpmap:102 H264/90000') && !C.RTPMAP.test('a=rtpmap:111 opus/48000/2'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-codec-'));
delete process.env.TWINDESK_SCREEN_CODEC;
assert.strictEqual(C.pref(dir), 'h264', 'default: H.264 until P5 is measured');
fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify({ screenCodec: 'auto' }));
assert.strictEqual(C.pref(dir), 'auto', 'perf.json');
process.env.TWINDESK_SCREEN_CODEC = 'h264';
assert.strictEqual(C.pref(dir), 'h264', 'the env wins');
delete process.env.TWINDESK_SCREEN_CODEC;
fs.writeFileSync(path.join(dir, 'perf.json'), '{"screenCodec":"vp9"}');
assert.strictEqual(C.pref(dir), 'h264', 'an unknown value: the default');
fs.rmSync(dir, { recursive: true });

assert.strictEqual(C.enableFeatures('h264'), '', 'h264: no switch at all');
assert.strictEqual(C.enableFeatures('auto'), 'WebRtcAllowH265Send,WebRtcAllowH265Receive');
assert.strictEqual(C.enableFeatures('auto', ['WebRTCPipeWireCapturer']), 'WebRTCPipeWireCapturer,WebRtcAllowH265Send,WebRtcAllowH265Receive', 'merged into one switch');
assert.strictEqual(C.enableFeatures('h264', ['WebRTCPipeWireCapturer']), 'WebRTCPipeWireCapturer');

// Each app has one enable-features switch (Chromium keeps only the last), and every sender and viewer
// loads the module before its renderer.
const ROOT = path.join(__dirname, '..', '..');
for (const f of ['mac/main.js', 'windows/main.js', 'linux/main.js']) {
  const n = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/appendSwitch\('enable-features'/g) || []).length;
  assert.strictEqual(n, 1, `${f}: one enable-features switch`);
}
for (const f of ['mac/capture.html', 'mac/appsend.html', 'mac/pcview.html', 'windows/sender.html', 'windows/appview.html', 'linux/sender.html', 'linux/appview.html']) {
  assert.ok(/<script src="\.\.\/shared\/screencodec\.js"><\/script>/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} loads screencodec.js`);
}
console.log('screencodec: passed');
