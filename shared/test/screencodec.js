// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/screencodec.js: the codec order, the Encoder setting, the one switch.
'use strict';

const assert = require('assert');
const fs = require('fs');
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

// The Encoder setting, on the sender: h264 drops H.265; h265 keeps only H.265 (and rtx/red/fec) when
// there is one, else it's H.264.
const names = (l) => l.map((c) => c.mimeType);
assert.ok(!names(C.order(caps, 'h264')).includes('video/H265'), 'h264: no H.265 in the offer');
assert.strictEqual(C.order(caps, 'h264')[0].sdpFmtpLine, 'profile-level-id=640c1f');
assert.deepStrictEqual(names(C.order(caps, 'h265')), ['video/H265', 'video/rtx'], 'h265: H.265 only');
assert.strictEqual(C.order(noHevc, 'h265')[0].sdpFmtpLine, 'profile-level-id=640c1f', 'h265 without an H.265 encoder: H.264');

delete process.env.TWINDESK_SCREEN_CODEC;
assert.strictEqual(C.mode(undefined), 'h264', 'default: H.264 until P5 is measured');
assert.strictEqual(C.mode('auto'), 'h264', 'Automatic is gone: a saved one is H.264');
assert.strictEqual(C.mode('h265'), 'h265');
assert.strictEqual(C.mode('vp9'), 'h264', 'an unknown value: the default');
process.env.TWINDESK_SCREEN_CODEC = 'h265';
assert.strictEqual(C.mode('h264'), 'h265', 'the env wins');
process.env.TWINDESK_SCREEN_CODEC = 'auto';
assert.strictEqual(C.mode('h265'), 'h265', 'an env auto is ignored');
delete process.env.TWINDESK_SCREEN_CODEC;

delete process.env.TWINDESK_NO_H265;
assert.strictEqual(C.features(), 'WebRtcAllowH265Send,WebRtcAllowH265Receive', 'always on: the setting works without a restart');
assert.strictEqual(C.features(['WebRTCPipeWireCapturer']), 'WebRTCPipeWireCapturer,WebRtcAllowH265Send,WebRtcAllowH265Receive', 'merged into one switch');
process.env.TWINDESK_NO_H265 = '1';
assert.strictEqual(C.features(), '', 'the kill switch');
assert.strictEqual(C.features(['WebRTCPipeWireCapturer']), 'WebRTCPipeWireCapturer');
delete process.env.TWINDESK_NO_H265;

const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 49 102 97\r\na=rtpmap:49 H265/90000\r\na=rtpmap:102 H264/90000\r\n';
assert.strictEqual(C.negotiated(answer), 'H265', 'the first video payload type of the answer');
assert.strictEqual(C.negotiated('v=0\r\n'), '');

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
// As the pages load it: a plain script in one global scope with the renderer after it. Its names must
// not collide with the renderer's top-level ones (a SyntaxError there stops the share).
const vm = require('vm');
const codecSrc = fs.readFileSync(path.join(ROOT, 'shared', 'screencodec.js'), 'utf8');
for (const f of ['mac/capture.js', 'mac/appsend-renderer.js', 'mac/pcview-renderer.js', 'windows/sender-renderer.js', 'windows/appview-renderer.js', 'linux/sender-renderer.js', 'linux/appview-renderer.js']) {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(codecSrc, ctx);
  assert.strictEqual(typeof ctx.TwinDeskScreenCodec.order, 'function');
  // The renderer's top-level declarations only: compile it in the same global scope (no run).
  const decls = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^(?:const|let|class) [A-Za-z_$][\w$]*/gm) || [])
    .map((d) => `${d.replace(/^class /, 'let ')} = 0;`).join('\n');
  assert.doesNotThrow(() => vm.runInContext(decls, ctx), `${f}: no top-level name clashes with screencodec.js`);
}
console.log('screencodec: passed');
