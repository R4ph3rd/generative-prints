// marble-gl.js
// WebGL2 renderer for the liquid marble sketch: psychedelic marbled fluid in a few
// flat colour bands, with bright edge lines, chromatic fringes and heavy riso
// grain, drawn by a single full-screen fragment shader.
//
// Every pixel is a pure function of (normalized position, loop phase, params,
// scene), so preview, 100% loupe, tiled poster export and video frames agree:
//   p = ((pixel + 0.5) - full / 2) / min(fullW, fullH), y up.
//
// Per sample:
//   1. camera (zoom / pan / scale) and an anisotropic squash along P.angle
//      (P.stretch) map p to field space x.
//   2. marbling by advection: P.warpIterations passes, each moving the sample
//      point a in 4 small Euler steps along its own velocity field v = (fbm, fbm)
//      (smooth 1-2 octave 3D simplex fbm, scaled by P.warp), "twisted" by a
//      rotation whose angle follows the local noise (P.swirl). Small steps keep the
//      map x -> a fold-free, so ink filaments stretch and curl around eddies
//      instead of creasing. The scalar field is f = fbm(a) (P.detail octaves,
//      gain P.roughness) plus a ramp across the stretch direction that combs the
//      bands into long ribbons.
//      Motion: every octave samples its 3D noise along a CIRCLE (in a plane spanned
//      by z and a seeded in-plane direction) whose angle is an integer multiple of
//      2 pi t / loopSeconds, radius ~ P.flow -> the flow evolves smoothly and t,
//      t + loopSeconds are bit-identical.
//      Every noise call also returns its analytic gradient and the advection
//      Jacobian is carried along exactly (J <- (I + h dv/da) J, incl. the twist),
//      so the exact field gradient is known per sample without screen-space
//      derivatives: band anti-aliasing and the line / fringe distances
//      (band offset / |grad|) are identical across tiles, crops and supersampling.
//   3. band coordinate u = (0.5 + 0.5 tanh(4.5 f)) * bands * N + ramp + colorOffset * N
//      (tanh ~ the field's CDF, so the N palette colours get similar areas); the
//      palette is cyclic and band boundaries sit at integer u. Each boundary gets a
//      soft glow, a bright line (scene.line, half width lineWidth * 0.003) and two
//      misregistered copies of it in fringeA / fringeB shifted to either side
//      (fringeWidth * 0.0018), all in units of the short side so prints match the
//      preview. Bands narrower than a pixel fade to the palette mean.
//   4. exposure + vignette (towards scene.paper) in linear light; encode sRGB,
//      contrast; riso speckle (2 octaves of hashed value noise on an absolute grid,
//      cell = grainSize * 0.0018 of the short side, luma + coloured, mid-tone
//      weighted, re-keyed 24x per second of loop time when P.grainAnimate);
//      triangular dither.
//
// Cost at default params: ~21 simplex-noise evaluations per sample.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_COLORS = 8;
const N_FBM = 9; // 2 per warp pass (max 4) + final

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uOrigin;      // window origin, abs px (top-left, y down)
uniform vec2 uSize;        // window size, px
uniform vec2 uFull;        // full image size, px
uniform int uFlipY;        // 1: FBO read back top-down (row 0 = top)
uniform int uSS;           // samples per pixel (1, 2, 4)

uniform mat2 uCam;         // p -> field space (zoom, scale, stretch, angle)
uniform vec2 uCamOff;      // field-space offset (pan)
uniform vec4 uFbm[${N_FBM}];  // per fbm: offset xy, circle phase (turns), circle direction (turns)
uniform float uTheta;      // 2 pi * loop phase
uniform float uFlowR;      // circle radius, noise units
uniform int uOct;          // octaves (final fbm)
uniform float uOctW;       // octaves (warp fbms: smoother, fewer; fractional, last one faded)
uniform float uGain;       // octave gain
uniform float uOctNorm;    // 1 / sum of octave amplitudes (final)
uniform float uOctNormW;   // 1 / sum of octave amplitudes (warp)
uniform int uIter;         // warp passes
uniform float uWarpAmt;    // warp displacement per unit noise
uniform float uSwirl;      // twist strength
uniform float uRampK;      // stripe ramp across the stretch direction, band units

uniform vec3 uColors[${MAX_COLORS}];  // linear, colour-matrixed
uniform int uCount;
uniform vec3 uAvg;         // mean palette colour (bands narrower than a pixel)
uniform float uBandK;      // u = (0.5 + 0.5 tanh(4.5 f)) * uBandK + ramp * uRampK + uBandO
uniform float uBandO;
uniform float uSoft;       // band transition width in u (0 = hard)
uniform vec3 uLine, uFringeA, uFringeB, uPaper;
uniform float uLines, uLineW, uFringe, uFringeO, uFringeS, uGlow, uGlowR;
uniform float uPxN;        // AA width, normalized units (one pixel / sqrt(ss))
uniform float uExpo, uVig, uContrast;
uniform vec2 uHalfExt;     // half image extent, normalized units
uniform float uGrain, uGrainCell, uGrainColor;
uniform uint uGrainKey;
uniform int uDebug;        // dev only: 1 = field, 2 = |grad u| analytic (r) vs screen-space (g)
out vec4 outColor;

// ---------------------------------------------------------------- hashing
uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.z;
}
float hashF(ivec2 c, uint s) { return float(hash3(uvec3(uvec2(c), s))) * (1.0 / 4294967296.0); }
// value noise in [-1, 1], cubic fade
float vnoise(vec2 p, uint s) {
  vec2 i = floor(p), f = p - i;
  ivec2 c = ivec2(i);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hashF(c, s), b = hashF(c + ivec2(1, 0), s);
  float d = hashF(c + ivec2(0, 1), s), e = hashF(c + ivec2(1, 1), s);
  return mix(mix(a, b, w.x), mix(d, e, w.x), w.y) * 2.0 - 1.0;
}

// ------------------------------------------- 3D simplex noise with gradient
// (Ashima Arts / Stefan Gustavson, MIT; derivative form after Gustavson)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
// returns (noise, d/dx, d/dy, d/dz), noise roughly in [-1, 1]
vec4 snoiseD(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m, m3 = m2 * m, m4 = m2 * m2;
  vec4 pdx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 t = m3 * pdx;
  vec3 grad = -8.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3)
            + m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 105.0 * vec4(dot(m4, pdx), grad);
}

// ------------------------------------------------------------- fluid field
const float TAU = 6.28318530718;
// octave rotation (~36.9 deg) times lacunarity 2.03
const mat2 OCT = mat2(0.8, 0.6, -0.6, 0.8) * 2.03;

// fbm j at field-space point x -> (value, d/dx, d/dy), value ~ [-1, 1]
vec3 fbm(vec2 x, int j, float oct, float norm) {
  vec4 F = uFbm[j];
  vec2 y = x + F.xy;
  mat2 M = mat2(1.0);            // dy/dx
  float a = 1.0, s = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= oct) break;
    float aw = a * min(oct - fi, 1.0);
    // loop-periodic circle through the noise volume: integer cycles per loop
    float cyc = i < 2 ? 1.0 : 2.0;
    float an = cyc * uTheta + TAU * (F.z + 0.618 * fi);
    float dA = TAU * F.w + 2.4 * fi;
    vec3 sp = vec3(y + uFlowR * cos(an) * vec2(cos(dA), sin(dA)), uFlowR * sin(an) + 3.7 * fi);
    vec4 n = snoiseD(sp);
    s += aw * n.x;
    g += aw * (transpose(M) * n.yz);
    y = OCT * y + vec2(1.7, -3.1);
    M = OCT * M;
    a *= uGain;
  }
  return vec3(s, g) * norm;
}

vec2 perp(vec2 v) { return vec2(-v.y, v.x); }

// advection: each pass moves the sample point along its own (twisted) noise
// velocity field in NSUB small Euler steps, so the map x -> a stays fold-free and
// filaments stretch and curl around eddies like marbling ink. The Jacobian
// da/dx is carried along exactly: J <- (I + h dv/da) J.
const int NSUB = 4;
vec3 field(vec2 x, out vec2 wOut, out vec3 ramp) {
  vec2 a = x;
  mat2 J = mat2(1.0);
  vec2 v = vec2(0.0);
  float h = uWarpAmt / float(NSUB);
  for (int k = 0; k < 4; k++) {
    if (k >= uIter) break;
    for (int s = 0; s < NSUB; s++) {
      vec3 f1 = fbm(a, 2 * k, uOctW, uOctNormW), f2 = fbm(a, 2 * k + 1, uOctW, uOctNormW);
      vec2 v0 = vec2(f1.x, f2.x);
      mat2 Jv = transpose(mat2(f1.yz, f2.yz));             // dv0/da, rows: grad v0.x, grad v0.y
      float al = uSwirl * (2.2 * v0.x - 1.3 * v0.y) + 0.6 * uSwirl * float(k + 1);
      vec2 ga = uSwirl * (2.2 * vec2(Jv[0][0], Jv[1][0]) - 1.3 * vec2(Jv[0][1], Jv[1][1]));
      float ca = cos(al), sa = sin(al);
      mat2 R = mat2(ca, sa, -sa, ca);
      vec2 pv = perp(v0);
      v = R * v0;
      Jv = R * (Jv + mat2(pv * ga.x, pv * ga.y));
      J = (mat2(1.0) + h * Jv) * J;
      a += h * v;
    }
  }
  vec3 f = fbm(a, ${N_FBM - 1}, float(uOct), uOctNorm);
  ramp = vec3(a.y, J[0][1], J[1][1]);
  wOut = v;
  return vec3(f.x, transpose(J) * f.yz);
}

vec3 bandColor(int k) {
  int n = max(uCount, 1);
  int i = k - (k / n) * n;
  if (i < 0) i += n;
  return uColors[i];
}

vec3 dbgOut;
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }

vec3 render(vec2 p) {
  vec2 x = uCam * p + uCamOff;
  vec2 w; vec3 Rm;
  vec3 F = field(x, w, Rm);
  // tanh ~ Gaussian CDF: flattens the field distribution so every colour gets a
  // similar share of the picture at bands = 1
  float g = tanh(4.5 * F.x);
  float u = (0.5 + 0.5 * g) * uBandK + Rm.x * uRampK + uBandO;
  vec2 gx = 0.5 * uBandK * 4.5 * (1.0 - g * g) * F.yz + uRampK * Rm.yz;
  vec2 gu = transpose(uCam) * gx;                            // grad u wrt p (normalized units)
  float gl = max(length(gu), 1e-6);
  float aaU = gl * uPxN;                                     // one pixel, in u
  if (uDebug == 1) dbgOut = vec3(0.5 + 0.5 * F.x);
  if (uDebug == 2) dbgOut = vec3(aaU, 0.0, 0.0);

  // nearest band boundary (integer u)
  float kb = floor(u + 0.5);
  float d = u - kb;                                          // [-0.5, 0.5], < 0: lower band
  float dn = d / gl;                                         // distance to the boundary, normalized units
  int ki = int(kb);
  vec3 c0 = bandColor(ki - 1), c1 = bandColor(ki);
  float tw = clamp(max(uSoft, aaU), 1e-4, 1.0);
  float tb = clamp(d / tw + 0.5, 0.0, 1.0);
  tb = mix(tb, tb * tb * (3.0 - 2.0 * tb), clamp(1.0 - uSoft, 0.0, 1.0));
  vec3 col = mix(c0, c1, tb);
  // bands narrower than ~a pixel: converge to the palette mean instead of aliasing
  col = mix(col, uAvg, smoothstep(0.35, 1.2, aaU));

  // lines / fringes fade out where bands get narrower than a couple of pixels
  float vis = 1.0 - smoothstep(0.18, 0.45, aaU);
  // the distance estimate d / |grad| is only trusted close to the boundary in band
  // units too (fine ripples make |grad| large deep inside a band -> ghost halos)
  float near = 1.0 - smoothstep(0.12, 0.4, abs(d));
  float ad = abs(dn);
  float aa = uPxN;
  if (vis > 0.0) {
    // marbling: line strength varies slowly along the boundaries
    float lm = 0.6 + 0.4 * smoothstep(-0.35, 0.35, w.x - 0.4 * w.y);
    if (uGlow > 0.0) {
      float gA = uGlow * 0.9 * exp(-ad / uGlowR) * lm * near;
      col = screen(col, uLine * clamp(gA, 0.0, 0.8) * vis);
    }
    if (uFringe > 0.0) {
      // misregistered copies of the line, shifted to either side (riso / RGB split)
      float fa = 1.0 - smoothstep(uFringeS - 0.5 * aa, uFringeS + 0.5 * aa, abs(dn + uFringeO));
      float fb = 1.0 - smoothstep(uFringeS - 0.5 * aa, uFringeS + 0.5 * aa, abs(dn - uFringeO));
      float fA = clamp(1.4 * uFringe, 0.0, 1.0);
      col = mix(col, screen(col, uFringeA), fA * fa * vis * near);
      col = mix(col, screen(col, uFringeB), fA * fb * vis * near);
    }
    if (uLines > 0.0) {
      float lc = 1.0 - smoothstep(uLineW - 0.5 * aa, uLineW + 0.5 * aa, ad);
      col = mix(col, uLine, clamp(min(1.0, 1.3 * uLines) * lc * (0.7 + 0.3 * lm), 0.0, 1.0) * vis);
    }
  }
  return col;
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
  vec3 dacc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    if (k >= uSS) break;
    // rotated-grid jitter
    vec2 o = uSS == 1 ? vec2(0.0)
           : uSS == 2 ? (k == 0 ? vec2(0.25, 0.25) : vec2(-0.25, -0.25))
           : (k == 0 ? vec2(0.125, 0.375) : k == 1 ? vec2(0.375, -0.125) : k == 2 ? vec2(-0.125, -0.375) : vec2(-0.375, 0.125));
    vec2 pp = apx + o;
    acc += render(vec2(pp.x - 0.5 * uFull.x, 0.5 * uFull.y - pp.y) / Smin);
    dacc += dbgOut;
  }
  vec2 p0 = vec2(apx.x - 0.5 * uFull.x, 0.5 * uFull.y - apx.y) / Smin;
  vec3 lin = acc / float(uSS) * uExpo;
  if (uDebug != 0) {
    vec3 dv = dacc / float(uSS);
    if (uDebug == 2) {
      // screen-space estimate of the band-coordinate change per pixel, for comparison
      vec2 xx = uCam * p0 + uCamOff; vec2 ww; vec3 rr;
      float uu = (0.5 + 0.5 * tanh(4.5 * field(xx, ww, rr).x)) * uBandK + rr.x * uRampK;
      float fd = length(vec2(dFdx(uu), dFdy(uu)));
      dv = vec3(dv.r, fd * uPxN * Smin, 0.0);
    }
    outColor = vec4(dv, 1.0);
    return;
  }
  // vignette towards paper
  vec2 e = p0 / uHalfExt;
  float vg = uVig * smoothstep(0.55, 1.55, length(e));
  lin = mix(lin, uPaper, vg);
  vec3 c = toSrgb(lin);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

  // riso speckle on an absolute grid (fraction of the short side)
  if (uGrain > 0.0) {
    vec2 gp = p0 / uGrainCell;
    uint gk = uGrainKey * 2654435761u;
    float n1 = vnoise(gp, gk + 11u);
    float n2 = vnoise(mat2(0.6, 0.8, -0.8, 0.6) * gp * 1.9 + 31.7, gk + 23u);
    float nl = 0.7 * n1 + 0.5 * n2;
    vec3 nc = vec3(vnoise(gp * 1.3 + vec2(5.1, 1.3), gk + 41u),
                   vnoise(gp * 1.3 + vec2(-2.7, 8.9), gk + 59u),
                   vnoise(gp * 1.3 + vec2(9.3, -4.1), gk + 73u));
    vec3 n = mix(vec3(nl), 0.45 * nl + 0.9 * nc, uGrainColor);
    n = sign(n) * pow(abs(n), vec3(0.75));                   // punchier salt and pepper
    float L = dot(c, vec3(0.299, 0.587, 0.114));
    float mid = 0.35 + 2.6 * L * (1.0 - L);
    c += uGrain * 0.6 * n * mid;
  }
  // triangular dither on the absolute output pixel
  ivec2 ip = ivec2(floor(apx));
  c += (hashF(ip, 0x5bd1e995u) + hashF(ip, 0x27d4eb2fu) - 1.0) / 255.0;
  outColor = vec4(c, 1.0);
}`;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const DEG = Math.PI / 180;
const BASE_FREQ = 0.85;

/** Hue rotation then saturation (CSS filter matrices), row-major 3x3. */
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
  return M;
}
const applyM = (M, v, o = 0) => [0, 1, 2].map((i) => Math.max(0, M[i][0] * v[o] + M[i][1] * v[o + 1] + M[i][2] * v[o + 2]));

export class MarbleRenderer {
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

    this.colorBuf = new Float32Array(MAX_COLORS * 3);
    this.fbmBuf = new Float32Array(N_FBM * 4);
    this.out = null; // { tex, fbo, w, h } RGBA8 for renderRegion
    this.scene = null;
  }

  /** Largest safe square tile for renderRegion (it also splits larger regions itself). */
  maxTile() {
    const L = this.limits;
    return Math.max(256, Math.min(4096, L.maxTex, L.maxRb, L.maxVp[0], L.maxVp[1]));
  }

  setScene(scene) {
    this.scene = scene;
  }

  /**
   * Render a w x h window (origin x, y: top-left, y down) of a full image laid out at
   * fullW x fullH into this.canvas (resized to w x h). ss: 1 | 2 | 4 samples per pixel.
   */
  draw({ P, t = 0, w, h, fullW = w, fullH = h, x = 0, y = 0, ss = 1 }) {
    if (!this.scene) throw new Error('MarbleRenderer: setScene() must be called before draw()');
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this._render(P, t, { x, y, w, h, fullW, fullH, flip: 0, ss });
  }

  /**
   * Same as draw() but into an offscreen target.
   * @returns {Uint8Array & {data: Uint8Array, channels: 4}} RGBA, tightly packed, top-down
   *   rows, w*h*4. The array also carries .data (itself) and .channels = 4, so it can be
   *   used directly as a poster-export tile ({ data, channels }) or as raw pixels.
   */
  renderRegion({ P, t = 0, fullW, fullH, x, y, w, h, ss = 1 }) {
    if (!this.scene) throw new Error('MarbleRenderer: setScene() must be called before renderRegion()');
    const cs = this.maxTile();
    let out;
    if (w <= cs && h <= cs) out = this._renderChunk(P, t, fullW, fullH, x, y, w, h, ss);
    else {
      out = new Uint8Array(w * h * 4);
      for (let cy = 0; cy < h; cy += cs) {
        for (let cx = 0; cx < w; cx += cs) {
          const cw = Math.min(cs, w - cx), ch = Math.min(cs, h - cy);
          const px = this._renderChunk(P, t, fullW, fullH, x + cx, y + cy, cw, ch, ss);
          for (let r = 0; r < ch; r++) out.set(px.subarray(r * cw * 4, (r + 1) * cw * 4), ((cy + r) * w + cx) * 4);
        }
      }
    }
    out.data = out;
    out.channels = 4;
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

  _render(P, t, job) {
    const gl = this.gl;
    const U = this.U;
    const sc = this.scene;
    const loop = Math.max(1e-3, num(P.loopSeconds, 16));
    // loop phase in [0, 1): t = 0 and t = loopSeconds give bit-identical frames
    let tau = num(t, 0) / loop;
    tau -= Math.floor(tau);
    if (tau >= 1) tau = 0;
    const ss = job.ss === 4 ? 4 : job.ss === 2 ? 2 : 1;
    const S = Math.min(job.fullW, job.fullH);
    const ph = sc.phases || new Float32Array(32);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(U.uOrigin, job.x, job.y);
    gl.uniform2f(U.uSize, job.w, job.h);
    gl.uniform2f(U.uFull, job.fullW, job.fullH);
    gl.uniform1i(U.uFlipY, job.flip);
    gl.uniform1i(U.uSS, ss);
    gl.uniform2f(U.uHalfExt, 0.5 * job.fullW / S, 0.5 * job.fullH / S);

    // camera: p -> field space (BASE_FREQ noise cells per short side at scale 1)
    const zoom = clamp(num(P.zoom, 1), 0.05, 50);
    const scale = clamp(num(P.scale, 1), 0.05, 20);
    const k = BASE_FREQ * scale / zoom;
    const stretch = clamp(num(P.stretch, 0.3), 0, 1);
    const ang = num(P.angle, 20) * DEG;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // rotate into the stretch frame (x' along angle), squash frequency along it
    const sx = 1 - 0.72 * stretch, sy = 1 + 0.25 * stretch;
    // M = diag(sx, sy) * Rot(-ang) * k   (row-major)
    const m00 = sx * ca * k, m01 = sx * sa * k, m10 = -sy * sa * k, m11 = sy * ca * k;
    gl.uniformMatrix2fv(U.uCam, false, new Float32Array([m00, m10, m01, m11]));
    // pan in image units (offset fraction of the short side, before zoom)
    const ox = num(P.offsetX, 0) * BASE_FREQ * scale, oy = num(P.offsetY, 0) * BASE_FREQ * scale;
    gl.uniform2f(U.uCamOff, sx * (ca * ox + sa * oy), sy * (-sa * ox + ca * oy));

    // per-fbm seeded offsets
    const F = this.fbmBuf;
    for (let j = 0; j < N_FBM; j++) {
      F[j * 4] = (ph[(j * 2) % 32] - 0.5) * 200;
      F[j * 4 + 1] = (ph[(j * 2 + 1) % 32] - 0.5) * 200;
      F[j * 4 + 2] = ph[(18 + j) % 32];
      F[j * 4 + 3] = ph[(27 + j) % 32] + j * 0.137;
    }
    gl.uniform4fv(U.uFbm, F);
    gl.uniform1f(U.uTheta, 2 * Math.PI * tau);
    gl.uniform1f(U.uFlowR, 0.035 * clamp(num(P.flow, 1), 0, 3));
    const oct = clamp(Math.round(num(P.detail, 5)), 1, 8);
    const gain = clamp(num(P.roughness, 0.5), 0.05, 0.95);
    // the warps stay smooth (1 octave at detail <= 5, a faded 2nd above):
    // smooth, large displacements read as liquid folds, rough ones as crumpled paper
    const octW = 1 + Math.max(0, oct - 5) * 0.33;
    const asum = (o) => { let s = 0; for (let i = 0, a = 1; i < o; i++, a *= gain) s += a * Math.min(o - i, 1); return s; };
    gl.uniform1i(U.uOct, oct);
    gl.uniform1f(U.uOctW, octW);
    gl.uniform1f(U.uGain, gain);
    gl.uniform1f(U.uOctNorm, 1 / asum(oct));
    gl.uniform1f(U.uOctNormW, 1 / asum(octW));
    // advection stretches exponentially with displacement: compress the warp slider
    // above its default and spread a similar total over more passes, so the top of
    // the range is wild but still reads as marbling rather than sub-pixel mush
    const iter = clamp(Math.round(num(P.warpIterations, 2)), 1, 4);
    const warp = clamp(num(P.warp, 1.4), 0, 8);
    gl.uniform1i(U.uIter, iter);
    const swirl = clamp(num(P.swirl, 0.5), 0, 4);
    gl.uniform1f(U.uWarpAmt, 1.54 * Math.pow(warp / 1.4, warp > 1.4 ? 0.6 : 1) * Math.pow(2 / iter, 0.35)
      / ((1 + 0.5 * (octW - 1)) * (1 + 0.15 * Math.max(0, swirl - 0.5))));   // rougher / twistier flows stretch faster
    gl.uniform1f(U.uSwirl, swirl);

    // colours (hue / saturation applied to the palette and accents, linear)
    const M = colorMatrix(num(P.hueShift, 0), clamp(num(P.saturation, 1), 0, 3));
    const n = clamp(sc.colorCount | 0, 1, MAX_COLORS);
    const C = this.colorBuf;
    for (let i = 0; i < MAX_COLORS; i++) C.set(applyM(M, sc.colors, Math.min(i, n - 1) * 3), i * 3);
    gl.uniform3fv(U.uColors, C);
    const avg = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) avg[c] += C[i * 3 + c] / n;
    gl.uniform3fv(U.uAvg, avg);
    gl.uniform1i(U.uCount, n);
    gl.uniform3fv(U.uLine, applyM(M, sc.line));
    gl.uniform3fv(U.uFringeA, applyM(M, sc.fringeA));
    gl.uniform3fv(U.uFringeB, applyM(M, sc.fringeB));
    gl.uniform3fv(U.uPaper, applyM(M, sc.paper));
    const bands = clamp(num(P.bands, 1), 0.01, 64);
    // bands = palette cycles across the (flattened) field range
    gl.uniform1f(U.uBandK, bands * n);
    gl.uniform1f(U.uRampK, 1.5 * stretch * bands * n);
    gl.uniform1f(U.uBandO, num(P.colorOffset, 0) * n + 0.5);
    gl.uniform1f(U.uSoft, Math.pow(1 - clamp(num(P.bandSharpness, 0.85), 0, 1), 1.5));

    // lines, fringes, glow: sizes in short-side units
    const lw = clamp(num(P.lineWidth, 0.6), 0, 10);
    gl.uniform1f(U.uLines, lw > 0 ? clamp(num(P.lines, 0.7), 0, 1) : 0);
    gl.uniform1f(U.uLineW, lw * 0.003);
    const fw = clamp(num(P.fringeWidth, 1), 0, 10);
    gl.uniform1f(U.uFringe, fw > 0 ? clamp(num(P.fringe, 0.6), 0, 1) : 0);
    gl.uniform1f(U.uFringeO, fw * 0.0018);                   // shift of the fringe copies
    gl.uniform1f(U.uFringeS, lw * 0.003 * 0.8);              // their half width (~ the line's)
    const glow = clamp(num(P.glow, 0.3), 0, 1);
    gl.uniform1f(U.uGlow, glow);
    gl.uniform1f(U.uGlowR, 0.002 + 0.006 * glow + lw * 0.002);
    gl.uniform1f(U.uPxN, 1 / (S * Math.sqrt(ss)));

    // look
    gl.uniform1f(U.uExpo, Math.pow(2, clamp(num(P.exposure, 0), -4, 4)));
    gl.uniform1f(U.uVig, clamp(num(P.vignette, 0.15), 0, 1));
    gl.uniform1f(U.uContrast, clamp(num(P.contrast, 1), 0, 4));

    // grain: cell = grainSize * 1.8 / 1000 of the short side; re-keyed 24x per second of
    // loop time (wraps with the loop) when animated
    gl.uniform1f(U.uGrain, clamp(num(P.grain, 0.45), 0, 1));
    gl.uniform1f(U.uGrainCell, clamp(num(P.grainSize, 0.8), 0.05, 50) * 0.0018);
    gl.uniform1f(U.uGrainColor, clamp(num(P.grainColor, 0.5), 0, 1));
    const seedKey = Math.floor((ph[31] || 0) * 65536);
    const frame = P.grainAnimate === false ? 0 : Math.floor(tau * loop * 24);
    gl.uniform1ui(U.uGrainKey, (seedKey * 7919 + frame) >>> 0);

    gl.uniform1i(U.uDebug, num(P.debug, 0) | 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _ensureTarget(t, w, h) {
    if (t && t.w >= w && t.h >= h) return t;
    const gl = this.gl;
    const W = Math.max(w, t ? t.w : 0), H = Math.max(h, t ? t.h : 0);
    this._freeTarget(t);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('MarbleRenderer: framebuffer incomplete (' + st + ')');
    return { tex, fbo, w: W, h: H };
  }
  _freeTarget(t) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
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
    gl.deleteBuffer(this.vbuf); gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
