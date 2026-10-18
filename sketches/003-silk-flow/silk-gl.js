// silk-gl.js
// WebGL2 renderer for the silk flow sketch: luminous folding silk ribbons in a
// slow fluid flow, drawn by a single full-screen fragment shader.
//
// Every pixel is a pure function of (normalized position, loop phase, params,
// seed), so preview, 100% loupe, tiled poster export and video frames agree:
//   p = ((pixel + 0.5) - full / 2) / min(fullW, fullH), y up.
//
// Per pixel:
//   1. camera (zoom / pan) -> world, then a shared fluid domain warp: 4 octaves
//      of iterated sinusoidal displacement whose phases advance by INTEGER
//      cycles per loop (travelling waves -> seamless loops).
//   2. for each ribbon, far -> near (sorted on the CPU by depth):
//      - ribbon frame (u along, v across), centreline = 3 travelling harmonics;
//        y = perpendicular distance to it.
//      - the ribbon is a strip of half-width W twisted by theta(u) about its
//        centreline, with a cupped ("curled") cross-section. Its projection is
//        y(s) = W (C s - a s^2), C = cos theta, a = curl * sin theta, s in [-1, 1].
//        Solving that quadratic gives up to two visible layers (the ribbon folds
//        over itself where it turns edge-on), the face each layer shows
//        (front / back palette ramp), and exact distances to the strip edges and
//        to the fold silhouette, which drive anti-aliasing and depth-of-field.
//      - shading: gradient-mapped lighting (the lambert term indexes a dark ->
//        light ramp), "shot silk" front/back blend by facing, broad specular
//        sheen, fresnel at folds, bright edge rim, along-ribbon fibre striations
//        (stretched value noise, low-passed by the blur radius + pixel footprint),
//        and a chromatic outer glow.
//   3. composite in linear light over the background, encode to sRGB, add film
//      grain (fixed grid, 1/2400 of the short side) and triangular dither.
//
// Blur (depth of field) is analytic: per-ribbon radius r = softness + dof * |z - focus|
// widens the edge smoothsteps, fades fine detail and spreads the glow.

import { MAX_SLOTS, LUT_W, LUT_ROWS, hexToLinear } from './scene.js';

const SLOT_VEC4 = 9; // vec4 records per ribbon slot (data texture width)

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uOrigin;      // window origin, abs px (top-left, y down)
uniform vec2 uSize;        // window size, px
uniform vec2 uFull;        // full image size, px
uniform int uFlipY;        // 1: FBO read back top-down (row 0 = top)
uniform int uSS;           // samples per pixel (1, 2, 4)
uniform int uCount;        // ribbon slots in use (sorted far -> near)
uniform float uZoom;
uniform vec2 uOffset;
uniform vec4 uWarp[4];     // phase x, phase y, amplitude, frequency
uniform sampler2D uData;   // RGBA32F, ${SLOT_VEC4} x slots
uniform sampler2D uLut;    // SRGB8_ALPHA8 ramps, rows: front, back, accent, front
uniform vec3 uBg;          // linear
uniform mat3 uColorM;      // hue / saturation
uniform float uExpo;
uniform float uStreaks, uStreakScale, uSheen, uRim, uGlow, uGlowR, uGrain, uTransAmt;
uniform float uPxWorld;    // edge AA half-width, world units
uniform vec3 uRimCol, uGlowWarm, uGlowCool, uTrans; // linear, colour-matrixed
uniform vec3 uLight;
uniform uint uGrainKey;
uniform int uDebug;        // dev only: 1 = layer / ribbon id view
out vec4 outColor;

uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.z;
}
float hashF(ivec2 c, uint s) { return float(hash3(uvec3(uvec2(c), s))) * (1.0 / 4294967296.0); }
// value noise in [-1, 1], quintic fade
float vnoise(vec2 p, uint s) {
  vec2 i = floor(p), f = p - i;
  ivec2 c = ivec2(i);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hashF(c, s), b = hashF(c + ivec2(1, 0), s);
  float d = hashF(c + ivec2(0, 1), s), e = hashF(c + ivec2(1, 1), s);
  return mix(mix(a, b, w.x), mix(d, e, w.x), w.y) * 2.0 - 1.0;
}
float sq(float x) { return x * x; }

// shared fluid domain warp (iterated travelling sine waves)
vec2 fluid(vec2 q) {
  for (int i = 0; i < 4; i++) {
    vec4 Wp = uWarp[i];
    q.x += Wp.z * sin(Wp.w * q.y + Wp.x);
    q.y += Wp.z * sin(Wp.w * 1.13 * q.x + Wp.y);
  }
  return q;
}

vec3 softClip(vec3 c) {
  // gentle shoulder above 0.8 so sheen rolls off to white instead of clipping
  vec3 e = max(c - 0.8, 0.0);
  return min(c, 0.8) + 0.2 * (1.0 - exp(-e / 0.2));
}

// One visible layer of ribbon i at cross coordinate s. Returns linear colour.
vec3 shadeLayer(float s, float eEdge, float u, float C, float S, float kap, float W0,
                vec2 tU, vec2 nU, float r, vec4 R6, vec4 R7, vec4 R8) {
  // cross-section normal in (across, z), signed: z > 0 -> front face visible
  // (facing uses the true geometry; the shading normal uses a gentler cup so the
  // fabric reads as soft silk rather than a glossy tube)
  vec2 n2 = vec2(-(S + 2.0 * kap * C * s), C - 2.0 * kap * S * s);
  float F = n2.y * inversesqrt(max(dot(n2, n2), 1e-8));
  float kN = 0.6 * kap;
  n2 = vec2(-(S + 2.0 * kN * C * s), C - 2.0 * kN * S * s);
  n2 *= inversesqrt(max(dot(n2, n2), 1e-8));
  float bz = R6.y * cos(R6.z * u + R6.w);          // billow slope along u
  float fs = F >= 0.0 ? 1.0 : -1.0;
  vec3 N = fs * normalize(vec3(-bz, n2.x, n2.y));  // face-forward by the true facing (flips only at folds)
  vec3 Lr = vec3(dot(uLight.xy, tU), dot(uLight.xy, nU), uLight.z);
  float ndl = dot(N, Lr);
  float lam = 0.5 + 0.5 * ndl;

  // fibre striations: noise in (u, s * W) stretched hugely along u.
  // Low-passed by blur radius + pixel footprint (resolution independent).
  uint sd = uint(R7.z * 1000.0);
  float lp = sqrt(r * r + uPxWorld * uPxWorld);
  float k = uStreakScale;
  float f1 = 55.0 * k, f2 = 210.0 * k;
  float g1 = exp(-sq(f1 * lp * 1.4)), g2 = exp(-sq(f2 * lp * 1.4));
  float sw = s * W0;
  float st = 0.0;
  if (uStreaks > 0.0) {
    st = g1 * vnoise(vec2(u * 2.2 * k + R7.z, sw * f1), sd)
       + g2 * 0.85 * vnoise(vec2(u * 4.5 * k - R7.z, sw * f2), sd + 7u);
    float reg = smoothstep(-0.4, 0.5, vnoise(vec2(u * 1.1 + R7.z * 0.37, s * 0.8) + 0.6 * vec2(cos(R7.w), sin(R7.w)), sd + 13u));
    st *= uStreaks * (0.15 + 0.85 * reg);
  }

  // gradient-mapped lighting: lambert indexes a dark -> light ramp
  float x = -0.09 + 1.15 * pow(lam, 1.5) + R7.x + 0.2 * sin(R8.x * u + R8.y) + 0.12 * st;
  const float LW = ${LUT_W}.0;
  float xf = clamp(x, 0.1, 1.0) * ((LW - 1.0) / LW) + 0.5 / LW;
  float xb = clamp(x - 0.2, 0.14, 1.0) * ((LW - 1.0) / LW) + 0.5 / LW;   // back face sits deeper
  vec3 fc = texture(uLut, vec2(xf, 0.5 / ${LUT_ROWS}.0)).rgb;
  vec3 bc = texture(uLut, vec2(xb, (R7.y + 0.5) / ${LUT_ROWS}.0)).rgb;
  // shot silk: faces blend by facing, passing through a shaded transition tint
  // (avoids the grey of a straight complementary mix)
  float fm = smoothstep(-0.28, 0.28, F);
  vec3 col = uColorM * mix(bc, fc, fm);
  vec3 tc = uTrans * (0.45 + 0.75 * lam);
  col = mix(col, tc, uTransAmt * 4.0 * fm * (1.0 - fm) * 0.8);
  col *= (1.0 + 0.36 * st) * uExpo;

  // edge-on fresnel at folds + thin bright rim along the strip edges
  float fr = pow(1.0 - abs(F), 3.0);
  float rimW = 0.0022 + 0.8 * r;
  float rimE = exp(-max(eEdge, 0.0) / rimW) * sqrt(0.0022 / (0.0022 + r));
  float rimB = exp(-max(eEdge, 0.0) / (4.0 * rimW)) * 0.35;      // softer coloured band inside the edge
  // fresnel / soft band lift toward the face's own light colour; the thin line uses the rim colour
  vec3 lf = texture(uLut, vec2(0.93, 0.5 / ${LUT_ROWS}.0)).rgb;
  vec3 lb = texture(uLut, vec2(0.82, (R7.y + 0.5) / ${LUT_ROWS}.0)).rgb;
  vec3 lightC = uColorM * mix(lb, lf, fm) * uExpo;
  col = mix(col, lightC, clamp(uRim * (0.5 * fr + rimB), 0.0, 0.85));
  col = mix(col, uRimCol * uExpo, clamp(uRim * 0.85 * rimE, 0.0, 0.92));

  // anisotropic sheen: the cross-section normal against the half vector projected
  // into the cross-section plane -> long highlight bands running along the ribbon,
  // modulated along u by the full normal (billow) and by the fibres
  vec3 H = normalize(Lr + vec3(0.0, 0.0, 1.0));
  vec2 nf = n2 * fs;
  float nh2 = max(dot(nf, normalize(H.yz)), 0.0);
  float nh = max(dot(N, H), 0.0);
  float spec = uSheen * (0.45 * pow(nh2, 10.0) + 0.6 * pow(nh2, 60.0)) * (0.35 + 0.65 * nh * nh) * (1.0 + 0.8 * st);
  // silk sheen carries the fibre colour: tinted by the face's light colour
  vec3 sheenC = mix(lightC, mix(vec3(1.0), uRimCol, 0.3) * uExpo, 0.25 + 0.5 * fm);
  col += spec * sheenC;
  return softClip(max(col, 0.0));
}

vec3 render(vec2 p) {
  vec2 q = fluid(p / uZoom + uOffset);
  vec3 col = uBg * (1.0 + 0.02 * (0.5 - dot(p, p)));
  vec3 dbg = vec3(0.0);
  for (int i = 0; i < ${MAX_SLOTS}; i++) {
    if (i >= uCount) break;
    vec4 R0 = texelFetch(uData, ivec2(0, i), 0);
    vec2 dir = R0.xy, nrm = vec2(-dir.y, dir.x);
    float u = dot(q, dir), v = dot(q, nrm) - R0.z;
    vec4 R2 = texelFetch(uData, ivec2(2, i), 0);
    vec4 R3 = texelFetch(uData, ivec2(3, i), 0);
    vec4 R4 = texelFetch(uData, ivec2(4, i), 0);
    float a1 = R2.y * u + R2.z, a2 = R3.x * u + R3.y, a3 = R3.w * u + R4.x;
    float c = R2.x * sin(a1) + R2.w * sin(a2) + R3.z * sin(a3);
    float dc = R2.x * R2.y * cos(a1) + R2.w * R3.x * cos(a2) + R3.z * R3.w * cos(a3);
    float ic = inversesqrt(1.0 + dc * dc);
    float y = (v - c) * ic;
    float W = R0.w * (1.0 + R4.y * sin(R4.z * u + R4.w));
    vec4 R1 = texelFetch(uData, ivec2(1, i), 0);
    float r = R1.y;                       // blur radius (world)
    float rr = r + uPxWorld;              // edge transition half-width
    float kap = R1.w;
    float gR = uGlowR + 1.5 * r;
    if (abs(y) > W * (1.0 + kap) + 5.0 * gR + 2.0 * rr) continue;

    vec4 R5 = texelFetch(uData, ivec2(5, i), 0);
    vec4 R6 = texelFetch(uData, ivec2(6, i), 0);
    float th = R5.x + R5.y * u + R5.z * sin(R5.w * u + R6.x);
    float C = cos(th), S = sin(th);
    float yn = y / W;
    float a = kap * S;
    // cross-section extent in yn (for the glow)
    float sStar = abs(a) > 1e-4 ? C / (2.0 * a) : 9.0;
    float yp = C - a, ym = -C - a;
    float ymax = max(yp, ym), ymin = min(yp, ym);
    if (abs(sStar) < 1.0) { float yf = C * C / (4.0 * a); ymax = max(ymax, yf); ymin = min(ymin, yf); }
    float dout = max(ymin - yn, yn - ymax) * W;     // > 0 outside the ribbon

    if (uGlow > 0.0) {
      float ga = uGlow * 0.55 * R1.z * exp(-max(dout, 0.0) / gR);
      vec3 gc = mix(uGlowWarm, uGlowCool, smoothstep(-0.5 * gR, 2.5 * gR, dout));
      col = mix(col, gc * uExpo, clamp(ga, 0.0, 0.85));
    }
    if (dout > 2.0 * rr) continue;

    // visible layers: roots of a s^2 - C s + yn = 0
    float D = C * C - 4.0 * a * yn;
    float sqD = sqrt(max(D, 0.0));
    float qq = 0.5 * (C + (C >= 0.0 ? sqD : -sqD));
    float eFold = abs(a) > 1e-4 ? D / (4.0 * abs(a)) * W : 1e3;
    float sA = abs(qq) > 1e-6 ? yn / qq : sStar;
    float sB = abs(a) > 1e-4 ? qq / a : 1e3;
    if (D < 0.0) { sA = clamp(sStar, -1.5, 1.5); sB = 1e3; }
    // within-ribbon depth z(s) = S s + kap C s^2: draw the far layer first
    float zA = S * sA + kap * C * sA * sA, zB = S * sB + kap * C * sB * sB;
    bool swapL = abs(sB) < 2.0 && zB < zA;
    vec2 tU = (dir + dc * nrm) * ic, nU = (nrm - dc * dir) * ic;
    vec4 R7 = texelFetch(uData, ivec2(7, i), 0);
    vec4 R8 = texelFetch(uData, ivec2(8, i), 0);
    for (int L = 0; L < 2; L++) {
      float s = (L == 0) != swapL ? sA : sB;
      if (abs(s) > 1.0 + 4.0 * rr / max(W, 1e-4) + 0.5) continue;
      float sg = s >= 0.0 ? 1.0 : -1.0;
      // distance to the strip edge on this branch (none if the fold lies in between)
      // screen distance to each strip edge (s = +1 / -1) along this branch; if the
      // fold lies in between, the fold silhouette bounds the branch instead
      bool fbP = (sStar - s) * (1.0 - sStar) > 0.0;
      bool fbM = (sStar - s) * (-1.0 - sStar) > 0.0;
      float dP = abs(yp - yn) * W, dM = abs(ym - yn) * W;
      float eEdge, eRim;
      if (abs(s) <= 1.0) {
        eEdge = min(fbP ? 1e3 : dP, fbM ? 1e3 : dM);
        eRim = min(fbP ? eFold : dP, fbM ? eFold : dM);
      } else {
        // beyond the edge AND past the fold: that edge belongs to the other branch
        if (sg > 0.0 ? fbP : fbM) continue;
        eEdge = eRim = -(sg > 0.0 ? dP : dM);
      }
      float al = smoothstep(-rr, rr, eEdge) * smoothstep(-rr, rr, eFold) * R1.z;
      if (al < 0.002) continue;
      vec3 lc = shadeLayer(s, eRim, u, C, S, kap, R0.w, tU, nU, r, R6, R7, R8);
      col = mix(col, lc, al);
      dbg = mix(dbg, vec3(L == 0 ? 1.0 : 0.0, float(i + 1) / float(uCount), L == 1 ? 1.0 : 0.0), al);
    }
  }
  return uDebug == 1 ? dbg : col;
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  // absolute pixel centre in the full image, y down
  vec2 apx = vec2(uOrigin.x + fc.x, uFlipY == 1 ? uOrigin.y + fc.y : uOrigin.y + uSize.y - fc.y);
  float Smin = min(uFull.x, uFull.y);
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    if (k >= uSS) break;
    // rotated-grid jitter
    vec2 o = uSS == 1 ? vec2(0.0)
           : uSS == 2 ? (k == 0 ? vec2(0.25, 0.25) : vec2(-0.25, -0.25))
           : (k == 0 ? vec2(0.125, 0.375) : k == 1 ? vec2(0.375, -0.125) : k == 2 ? vec2(-0.125, -0.375) : vec2(-0.375, 0.125));
    vec2 pp = apx + o;
    acc += render(vec2(pp.x - 0.5 * uFull.x, 0.5 * uFull.y - pp.y) / Smin);
  }
  vec3 c = toSrgb(acc / float(uSS));
  // film grain on a fixed absolute grid (1/2400 of the short side), loop-keyed
  vec2 p0 = vec2(apx.x - 0.5 * uFull.x, 0.5 * uFull.y - apx.y) / Smin;
  ivec2 gc = ivec2(floor(p0 * 2400.0));
  float gn = hashF(gc, uGrainKey * 2654435761u + 17u) + hashF(gc, uGrainKey * 2246822519u + 91u) - 1.0;
  c += uGrain * 0.5 * gn;
  // triangular dither on the absolute output pixel
  ivec2 ip = ivec2(floor(apx));
  c += (hashF(ip, 0x5bd1e995u) + hashF(ip, 0x27d4eb2fu) - 1.0) / 255.0;
  outColor = vec4(c, 1.0);
}`;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Column-major mat3 (for uniformMatrix3fv): hue rotation then saturation (CSS filter matrices). */
function colorMatrix(hueDeg, sat) {
  const c = Math.cos(hueDeg * DEG), s = Math.sin(hueDeg * DEG);
  const H = [
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
  ];
  const t = sat;
  const S = [
    [0.213 + 0.787 * t, 0.715 - 0.715 * t, 0.072 - 0.072 * t],
    [0.213 - 0.213 * t, 0.715 + 0.285 * t, 0.072 - 0.072 * t],
    [0.213 - 0.213 * t, 0.715 - 0.715 * t, 0.072 + 0.928 * t],
  ];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) M[i][j] += S[i][k] * H[k][j];
  return { M, cm: new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]) };
}
const applyM = (M, v) => [0, 1, 2].map((i) => Math.max(0, M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]));

export class SilkRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, alpha: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.limits = {
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRb: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxVp: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    };
    this.prog = this._program(VERT, FRAG);
    this.U = this._uniforms(this.prog);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texLut = gl.createTexture();
    this._params(this.texLut, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.slotData = new Float32Array(SLOT_VEC4 * MAX_SLOTS * 4);
    this.texData = gl.createTexture();
    this._params(this.texData, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SLOT_VEC4, MAX_SLOTS, 0, gl.RGBA, gl.FLOAT, this.slotData);
    this.out = null; // { tex, fbo, w, h } RGBA8 for renderRegion
    this.scene = null;
  }

  /** Largest safe square tile for renderRegion (it also splits larger regions itself). */
  maxTile() {
    const L = this.limits;
    return Math.max(256, Math.min(4096, L.maxTex, L.maxRb, L.maxVp[0], L.maxVp[1]));
  }

  setScene(scene) {
    const gl = this.gl;
    this.scene = scene;
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, scene.lutW, scene.lutRows, 0, gl.RGBA, gl.UNSIGNED_BYTE, scene.lut);
  }

  /**
   * Render a w x h window (origin x, y: top-left, y down) of a full image laid out at
   * fullW x fullH into this.canvas (resized to w x h). ss: 1 | 2 | 4 samples per pixel.
   */
  draw({ P, t = 0, w, h, fullW = w, fullH = h, x = 0, y = 0, ss = 1 }) {
    if (!this.scene) throw new Error('SilkRenderer: setScene() must be called before draw()');
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this._render(P, t, { x, y, w, h, fullW, fullH, flip: 0, ss });
  }

  /**
   * Same as draw() but into an offscreen target.
   * @returns {Uint8Array} RGBA, tightly packed, top-down rows, w*h*4
   */
  renderRegion({ P, t = 0, fullW, fullH, x, y, w, h, ss = 1 }) {
    if (!this.scene) throw new Error('SilkRenderer: setScene() must be called before renderRegion()');
    const cs = this.maxTile();
    if (w <= cs && h <= cs) return this._renderChunk(P, t, fullW, fullH, x, y, w, h, ss);
    const out = new Uint8Array(w * h * 4);
    for (let cy = 0; cy < h; cy += cs) {
      for (let cx = 0; cx < w; cx += cs) {
        const cw = Math.min(cs, w - cx), ch = Math.min(cs, h - cy);
        const px = this._renderChunk(P, t, fullW, fullH, x + cx, y + cy, cw, ch, ss);
        for (let r = 0; r < ch; r++) out.set(px.subarray(r * cw * 4, (r + 1) * cw * 4), ((cy + r) * w + cx) * 4);
      }
    }
    return out;
  }

  _renderChunk(P, t, fullW, fullH, x, y, w, h, ss) {
    const gl = this.gl;
    this.out = this._ensureTarget(this.out, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
    gl.viewport(0, 0, w, h);
    this._render(P, t, { x, y, w, h, fullW, fullH, flip: 1, ss });
    const px = new Uint8Array(w * h * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  /** Per-ribbon records (scene shape x live params), sorted far -> near. */
  _slots(P, tau) {
    const sc = this.scene;
    const N = sc.ribbons.length;
    const spread = clamp(num(P.spread, 0.6), 0, 3);
    const baseW = clamp(num(P.ribbonWidth, 0.22), 0.005, 2);
    const wv = clamp(num(P.widthVariance, 0.5), 0, 1);
    const curv = clamp(num(P.curvature, 0.6), 0, 3) * 0.3;
    const twist = clamp(num(P.twist, 0.6), 0, 4);
    const curl = clamp(num(P.curl, 0.35), 0, 1.5);
    const dof = clamp(num(P.dof, 0.5), 0, 4);
    const focus = clamp(num(P.focus, 0.5), 0, 1);
    const soft = clamp(num(P.softness, 0.25), 0, 2);
    const ang0 = num(P.angle, -25) * DEG;
    const blur = (z) => soft * 0.004 + dof * 0.04 * Math.abs(z - focus);
    const ph = (p0, m) => p0 + TAU * m * tau;
    // long waves would race across the frame if their phase advanced a full cycle per
    // loop, so these oscillate (periodic, bounded travel): fundamental bend and twist
    const osc = (p0, m, amp) => p0 + amp * Math.sin(TAU * m * tau + 1.7 * p0);

    const recs = [];
    const mains = sc.ribbons.map((rb) => {
      const ang = ang0 + rb.angleJitter * 18 * DEG;
      const W = baseW * Math.exp(rb.width * wv);
      const v0 = spread * 0.85 * (rb.slot + rb.jitter * (N > 1 ? 1 / N : 0.5));
      const c = rb.c.map(([A, f, p0, m], k) => [A * curv, f, k === 0 ? osc(p0, m, 0.6) : ph(p0, m)]);
      return { rb, ang, W, v0, c, z: rb.depth };
    });
    for (const m of mains) {
      const rb = m.rb;
      recs.push({
        z: m.z,
        d: [
          Math.cos(m.ang), Math.sin(m.ang), m.v0, m.W,
          m.z, blur(m.z), rb.opacity, curl * rb.curl,
          m.c[0][0], m.c[0][1], m.c[0][2], m.c[1][0],
          m.c[1][1], m.c[1][2], m.c[2][0], m.c[2][1],
          m.c[2][2], rb.wobble[0] * (0.4 + wv), rb.wobble[1], ph(rb.wobble[2], rb.wobble[3]),
          rb.theta0, twist * rb.twistK, twist * rb.twistA, rb.twistF,
          osc(rb.twistPh, rb.twistM, 1.2), rb.billow[0], rb.billow[1], ph(rb.billow[2], rb.billow[3]),
          rb.ramp + rb.rampDrift[0] * Math.sin(ph(rb.rampDrift[1], rb.rampDrift[2])), rb.row === 2 ? 2 : 1, rb.seed, ph(rb.region[0], rb.region[1]),
          rb.rampFreq, rb.rampPh, 0, 0,
        ],
      });
    }
    for (const st of sc.strands) {
      const m = mains[st.parent];
      if (!m) continue;
      const rb = m.rb;
      const z = clamp(m.z + st.depthDelta, 0, 1);
      const lag = st.lag;
      recs.push({
        z,
        d: [
          Math.cos(m.ang), Math.sin(m.ang), m.v0 + st.side * st.gap * m.W, Math.max(0.003, m.W * st.width),
          z, blur(z), st.opacity, curl * 1.2,
          m.c[0][0], m.c[0][1], m.c[0][2] + lag, m.c[1][0],
          m.c[1][1], m.c[1][2] + 2 * lag, m.c[2][0], m.c[2][1],
          m.c[2][2] + 3 * lag, 0.15, 2.0, ph(rb.wobble[2] + 1.0, rb.wobble[3]),
          st.theta0, twist * st.twistK, twist * st.twistA, st.twistF,
          osc(st.twistPh, st.twistM, 1.6), rb.billow[0], rb.billow[1], ph(rb.billow[2] + lag, rb.billow[3]),
          rb.ramp + st.ramp, rb.row === 2 ? 2 : 1, st.seed, ph(rb.region[0], rb.region[1]),
          rb.rampFreq, rb.rampPh + lag, 0, 0,
        ],
      });
    }
    recs.sort((a, b) => a.z - b.z);
    const n = Math.min(recs.length, MAX_SLOTS);
    const data = this.slotData;
    data.fill(0);
    for (let i = 0; i < n; i++) data.set(recs[i].d, i * SLOT_VEC4 * 4);
    return n;
  }

  _render(P, t, job) {
    const gl = this.gl;
    const U = this.U;
    const sc = this.scene;
    const loop = Math.max(1e-3, num(P.loopSeconds, 12));
    // loop phase in [0, 1): t = 0 and t = loopSeconds give bit-identical frames
    let tau = num(t, 0) / loop;
    tau -= Math.floor(tau);
    if (tau >= 1) tau = 0;
    const ss = job.ss === 4 ? 4 : job.ss === 2 ? 2 : 1;
    const zoom = clamp(num(P.zoom, 1), 0.05, 50);
    const S = Math.min(job.fullW, job.fullH);

    const count = this._slots(P, tau);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texData);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SLOT_VEC4, MAX_SLOTS, gl.RGBA, gl.FLOAT, this.slotData);
    gl.uniform1i(U.uData, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.uniform1i(U.uLut, 1);

    gl.uniform2f(U.uOrigin, job.x, job.y);
    gl.uniform2f(U.uSize, job.w, job.h);
    gl.uniform2f(U.uFull, job.fullW, job.fullH);
    gl.uniform1i(U.uFlipY, job.flip);
    gl.uniform1i(U.uSS, ss);
    gl.uniform1i(U.uCount, count);
    gl.uniform1f(U.uZoom, zoom);
    gl.uniform2f(U.uOffset, num(P.offsetX, 0), num(P.offsetY, 0));

    const warp = clamp(num(P.warp, 0.5), 0, 4);
    const ws = clamp(num(P.warpScale, 1), 0.05, 10);
    const W = new Float32Array(16);
    sc.warp.forEach(([px, py, mx, my], i) => {
      W.set([px + TAU * mx * tau, py + TAU * my * tau, (warp * 0.075 / ws) * Math.pow(i + 1, -1.3), (i + 1) * 1.9 * ws], i * 4);
    });
    gl.uniform4fv(U.uWarp, W);

    const { M, cm } = colorMatrix(num(P.hueShift, 0), clamp(num(P.saturation, 1), 0, 3));
    gl.uniformMatrix3fv(U.uColorM, false, cm);
    const pal = sc.palette;
    const bg = hexToLinear(P.background || '#e4e5ee');
    gl.uniform3fv(U.uBg, bg);
    gl.uniform3fv(U.uRimCol, applyM(M, hexToLinear(pal.rim)));
    gl.uniform3fv(U.uGlowWarm, applyM(M, hexToLinear(pal.glowWarm)));
    gl.uniform3fv(U.uGlowCool, applyM(M, hexToLinear(pal.glowCool)));
    gl.uniform3fv(U.uTrans, applyM(M, hexToLinear(pal.trans)));
    gl.uniform1f(U.uTransAmt, 1.0);
    gl.uniform1f(U.uExpo, Math.pow(2, clamp(num(P.exposure, 0), -4, 4)));
    gl.uniform1f(U.uStreaks, clamp(num(P.streaks, 0.6), 0, 2));
    gl.uniform1f(U.uStreakScale, clamp(num(P.streakScale, 1), 0.05, 10));
    gl.uniform1f(U.uSheen, clamp(num(P.sheen, 0.7), 0, 4));
    gl.uniform1f(U.uRim, clamp(num(P.rim, 0.6), 0, 4));
    const glow = clamp(num(P.glow, 0.5), 0, 4);
    gl.uniform1f(U.uGlow, glow);
    gl.uniform1f(U.uGlowR, 0.01 + 0.03 * glow);
    gl.uniform1f(U.uGrain, clamp(num(P.grain, 0.03), 0, 1));
    gl.uniform1f(U.uPxWorld, 0.75 / (S * zoom) / Math.sqrt(ss));
    const L = [-0.55, 0.7, 0.45], ln = Math.hypot(...L);
    gl.uniform3f(U.uLight, L[0] / ln, L[1] / ln, L[2] / ln);
    // grain pattern changes 24x per second of loop time and wraps with the loop
    gl.uniform1ui(U.uGrainKey, Math.floor(tau * loop * 24) >>> 0);

    gl.uniform1i(U.uDebug, num(P.debug, 0) | 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _ensureTarget(t, w, h) {
    if (t && t.w >= w && t.h >= h) return t;
    const gl = this.gl;
    const W = Math.max(w, t ? t.w : 0), H = Math.max(h, t ? t.h : 0);
    this._freeTarget(t);
    const tex = gl.createTexture();
    this._params(tex, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('SilkRenderer: framebuffer incomplete (' + st + ')');
    return { tex, fbo, w: W, h: H };
  }
  _freeTarget(t) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  _params(t, filter) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _uniforms(prog) {
    const gl = this.gl;
    const map = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      map[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
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

  /** Release the offscreen export target (call after an export); the renderer stays usable. */
  trim() {
    this._freeTarget(this.out); this.out = null;
  }

  dispose() {
    this.trim();
    const gl = this.gl;
    gl.deleteTexture(this.texLut); gl.deleteTexture(this.texData);
    gl.deleteBuffer(this.vbuf); gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
