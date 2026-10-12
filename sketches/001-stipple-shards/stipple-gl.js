// stipple-gl.js
// WebGL2 stipple pass: (tone layer, grain layer, halo field) -> pure black/white round dots.
//
// Raw WebGL2 rather than p5's WEBGL renderer because we need exact control over
// texture formats (a float halo texture), framebuffer readback, tiling offsets
// and freeing GPU memory after a large export.
//
// Dot model (all in paper millimetres, so the dot field is identical at any DPI):
//   - space is divided into jittered cells of size cellMM * grainScale(region)
//   - each cell owns one candidate dot at a hashed position, hashed from
//     (cell index, grain code, seed) -> deterministic, tile-independent
//   - the tone at the dot centre gives the target coverage v; with a Poisson
//     coverage model we need lambda = -ln(1-v) dot-area per cell area:
//       small v: dot of fixed radius kb*cell drawn with probability p
//       large v: p = 1 and the radius grows (up to one cell) -> black specks in white
//   - a separate sparse "star" grid adds isolated dots of varying size.

import { drawLayer } from './composition.js';

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTone;   // R tone, B halo-allowed
uniform sampler2D uGrain;  // R grain code (0 = black mask)
uniform sampler2D uHalo;   // R float halo, covers the full image
uniform vec2 uTexOrigin;   // abs px of tone/grain texture top-left
uniform vec2 uTexSize;     // tone/grain texture size (px)
uniform vec2 uOutOrigin;   // abs px of output (0,0)
uniform vec2 uFull;        // full image size (px)
uniform float uMMperPx;
uniform float uCellMM;
uniform uint uSeed;
uniform float uBright, uContrast, uGamma, uHaloAmt, uHaloPow, uBg, uDensity, uSizeJitter;
uniform float uStarCellMM, uStarDensity, uStarSize;
uniform float uHard, uInvert;
out vec4 outColor;

uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
vec4 rand4(ivec2 c, uint layer) {
  return vec4(pcg4d(uvec4(uvec2(c), layer, uSeed))) * (1.0 / 4294967296.0);
}

// final tone (0..1) at an absolute pixel position
float toneAt(vec2 apx) {
  vec2 uv = (apx - uTexOrigin) / uTexSize;
  vec4 s = texture(uTone, uv);
  float t = clamp(s.r * uBright, 0.0, 1.0);
  t = clamp((t - 0.5) * uContrast + 0.5, 0.0, 1.0);
  t = pow(t, uGamma);
  if (s.b > 0.5) {
    float h = texture(uHalo, apx / uFull).r;
    h = pow(max(h, 0.0), uHaloPow);
    t = t + (uHaloAmt * h + uBg) * (1.0 - t);
  }
  return t;
}

float cover(float d, float r) { // d, r in px
  if (uHard > 0.5) return d < r ? 1.0 : 0.0;
  float c = clamp(r - d + 0.5, 0.0, 1.0);
  return c * min(1.0, 4.0 * r * r); // sub-pixel dots fade ~ by area
}

void main() {
  vec2 apx = uOutOrigin + gl_FragCoord.xy;   // y grows downward (readPixels row 0 = top)
  vec2 uvp = (apx - uTexOrigin) / uTexSize;
  float code = texture(uGrain, uvp).r * 255.0;
  float white = 0.0;
  if (code > 8.0) {
    float level = floor(code + 0.5);
    float cell = uCellMM * exp2((level - 128.0) / 32.0);
    vec2 pm = apx * uMMperPx;
    ivec2 ci = ivec2(floor(pm / cell));
    float pxPerMM = 1.0 / uMMperPx;
    const float KB = 0.42;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec2 c = ci + ivec2(i, j);
        vec4 r = rand4(c, uint(level));
        vec2 center = (vec2(c) + r.xy) * cell;           // mm
        float t = toneAt(center * pxPerMM);
        if (t <= 0.0005) continue;
        float lambda = -log(1.0 - min(t, 0.985)) * uDensity;
        float a = lambda / 3.14159265;                     // needed dot area / cell^2 / pi
        float m = exp2((r.w - 0.5) * 2.0 * uSizeJitter);   // per-dot size jitter
        float r0 = KB * m;
        float p, rad;
        if (a <= r0 * r0) { p = a / (r0 * r0); rad = r0; }
        else { p = 1.0; rad = min(sqrt(a) * m, 1.0); }
        if (r.z >= p) continue;
        float d = distance(pm, center) * pxPerMM;
        float cv = cover(d, rad * cell * pxPerMM);
        white = 1.0 - (1.0 - white) * (1.0 - cv);
      }
    }
    // sparse stars: isolated dots of very varied size
    if (uStarDensity > 0.0) {
      ivec2 si = ivec2(floor(pm / uStarCellMM));
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          ivec2 c = si + ivec2(i, j);
          vec4 r = rand4(c, 7919u);
          if (r.z >= uStarDensity) continue;
          vec2 center = (vec2(c) + r.xy) * uStarCellMM;
          float radMM = min(uCellMM * 0.5 * uStarSize * (0.35 + 3.5 * pow(r.w, 7.0)), uStarCellMM * 0.95);
          float cv = cover(distance(pm, center) * pxPerMM, radMM * pxPerMM);
          white = 1.0 - (1.0 - white) * (1.0 - cv);
        }
      }
    }
  }
  if (uInvert > 0.5) white = 1.0 - white;
  outColor = vec4(vec3(white), 1.0);
}`;

export class StippleRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.limits = {
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRb: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxVp: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    };
    this.prog = this._program(VERT, FRAG);
    this.uni = {};
    const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.prog, i);
      this.uni[info.name] = gl.getUniformLocation(this.prog, info.name);
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.vbuf = buf;
    this.texTone = this._tex(gl.LINEAR);
    this.texGrain = this._tex(gl.NEAREST);
    this.texHalo = this._tex(gl.LINEAR);
    this.fbo = null; this.fboTex = null; this.fboSize = [0, 0];
    // 2D canvases holding the tone/grain layers of the current tile
    this.toneCv = document.createElement('canvas');
    this.grainCv = document.createElement('canvas');
    this.toneCtx = this.toneCv.getContext('2d');
    this.grainCtx = this.grainCv.getContext('2d');
  }

  /** Largest square tile (output px) that fits textures/FBO given a padding. */
  maxTile(pad) {
    const L = this.limits;
    return Math.max(256, Math.min(4096, L.maxTex - 2 * pad, L.maxRb, L.maxVp[0], L.maxVp[1]));
  }

  setHalo(halo) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texHalo);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, halo.w, halo.h, 0, gl.RED, gl.FLOAT, halo.data);
  }

  _tex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  _ensureFbo(w, h) {
    const gl = this.gl;
    if (this.fbo && this.fboSize[0] >= w && this.fboSize[1] >= h) return;
    this._freeFbo();
    const W = Math.max(w, this.fboSize[0]), H = Math.max(h, this.fboSize[1]);
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    this.fboSize = [W, H];
  }
  _freeFbo() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    this.fbo = null; this.fboTex = null; this.fboSize = [0, 0];
  }

  /**
   * Render one region of the final image.
   * @param {object} job
   *   comp, fullW, fullH, mmPerPx, x, y, w, h, pad, uniforms {...}, hard, edgeIntensity
   * @returns {Uint8Array} RGBA, top-down rows, w*h*4
   */
  renderRegion(job) {
    const { comp, fullW, fullH, x, y, w, h, pad } = job;
    const gl = this.gl;
    // 1) source layers for this tile (+ padding so dot centres outside the tile are known)
    const tw = w + 2 * pad, th = h + 2 * pad;
    for (const cv of [this.toneCv, this.grainCv]) {
      if (cv.width < tw || cv.height < th) { cv.width = Math.max(cv.width, tw); cv.height = Math.max(cv.height, th); }
    }
    const cw = this.toneCv.width, ch = this.toneCv.height;
    drawLayer(this.toneCtx, comp, 'tone', fullW, fullH, x - pad, y - pad, cw, ch, job.edgeIntensity);
    drawLayer(this.grainCtx, comp, 'grain', fullW, fullH, x - pad, y - pad, cw, ch, 1);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.texTone);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.toneCv);
    gl.bindTexture(gl.TEXTURE_2D, this.texGrain);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.grainCv);

    // 2) stipple pass into the FBO
    this._ensureFbo(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const U = this.uni;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texTone); gl.uniform1i(U.uTone, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texGrain); gl.uniform1i(U.uGrain, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texHalo); gl.uniform1i(U.uHalo, 2);
    gl.uniform2f(U.uTexOrigin, x - pad, y - pad);
    gl.uniform2f(U.uTexSize, cw, ch);
    gl.uniform2f(U.uOutOrigin, x, y);
    gl.uniform2f(U.uFull, fullW, fullH);
    gl.uniform1f(U.uMMperPx, job.mmPerPx);
    gl.uniform1ui(U.uSeed, job.seed >>> 0);
    gl.uniform1f(U.uHard, job.hard ? 1 : 0);
    for (const [k, v] of Object.entries(job.uniforms)) if (U[k] != null) gl.uniform1f(U[k], v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Uint8Array(w * h * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Release large buffers (call after an export) but keep the renderer usable. */
  trim() {
    this._freeFbo();
    const gl = this.gl;
    for (const t of [this.texTone, this.texGrain]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    this.toneCv.width = this.toneCv.height = 1;
    this.grainCv.width = this.grainCv.height = 1;
  }

  dispose() {
    this.trim();
    const gl = this.gl;
    gl.deleteTexture(this.texTone); gl.deleteTexture(this.texGrain); gl.deleteTexture(this.texHalo);
    gl.deleteBuffer(this.vbuf); gl.deleteVertexArray(this.vao); gl.deleteProgram(this.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
