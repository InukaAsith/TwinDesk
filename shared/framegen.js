// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Frame generation for screen viewers (optional, both apps). When the screen refreshes
// faster than the stream delivers frames (a 60 fps stream on a 120 Hz screen, or a stream that
// dropped to 30 fps), it draws motion-compensated in-between frames on the GPU (WebGL2):
//   1. both frames -> quarter-size luma;
//   2. block matching: one motion vector per 8×8 quarter-px block (32×32 screen px), coarse search
//      ±64 px in 8 px steps, then a ±4 px refine; a vector only wins when it beats "no motion";
//   3. each screen pixel samples the older frame back and the newer frame forward along the
//      (bilinear) vector field and blends by time; where the two disagree (things appearing or
//      disappearing) it takes the frame nearer in time instead of a ghost.
// It shows the picture one screen refresh late (≈ 8 ms at 120 Hz), the price of having the next
// frame to aim at. With frames as fast as the screen (60 fps on 60 Hz) it adds no delay and only
// steps in when a frame is late or lost: it moves the last frame on along its motion (no ghosting
// where it isn't sure), so a drop doesn't show as a stutter.
// It runs on any GPU through WebGL2 (Apple, NVIDIA, AMD, Intel); it is not a driver feature.
//
// Use: const fg = new FrameGen(video, canvas); fg.start(); … fg.stop(); fg.active -> drawing now.
// The <canvas> sits over the <video> with the same CSS box and `object-fit: contain`.
'use strict';

(function (root) {
  const Q = 4; // luma downscale
  const B = 8; // block size in quarter px

  const VS = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  const LUMA = `#version 300 es
  precision highp float; in vec2 uv; out vec4 o; uniform sampler2D src; uniform vec2 texel;
  float l(vec2 q) { return dot(texture(src, q).rgb, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec2 d = texel * 1.0;
    o = vec4((l(uv + vec2(-d.x, -d.y)) + l(uv + vec2(d.x, -d.y)) + l(uv + vec2(-d.x, d.y)) + l(uv + d)) * 0.25);
  }`;

  // One output pixel per block. v in quarter px; stored as (v / R) * 0.5 + 0.5, confidence in b.
  const MOTION = `#version 300 es
  precision highp float; out vec4 o;
  uniform sampler2D a; uniform sampler2D b; uniform vec2 size; // luma size (quarter px)
  const float R = 16.0;
  float sad(vec2 base, vec2 v) {
    float s = 0.0;
    for (int y = 0; y < 8; y += 2) for (int x = 0; x < 8; x += 2) {
      vec2 q = base + vec2(float(x), float(y)) + 0.5;
      s += abs(texture(a, q / size).r - texture(b, (q + v) / size).r);
    }
    return s;
  }
  void main() {
    vec2 base = floor(gl_FragCoord.xy) * 8.0;
    float zero = sad(base, vec2(0.0));
    vec2 best = vec2(0.0); float bs = zero;
    for (float y = -R; y <= R; y += 2.0) for (float x = -R; x <= R; x += 2.0) {
      float s = sad(base, vec2(x, y)) + 0.002 * (abs(x) + abs(y));
      if (s < bs) { bs = s; best = vec2(x, y); }
    }
    vec2 c = best;
    for (float y = -1.0; y <= 1.0; y += 1.0) for (float x = -1.0; x <= 1.0; x += 1.0) {
      float s = sad(base, c + vec2(x, y)) + 0.002 * (abs(c.x + x) + abs(c.y + y));
      if (s < bs) { bs = s; best = c + vec2(x, y); }
    }
    if (bs > zero * 0.8) best = vec2(0.0); // not clearly better than standing still
    float conf = clamp(1.0 - bs / 3.0, 0.0, 1.0);
    o = vec4(best / R * 0.5 + 0.5, conf, 1.0);
  }`;

  const INTERP = `#version 300 es
  precision highp float; in vec2 uv; out vec4 o;
  uniform sampler2D prev; uniform sampler2D cur; uniform sampler2D mv; uniform vec2 size; uniform float t;
  const float R = 16.0;
  void main() {
    vec4 m = texture(mv, uv);
    vec2 v = (m.rg - 0.5) * 2.0 * R * 4.0 / size; // full-res uv per frame
    vec4 a = texture(prev, uv - v * t);
    vec4 b = texture(cur, uv + v * (1.0 - t));
    vec4 near = t < 0.5 ? a : b;
    float diff = dot(abs(a.rgb - b.rgb), vec3(0.333));
    float w = max(smoothstep(0.08, 0.2, diff), 1.0 - m.b); // unsure here: no blend, no ghost
    o = mix(mix(a, b, t), near, w);
    o.a = 1.0;
  }`;

  // A late frame: the newest one moved on by k frames of its motion (k ≤ 1).
  const EXTRAP = `#version 300 es
  precision highp float; in vec2 uv; out vec4 o;
  uniform sampler2D cur; uniform sampler2D mv; uniform vec2 size; uniform float k;
  const float R = 16.0;
  void main() {
    vec4 m = texture(mv, uv);
    vec2 v = (m.rg - 0.5) * 2.0 * R * 4.0 / size;
    o = vec4(texture(cur, uv - v * k * step(0.5, m.b)).rgb, 1.0);
  }`;

  const COPY = `#version 300 es
  precision highp float; in vec2 uv; out vec4 o; uniform sampler2D cur;
  void main() { o = vec4(texture(cur, uv).rgb, 1.0); }`;

  class FrameGen {
    constructor(video, canvas) {
      this.video = video;
      this.canvas = canvas;
      this.on = false;
      this.active = false;
      this.gl = null;
    }

    _init() {
      const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      const prog = (fs) => {
        const sh = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'p');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      this.p = { luma: prog(LUMA), motion: prog(MOTION), interp: prog(INTERP), extrap: prog(EXTRAP), copy: prog(COPY) };
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.frames = [this._tex(), this._tex()]; // [older, newer] video frames
      this.luma = [this._target(), this._target()];
      this.mv = this._target();
      this.w = 0;
      this.h = 0;
    }

    _tex() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    }

    _target() {
      const tex = this._tex();
      return { tex, fb: this.gl.createFramebuffer(), w: 0, h: 0 };
    }

    _size(t, w, h) {
      const gl = this.gl;
      if (t.w === w && t.h === h) return;
      Object.assign(t, { w, h });
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    }

    _bind(prog, unit, name, tex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    }

    _draw(prog, target, w, h) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    start() {
      if (this.on) return;
      if (!this.gl) this._init();
      this.on = true;
      const token = this.token = {};
      this.count = 0;
      this.frameMs = 16.7; // stream frame interval (EMA)
      this.vsyncMs = 16.7; // screen refresh interval (EMA)
      this.times = [0, 0];
      this.lastRaf = 0;
      this.drawn = -1;
      const onFrame = (now, meta) => {
        if (!this.on || this.token !== token) return;
        this._upload(meta.expectedDisplayTime || now);
        this.vfc = this.video.requestVideoFrameCallback(onFrame);
      };
      this.vfc = this.video.requestVideoFrameCallback(onFrame);
      const loop = (t) => {
        if (!this.on || this.token !== token) return;
        if (this.lastRaf) this.vsyncMs += (Math.min(50, t - this.lastRaf) - this.vsyncMs) * 0.05;
        this.lastRaf = t;
        this._present(t);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      this.on = false;
      this.token = null;
      this.active = false;
      cancelAnimationFrame(this.raf);
      if (this.vfc != null && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.vfc);
      this.vfc = null;
    }

    // A new decoded frame: it becomes "newer", the old newer becomes "older", and the motion
    // field between them is computed once here (not per screen refresh).
    _upload(at) {
      const gl = this.gl, v = this.video;
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) return;
      if (w !== this.w || h !== this.h) {
        this.w = w;
        this.h = h;
        this.canvas.width = w;
        this.canvas.height = h;
        this.count = 0;
      }
      this.frames.reverse();
      this.luma.reverse();
      this.times = [this.times[1], at];
      const t = this.frames[1];
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // GL's origin is bottom-left
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
      const lw = Math.ceil(w / Q), lh = Math.ceil(h / Q);
      this._size(this.luma[1], lw, lh);
      gl.useProgram(this.p.luma);
      this._bind(this.p.luma, 0, 'src', t);
      gl.uniform2f(gl.getUniformLocation(this.p.luma, 'texel'), 1 / w, 1 / h);
      this._draw(this.p.luma, this.luma[1], lw, lh);
      this.count++;
      if (this.count >= 2) {
        const dt = this.times[1] - this.times[0];
        if (dt > 0 && dt < 200) this.frameMs += (dt - this.frameMs) * 0.1;
        const bw = Math.ceil(lw / B), bh = Math.ceil(lh / B);
        this._size(this.mv, bw, bh);
        gl.useProgram(this.p.motion);
        this._bind(this.p.motion, 0, 'a', this.luma[0].tex);
        this._bind(this.p.motion, 1, 'b', this.luma[1].tex);
        gl.uniform2f(gl.getUniformLocation(this.p.motion, 'size'), lw, lh);
        this._draw(this.p.motion, this.mv, bw, bh);
      }
    }

    // Per screen refresh: show the picture as it was one refresh ago, between the two frames.
    _present(now) {
      const gl = this.gl;
      if (this.count < 1) return;
      const gen = this.count >= 2 && this.frameMs > this.vsyncMs * 1.4; // frames slower than the screen
      this.active = true;
      let t = 1;
      if (gen) {
        const [t0, t1] = this.times;
        t = Math.max(0, Math.min(1, (now - this.vsyncMs - t0) / Math.max(1, t1 - t0)));
      }
      // Frames as fast as the screen, but this one is late: carry the newest one forward.
      const late = !gen && this.count >= 2 ? (now - this.times[1]) / this.frameMs : 0;
      const k = late > 1.5 ? Math.min(1, late - 1) : 0;
      const key = this.count * 1000 + Math.round(t * 100) + k * 0.5;
      if (key === this.drawn) return; // nothing new to draw
      this.drawn = key;
      if (k > 0) {
        const p = this.p.extrap;
        gl.useProgram(p);
        this._bind(p, 0, 'cur', this.frames[1]);
        this._bind(p, 1, 'mv', this.mv.tex);
        gl.uniform2f(gl.getUniformLocation(p, 'size'), this.w, this.h);
        gl.uniform1f(gl.getUniformLocation(p, 'k'), k);
        this._draw(p, null, this.w, this.h);
        return;
      }
      if (gen && t > 0.02 && t < 0.98) {
        const p = this.p.interp;
        gl.useProgram(p);
        this._bind(p, 0, 'prev', this.frames[0]);
        this._bind(p, 1, 'cur', this.frames[1]);
        this._bind(p, 2, 'mv', this.mv.tex);
        gl.uniform2f(gl.getUniformLocation(p, 'size'), this.w, this.h);
        gl.uniform1f(gl.getUniformLocation(p, 't'), t);
        this._draw(p, null, this.w, this.h);
      } else {
        gl.useProgram(this.p.copy);
        this._bind(this.p.copy, 0, 'cur', this.frames[t <= 0.02 && gen ? 0 : 1]);
        this._draw(this.p.copy, null, this.w, this.h);
      }
    }
  }

  root.FrameGen = FrameGen;
  if (typeof module !== 'undefined' && module.exports) module.exports = { FrameGen };
})(typeof self !== 'undefined' ? self : this);
