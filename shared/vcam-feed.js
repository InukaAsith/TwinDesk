// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What a camera's window (the other computer's: camera-view.html; a phone's: phoneview.html) sends
// on from each picture (a VideoFrame, a video or a canvas), turned as Camera › Rotate says:
//   - the Camera tab's picture: a small JPEG about 12 times a second ('vcam:preview');
//   - while Virtual camera is on, the virtual camera's frames (shared/vcam.js): fitted into
//     1280×720 with black bars and turned into NV12 on the GPU (WebGL2: one pass writes the Y rows,
//     then the interleaved U/V rows, four bytes a pixel), at most 30 a second. BT.601, limited range.
// Main says what to do ('vcam:set' {vcam, rotate, mirror}) after the window's hello.
// window.CamOut() → {push(source, width, height), onRotate(fn)}; window.camout is the preload's bridge.
'use strict';

(() => {
  const W = 1280, H = 720, FPS = 30, PREVIEW_MS = 80, PREVIEW_W = 480;

  const VS = `#version 300 es
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  // Output row r (top first, as readPixels hands it back): r < H a row of Y, four pixels to an
  // output pixel; then H/2 rows of U,V for two chroma pixels each (each one 2×2 pixels).
  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D tex;
  uniform vec4 rect; // the (turned) picture in the frame: x, y, width, height (pixels)
  uniform int rot; // quarter turns clockwise
  uniform int mir; // 1: mirrored left to right (Camera › Mirror), after the turn
  out vec4 o;
  vec4 at(vec2 p) {
    vec2 uv = (p - rect.xy) / rect.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
    if (mir == 1) uv.x = 1.0 - uv.x;
    if (rot == 1) uv = vec2(uv.y, 1.0 - uv.x);
    else if (rot == 2) uv = vec2(1.0 - uv.x, 1.0 - uv.y);
    else if (rot == 3) uv = vec2(1.0 - uv.y, uv.x);
    return vec4(texture(tex, uv).rgb, 1.0);
  }
  float Y(vec4 c) { return c.a == 0.0 ? 16.0 / 255.0 : (16.0 + 65.481 * c.r + 128.553 * c.g + 24.966 * c.b) / 255.0; }
  vec2 UV(vec4 c) {
    return c.a == 0.0 ? vec2(128.0 / 255.0)
      : vec2(128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b, 128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b) / 255.0;
  }
  void main() {
    float x = floor(gl_FragCoord.x) * 4.0;
    float r = floor(gl_FragCoord.y);
    if (r < ${H}.0) {
      o = vec4(Y(at(vec2(x + 0.5, r + 0.5))), Y(at(vec2(x + 1.5, r + 0.5))), Y(at(vec2(x + 2.5, r + 0.5))), Y(at(vec2(x + 3.5, r + 0.5))));
    } else {
      float y = (r - ${H}.0) * 2.0 + 1.0;
      o = vec4(UV(at(vec2(x + 1.0, y))), UV(at(vec2(x + 3.0, y))));
    }
  }`;

  // The virtual camera's frames; null without WebGL2.
  function nv12(send) {
    const canvas = new OffscreenCanvas(W / 4, H * 3 / 2);
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
    const rect = gl.getUniformLocation(prog, 'rect');
    const rot = gl.getUniformLocation(prog, 'rot');
    const mir = gl.getUniformLocation(prog, 'mir');
    gl.viewport(0, 0, W / 4, H * 3 / 2);
    const out = new Uint8Array(W * H * 3 / 2);
    return (source, sw, sh, deg, mirror) => {
      const q = (deg / 90) & 3;
      const [tw, th] = q & 1 ? [sh, sw] : [sw, sh]; // the turned picture's size
      const k = Math.min(W / tw, H / th);
      const cw = Math.round(tw * k), ch = Math.round(th * k);
      gl.uniform4f(rect, Math.floor((W - cw) / 2), Math.floor((H - ch) / 2), cw, ch);
      gl.uniform1i(rot, q);
      gl.uniform1i(mir, mirror ? 1 : 0);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch {
        return;
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, W / 4, H * 3 / 2, gl.RGBA, gl.UNSIGNED_BYTE, out);
      send(out.buffer);
    };
  }

  window.CamOut = () => {
    const bridge = window.camout;
    if (!bridge) return null;
    let vcam = false, rotate = 0, mirror = false;
    let toVcam = null;
    let lastFrame = 0, lastPreview = 0, previewing = false;
    const rotated = [];
    const preview = new OffscreenCanvas(PREVIEW_W, 270);
    const pctx = preview.getContext('2d', { alpha: false });

    bridge.on((m) => {
      if (!m) return;
      vcam = !!m.vcam;
      const r = [0, 90, 180, 270].includes(m.rotate) ? m.rotate : 0;
      if (r !== rotate || !!m.mirror !== mirror) {
        rotate = r;
        mirror = !!m.mirror;
        for (const fn of rotated) fn(rotate, mirror);
      }
      if (vcam && !toVcam) {
        try {
          toVcam = nv12((buf) => bridge.frame(buf));
        } catch (e) {
          console.warn('vcam', e.message);
        }
      }
    });
    bridge.hello();

    return {
      push(source, sw, sh) {
        if (!sw || !sh) return;
        const now = performance.now();
        if (vcam && toVcam && now - lastFrame >= 1000 / FPS - 3) {
          lastFrame = now;
          toVcam(source, sw, sh, rotate, mirror);
        }
        if (!previewing && now - lastPreview >= PREVIEW_MS) {
          lastPreview = now;
          const side = rotate % 180 !== 0;
          const tw = side ? sh : sw, th = side ? sw : sh;
          const pw = PREVIEW_W, ph = Math.max(2, Math.round(PREVIEW_W * th / tw));
          if (preview.height !== ph) preview.height = ph;
          pctx.setTransform(mirror ? -1 : 1, 0, 0, 1, pw / 2, ph / 2); // mirrored: after the turn, as the virtual camera
          pctx.rotate((rotate * Math.PI) / 180);
          const dw = side ? ph : pw, dh = side ? pw : ph;
          try {
            pctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
          } catch {
            return;
          }
          previewing = true;
          preview.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
            .then((b) => b.arrayBuffer())
            .then((buf) => bridge.preview(buf))
            .catch(() => {})
            .finally(() => { previewing = false; });
        }
      },
      // The window's own picture turns (and mirrors) too (its CSS): fn(degrees, mirrored).
      onRotate(fn) {
        rotated.push(fn);
        fn(rotate, mirror);
      },
    };
  };
})();
