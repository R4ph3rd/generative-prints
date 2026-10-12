// strata-gl.js
// WebGL2 renderer for the strata sketch: a domain-warped scalar field, cut into
// colour bands by a 1D LUT, drawn with dense short pen strokes (or stipple dots).
//
// Two passes per tile, both pure functions of ABSOLUTE position so export tiles
// join seamlessly:
//
//   pass 1 ("cells"): one texel per cell of an absolute jittered grid (grid
//     spacing in paper mm, so strokes have the same physical size at any DPI).
//     For the cell's stroke it evaluates the field at the stroke centre (colour
//     via the LUT, flow direction via finite differences, hillshade) and writes
//     a packed RGBA32UI record: colour, centre offset, direction, half length/width.
//     Covers the tile plus a padding of R cells.
//   pass 2 ("draw"): per output pixel, loop over the (2R+1)^2 neighbouring cells,
//     fetch their records and composite anti-aliased capsules over the paper in a
//     fixed absolute (row-major) cell order -> order-deterministic, tile independent.
//
// The expensive fbm work therefore runs once per stroke instead of once per
// (pixel x neighbour).

import { MAX_RANGES, MAX_BUMPS, hexToRgb } from './scene.js';

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

uniform uint uSeed;

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
uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.z;
}
uint S(uint k) { return uSeed * 747796405u + k * 2891336453u; }
// (GLSL ES 3.00 has no packUnorm4x8)
uint packRGBA8(vec4 c) {
  uvec4 u = uvec4(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
  return u.x | (u.y << 8u) | (u.z << 16u) | (u.w << 24u);
}
vec4 unpackRGBA8(uint v) {
  return vec4(uvec4(v, v >> 8u, v >> 16u, v >> 24u) & 255u) * (1.0 / 255.0);
}
`;

// ---------------------------------------------------------------- pass 1
const CELL_FRAG = COMMON + `
uniform sampler2D uLut;
uniform int uLutSize;
uniform ivec2 uCell0;       // absolute grid cell of texel (0,0)
uniform float uGridUnits;   // grid spacing, units
uniform float uGridPerCell; // grain cells -> grid units
uniform float uCellUnits;   // grain cell, units
uniform vec4 uArt;          // art rect in units (x0, y0, x1, y1)
uniform int uKind;          // 0 strata, 1 landscape
uniform int uOct;
uniform float uWarp, uWarpScale, uRough, uEdgeJag, uTilt, uRidgeExp, uSkyScale, uUndAmp;
uniform vec4 uRangeA[${MAX_RANGES}];   // base, height, freq, lutOffset
uniform vec4 uRangeB[${MAX_RANGES}];   // bandScale, diag flag, diag angle, noise y
uniform int uRangeCount;
uniform vec4 uBumps[${MAX_BUMPS}];     // centre (units), radius (units), amplitude
uniform int uBumpCount;
uniform int uMode;          // 0 strokes, 1 stipple
uniform float uStrokeLen, uStrokeWid, uFlowAlign, uFlowCurl, uColorJitter, uShading, uPaperShow, uDensity;
out uvec4 outData;

vec2 hgrad(ivec2 c, uint s) {
  uint h = hash3(uvec3(uvec2(c), s));
  return vec2(float(h & 0xffffu), float(h >> 16u)) * (2.0 / 65535.0) - 1.0;
}
// 2D gradient noise, roughly in [-1, 1]
float gnoise(vec2 p, uint s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hgrad(c, s), f);
  float b = dot(hgrad(c + ivec2(1, 0), s), f - vec2(1.0, 0.0));
  float d = dot(hgrad(c + ivec2(0, 1), s), f - vec2(0.0, 1.0));
  float e = dot(hgrad(c + ivec2(1, 1), s), f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(d, e, w.x), w.y) * 1.25;
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbmN(vec2 p, uint s, int n) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= n) break;
    sum += amp * gnoise(p, s + uint(o) * 0x9E3779B9u);
    norm += amp;
    amp *= uRough;
    p = ROT * p * 2.03 + vec2(1.7, 9.2);
  }
  return sum / norm;
}
float ridged(vec2 p, uint s) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  int n = min(uOct, 6);
  for (int o = 0; o < 8; o++) {
    if (o >= n) break;
    float v = clamp(1.0 - abs(gnoise(p, s + uint(o) * 0x632BE5ABu)), 0.0, 1.0);
    sum += amp * pow(v, uRidgeExp);
    norm += amp;
    amp *= uRough * 0.9;
    p = p * 2.07 + vec2(3.1, 0.0);
  }
  return sum / norm;
}

vec2 warpDisp(vec2 u) {
  if (uWarp <= 0.0) return vec2(0.0);
  vec2 p = u * (1.6 * uWarpScale);
  vec2 q = vec2(fbmN(p, S(1u), uOct), fbmN(p + vec2(5.2, 1.3), S(2u), uOct));
  vec2 r = vec2(fbmN(p + 3.0 * q + vec2(1.7, 9.2), S(3u), uOct),
                fbmN(p + 3.0 * q + vec2(8.3, 2.8), S(4u), uOct));
  return r * (uWarp * 0.16 / uWarpScale);
}

// x = continuous field value (band coordinate, LUT wraps), y = region id
vec2 fieldAt(vec2 u0, bool jag) {
  vec2 disp = warpDisp(u0);
  vec2 jd = vec2(0.0);
  if (jag && uEdgeJag > 0.0) {
    vec2 pj = u0 * 30.0;
    int nj = clamp(uOct - 2, 2, 4);
    jd = vec2(fbmN(pj, S(5u), nj), fbmN(pj + vec2(4.4, 6.1), S(6u), nj)) * (uEdgeJag * 0.025);
  }
  vec2 u = u0 + disp + jd;
  float artH = uArt.w - uArt.y;
  float ay = (u.y - uArt.y) / artH;
  float ax = (u.x - 0.5 * (uArt.x + uArt.z)) / artH;
  float und = uUndAmp * fbmN(u * (0.9 * uWarpScale) + vec2(11.0, 3.0), S(7u), uOct);
  if (uKind == 0) {
    float f = ay + uTilt * ax + und;
    for (int b = 0; b < ${MAX_BUMPS}; b++) {
      if (b >= uBumpCount) break;
      vec4 B = uBumps[b];
      vec2 d = (u - B.xy) / B.z;
      f -= B.w * exp(-dot(d, d));
    }
    return vec2(f, 0.0);
  }
  // silhouettes use a damped warp so the ridges stay legible; deeper inside a
  // range the full warp takes over so its strata still fold and swirl
  vec2 uR = u0 + 0.35 * disp + jd;
  float ayR = (uR.y - uArt.y) / artH;
  float axR = (uR.x - 0.5 * (uArt.x + uArt.z)) / artH;
  for (int i = ${MAX_RANGES - 1}; i >= 0; i--) {
    if (i >= uRangeCount) continue;
    vec4 A = uRangeA[i];
    vec4 B = uRangeB[i];
    float r = smoothstep(0.2, 0.95, ridged(vec2(uR.x * A.z, B.w), S(20u + uint(i))));
    float top = A.x - A.y * r + uTilt * axR * 0.3;
    float d = ayR - top;
    if (d > 0.0) {
      float w = smoothstep(0.0, 0.15, d);
      float dd = mix(d, ay - top, w);
      float f = B.y > 0.5
        ? A.w + (mix(ayR, ay, w) * cos(B.z) + mix(axR, ax, w) * sin(B.z)) * B.x + und
        : A.w + dd * B.x + und * 0.6 * w;
      return vec2(f, float(i + 1));
    }
  }
  return vec2(uSkyScale * (ay + uTilt * ax * 0.5) + und, 0.0);
}

void main() {
  ivec2 cell = uCell0 + ivec2(gl_FragCoord.xy);
  vec4 r1 = rand4(cell, 0x51ED27u);
  vec4 r2 = rand4(cell, 0x2C1B3Cu);
  vec4 r3 = rand4(cell, 0x7A4F11u);
  vec2 off = r1.xy;
  vec2 cu = (vec2(cell) + off) * uGridUnits;
  if (cu.x < uArt.x || cu.y < uArt.y || cu.x > uArt.z || cu.y > uArt.w) { outData = uvec4(0u); return; }

  vec2 F = fieldAt(cu, true);
  int idx = clamp(int(fract(F.x) * float(uLutSize)), 0, uLutSize - 1);
  vec4 band = texelFetch(uLut, ivec2(idx, 0), 0);
  if (band.a <= 0.0) { outData = uvec4(0u); return; }

  // flow / hillshade from the smooth (un-jagged) field
  float h = uCellUnits * 4.0;
  float f0 = uEdgeJag > 0.0 ? fieldAt(cu, false).x : F.x;
  vec2 g = vec2(fieldAt(cu + vec2(h, 0.0), false).x - f0, fieldAt(cu + vec2(0.0, h), false).x - f0) / h;
  float artH = uArt.w - uArt.y;
  vec3 L = normalize(vec3(-0.6, -0.6, 0.55));
  float lit = dot(normalize(vec3(g * 0.3 * artH, 1.0)), L);
  float lit0 = dot(normalize(vec3(0.0, 0.3, 1.0)), L);    // undisturbed strata
  float sh = clamp((lit - lit0) * 2.5, -1.0, 1.0);          // >0 lit, <0 shadow

  vec3 col = band.rgb;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec2 dir;
  float hl, hw;
  if (uMode == 0) {
    float drop = uPaperShow * (0.6 + 0.8 * (1.0 - lum)) + uShading * max(sh, 0.0) * 0.2;
    if (r2.z < drop) { outData = uvec4(0u); return; }
    col *= 1.0 + uShading * sh * 0.3;
    float gm = length(g);
    vec2 tng = gm > 1e-6 ? vec2(-g.y, g.x) / gm : vec2(1.0, 0.0);
    float th = atan(tng.y, tng.x);
    th += uFlowCurl * 1.4 * gnoise(cu * 14.0, S(8u));
    th += (1.0 - uFlowAlign) * 3.14159265 * (r3.x - 0.5);
    th += 0.14 * (r3.y - 0.5);
    dir = vec2(cos(th), sin(th));
    hl = 0.5 * uStrokeLen * (0.7 + 0.6 * r1.z) * uGridPerCell;
    hw = 0.5 * uStrokeWid * (0.8 + 0.4 * r1.w) * uGridPerCell;
  } else {
    float tone = band.a * (1.0 - uShading * 1.8 * sh);
    float lambda = -log(1.0 - clamp(tone, 0.0, 0.97)) * uDensity * (1.0 - uPaperShow);
    float a = lambda / 3.14159265;
    const float r0 = 0.42;
    float p, rad;
    if (a <= r0 * r0) { p = a / (r0 * r0); rad = r0; }
    else { p = 1.0; rad = min(sqrt(a), 0.95); }
    if (r2.z >= p) { outData = uvec4(0u); return; }
    dir = vec2(1.0, 0.0);
    hl = 0.0;
    hw = rad * (0.85 + 0.3 * r1.z);
  }
  // per-stroke lightness / hue jitter
  col *= 1.0 + (r2.w - 0.5) * 2.0 * uColorJitter;
  col += (vec3(r3.z, r3.w, r2.x) - 0.5) * uColorJitter * 0.4;
  outData = uvec4(packRGBA8(vec4(col, 1.0)),
                  packHalf2x16(off), packHalf2x16(dir), packHalf2x16(vec2(hl, hw)));
}`;

// ---------------------------------------------------------------- pass 2
const DRAW_FRAG = COMMON + `
uniform usampler2D uData;
uniform ivec2 uCell0;
uniform vec2 uOutOrigin;    // abs px of output (0,0)
uniform float uPxToGrid;
uniform float uGridPx;
uniform int uR;
uniform vec3 uPaper;
uniform vec4 uArtPx;        // art rect, px
uniform float uOvershootPx; // allowed overshoot past the art rect (<0: unlimited)
out vec4 outColor;

float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  ivec2 c = ivec2(i);
  f = f * f * (3.0 - 2.0 * f);
  float a = float(hash3(uvec3(uvec2(c), S(9u)))) ;
  float b = float(hash3(uvec3(uvec2(c + ivec2(1, 0)), S(9u))));
  float d = float(hash3(uvec3(uvec2(c + ivec2(0, 1)), S(9u))));
  float e = float(hash3(uvec3(uvec2(c + ivec2(1, 1)), S(9u))));
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y) * (1.0 / 4294967296.0);
}

void main() {
  vec2 apx = uOutOrigin + gl_FragCoord.xy;   // y grows downward (readPixels row 0 = top)
  vec3 acc = uPaper;
  vec2 g = apx * uPxToGrid;
  if (uOvershootPx >= 0.0) {
    vec2 c = 0.5 * (uArtPx.xy + uArtPx.zw), hs = 0.5 * (uArtPx.zw - uArtPx.xy);
    vec2 q = abs(apx - c) - hs;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float n = 0.6 * vnoise(g * 0.35) + 0.4 * vnoise(g * 1.3 + 17.0);
    if (sd > uOvershootPx * (0.15 + 0.85 * n)) { outColor = vec4(acc, 1.0); return; }
  }
  ivec2 k = ivec2(floor(g));
  for (int j = -uR; j <= uR; j++) {
    for (int i = -uR; i <= uR; i++) {
      ivec2 cell = k + ivec2(i, j);
      uvec4 d = texelFetch(uData, cell - uCell0, 0);
      if ((d.x >> 24u) == 0u) continue;
      vec2 v = (g - (vec2(cell) + unpackHalf2x16(d.y))) * uGridPx;   // px
      vec2 lw = unpackHalf2x16(d.w) * uGridPx;
      float reach = lw.x + lw.y + 1.0;
      if (dot(v, v) > reach * reach) continue;
      vec2 dir = unpackHalf2x16(d.z);
      float t = clamp(dot(v, dir), -lw.x, lw.x);
      float dist = length(v - dir * t);
      float cov = clamp(lw.y - dist + 0.5, 0.0, 1.0) * min(1.0, 2.0 * lw.y) * min(1.0, 2.0 * (lw.x + lw.y));
      if (cov <= 0.0) continue;
      acc = mix(acc, unpackRGBA8(d.x).rgb, cov);
    }
  }
  outColor = vec4(acc, 1.0);
}`;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const MAX_R = 24;

export class StrataRenderer {
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
    this.progCell = this._program(VERT, CELL_FRAG);
    this.progDraw = this._program(VERT, DRAW_FRAG);
    this.uCell = this._uniforms(this.progCell);
    this.uDraw = this._uniforms(this.progDraw);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [this.progCell, this.progDraw]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.texLut = gl.createTexture();
    this._params(this.texLut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.data = null; // { tex, fbo, w, h }  RGBA32UI cell records
    this.out = null;  // { tex, fbo, w, h }  RGBA8 output
    this.scene = null;
  }

  /** Largest safe square output tile (internal cell padding is handled by sub-chunking). */
  maxTile() {
    const L = this.limits;
    return Math.max(256, Math.min(4096, L.maxTex, L.maxRb, L.maxVp[0], L.maxVp[1]));
  }

  setScene(scene) {
    const gl = this.gl;
    this.scene = scene;
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, scene.lutSize, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, scene.lut);
  }

  /**
   * Render pixels [x,x+w) x [y,y+h) of an image laid out at fullW x fullH.
   * @returns {Uint8Array} RGBA, top-down rows, w*h*4
   */
  renderRegion(job) {
    if (!this.scene) throw new Error('StrataRenderer: setScene() must be called before renderRegion()');
    const { x, y, w, h } = job;
    const geo = this._geometry(job);
    const lim = this.maxTile();
    // cell texture must also fit: chunk so that (chunk * pxToGrid + 2R + 4) <= lim
    const byGrid = Math.floor((lim - 2 * geo.R - 4) / geo.pxToGrid);
    const cs = Math.max(16, Math.min(lim, byGrid));
    if (w <= cs && h <= cs) return this._renderChunk(job, geo, x, y, w, h);
    const out = new Uint8Array(w * h * 4);
    for (let cy = 0; cy < h; cy += cs) {
      for (let cx = 0; cx < w; cx += cs) {
        const cw = Math.min(cs, w - cx), ch = Math.min(cs, h - cy);
        const px = this._renderChunk(job, geo, x + cx, y + cy, cw, ch);
        for (let r = 0; r < ch; r++) out.set(px.subarray(r * cw * 4, (r + 1) * cw * 4), ((cy + r) * w + cx) * 4);
      }
    }
    return out;
  }

  _geometry(job) {
    const { P, fullW, fullH, mmPerPx, cellMM } = job;
    const S = Math.min(fullW, fullH);
    const unitsPerPx = 1 / S;
    const cellPx = Math.max(1e-3, cellMM / mmPerPx);
    const stipple = P.texture === 'stipple';
    const density = clamp(num(P.density, 1), 0.05, 10);
    const sLen = clamp(num(P.strokeLength, 3), 0.2, 20);
    const sWid = clamp(num(P.strokeWidth, 0.35), 0.01, 4);
    // strokes: ~2 strokes per grain cell at density 1; stipple: fixed fine grid, density scales ink
    const gridPx = stipple ? cellPx * 0.4 : cellPx / Math.sqrt(2 * density);
    const gridPerCell = cellPx / gridPx;
    const pxToGrid = 1 / gridPx;
    // max reach of a stroke from its centre, in grid units
    const reach = stipple
      ? 0.95 * 1.15 + 1 / gridPx
      : (0.5 * sLen * 1.3 + 0.5 * sWid * 1.2) * gridPerCell + 1 / gridPx;
    const R = clamp(Math.ceil(reach), 1, MAX_R);
    const m = clamp(num(P.margin, 0.075), 0, 0.45);
    const W = fullW / S, H = fullH / S;
    const ragged = clamp(num(P.raggedEdge, 0.5), 0, 1);
    const hlPx = stipple ? 0.95 * gridPx : 0.5 * sLen * cellPx;
    return {
      S, unitsPerPx, cellPx, gridPx, gridPerCell, pxToGrid, R, stipple, density, sLen, sWid,
      art: [m, m, W - m, H - m],
      artPx: [m * S, m * S, fullW - m * S, fullH - m * S],
      overshootPx: ragged >= 0.999 ? -1 : 2 * ragged * hlPx,
    };
  }

  _renderChunk(job, geo, x, y, w, h) {
    const gl = this.gl;
    const { P } = job;
    const sc = this.scene;
    const seed = (sc.seedHash >>> 0);
    // ---- pass 1: cell records covering the chunk + R cells
    const R = geo.R;
    const c0x = Math.floor(x * geo.pxToGrid) - R - 1;
    const c0y = Math.floor(y * geo.pxToGrid) - R - 1;
    const c1x = Math.floor((x + w) * geo.pxToGrid) + R + 1;
    const c1y = Math.floor((y + h) * geo.pxToGrid) + R + 1;
    const gw = c1x - c0x + 1, gh = c1y - c0y + 1;
    this.data = this._ensureTarget(this.data, gw, gh, gl.RGBA32UI);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.data.fbo);
    gl.viewport(0, 0, gw, gh);
    gl.useProgram(this.progCell);
    gl.bindVertexArray(this.vao);
    let U = this.uCell;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texLut); gl.uniform1i(U.uLut, 0);
    gl.uniform1i(U.uLutSize, sc.lutSize);
    gl.uniform1ui(U.uSeed, seed);
    gl.uniform2i(U.uCell0, c0x, c0y);
    gl.uniform1f(U.uGridUnits, geo.gridPx * geo.unitsPerPx);
    gl.uniform1f(U.uGridPerCell, geo.gridPerCell);
    gl.uniform1f(U.uCellUnits, geo.cellPx * geo.unitsPerPx);
    gl.uniform4fv(U.uArt, geo.art);
    gl.uniform1i(U.uKind, sc.kind);
    gl.uniform1i(U.uOct, clamp(Math.round(num(P.detail, 5)), 1, 8));
    const warp = clamp(num(P.warp, 0.8), 0, 4);
    gl.uniform1f(U.uWarp, warp);
    gl.uniform1f(U.uWarpScale, clamp(num(P.warpScale, 1.2), 0.05, 20));
    gl.uniform1f(U.uRough, clamp(num(P.roughness, 0.5), 0.05, 0.95));
    gl.uniform1f(U.uEdgeJag, clamp(num(P.edgeJag, 0.5), 0, 2));
    gl.uniform1f(U.uTilt, clamp(num(P.tilt, 0), -2, 2));
    gl.uniform1f(U.uRidgeExp, 1 + 3 * clamp(num(P.ridgeSharpness, 0.6), 0, 1));
    gl.uniform1f(U.uSkyScale, sc.skyScale);
    gl.uniform1f(U.uUndAmp, 0.1 + 0.15 * warp);
    // ranges: A = (base, height, freq, lutOffset), B = (bandScale, diag, angle, noiseY)
    const A = new Float32Array(MAX_RANGES * 4), B = new Float32Array(MAX_RANGES * 4);
    for (let i = 0; i < MAX_RANGES; i++) {
      A.set(sc.ranges.subarray(i * 8, i * 8 + 4), i * 4);
      B.set(sc.ranges.subarray(i * 8 + 4, i * 8 + 8), i * 4);
    }
    gl.uniform4fv(U.uRangeA, A);
    gl.uniform4fv(U.uRangeB, B);
    gl.uniform1i(U.uRangeCount, sc.rangeCount);
    // bumps: art-relative -> units
    const [ax0, ay0, ax1, ay1] = geo.art;
    const bumps = new Float32Array(MAX_BUMPS * 4);
    for (let b = 0; b < sc.bumpCount; b++) {
      const o = b * 4;
      bumps[o] = ax0 + sc.bumps[o] * (ax1 - ax0);
      bumps[o + 1] = ay0 + sc.bumps[o + 1] * (ay1 - ay0);
      bumps[o + 2] = sc.bumps[o + 2];
      bumps[o + 3] = sc.bumps[o + 3];
    }
    gl.uniform4fv(U.uBumps, bumps);
    gl.uniform1i(U.uBumpCount, sc.bumpCount);
    gl.uniform1i(U.uMode, geo.stipple ? 1 : 0);
    gl.uniform1f(U.uStrokeLen, geo.sLen);
    gl.uniform1f(U.uStrokeWid, geo.sWid);
    gl.uniform1f(U.uFlowAlign, clamp(num(P.flowAlign, 0.8), 0, 1));
    gl.uniform1f(U.uFlowCurl, clamp(num(P.flowCurl, 0.3), 0, 2));
    gl.uniform1f(U.uColorJitter, clamp(num(P.colorJitter, 0.08), 0, 1));
    gl.uniform1f(U.uShading, clamp(num(P.shading, 0.25), 0, 1));
    gl.uniform1f(U.uPaperShow, clamp(num(P.paperShow, 0.1), 0, 0.95));
    gl.uniform1f(U.uDensity, geo.density);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- pass 2: composite strokes for the chunk
    this.out = this._ensureTarget(this.out, w, h, gl.RGBA8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progDraw);
    U = this.uDraw;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.data.tex); gl.uniform1i(U.uData, 1);
    gl.uniform1ui(U.uSeed, seed);
    gl.uniform2i(U.uCell0, c0x, c0y);
    gl.uniform2f(U.uOutOrigin, x, y);
    gl.uniform1f(U.uPxToGrid, geo.pxToGrid);
    gl.uniform1f(U.uGridPx, geo.gridPx);
    gl.uniform1i(U.uR, R);
    const pc = hexToRgb(P.paperColor || '#e8e3d7');
    gl.uniform3f(U.uPaper, pc[0] / 255, pc[1] / 255, pc[2] / 255);
    gl.uniform4fv(U.uArtPx, geo.artPx);
    gl.uniform1f(U.uOvershootPx, geo.overshootPx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    return px;
  }

  _ensureTarget(t, w, h, format) {
    if (t && t.w >= w && t.h >= h) return t;
    const gl = this.gl;
    const W = Math.max(w, t ? t.w : 0), H = Math.max(h, t ? t.h : 0);
    this._freeTarget(t);
    const tex = gl.createTexture();
    this._params(tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, W, H);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('StrataRenderer: framebuffer incomplete (' + st + ')');
    return { tex, fbo, w: W, h: H };
  }
  _freeTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  }

  _params(t) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _uniforms(prog) {
    const gl = this.gl;
    const map = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const name = info.name.replace(/\[0\]$/, '');
      map[name] = gl.getUniformLocation(prog, info.name);
    }
    return map;
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

  /** Release large buffers (call after an export) but keep the renderer usable. */
  trim() {
    this._freeTarget(this.data); this.data = null;
    this._freeTarget(this.out); this.out = null;
  }

  dispose() {
    this.trim();
    const gl = this.gl;
    gl.deleteTexture(this.texLut);
    gl.deleteBuffer(this.vbuf); gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.progCell); gl.deleteProgram(this.progDraw);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
