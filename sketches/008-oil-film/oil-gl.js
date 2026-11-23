// oil-gl.js
// WebGL2 renderer for the oil film sketch: an iridescent thin-film / oil-slick look.
// A smooth scalar "film thickness" field, heavily domain-warped (iq's nested fbm
// warp f(p + k fbm(p + k fbm(p)))) into flowing silk-like folds, with sharp crease
// lines where a fold term (|.|) on the innermost warp folds the domain over itself.
// Thickness runs through a continuous cyclic colour ramp; the steepness of the field
// decides where the bright interference bands show and where the film stays dark.
// One full-screen fragment shader, no extra passes.
//
// Every pixel is a pure function of (normalized position, loop phase, params, scene),
// so preview, 100% loupe, tiled poster export and video frames agree:
//   p = ((pixel + 0.5) - full / 2) / min(fullW, fullH), y up.
//
// Per sample:
//   1. camera (zoom / pan / scale) and an anisotropic squash along P.angle
//      (P.stretch) map p to field space x.
//   2. nested warp, P.warpIterations levels: w0 = 0, w_{l+1} = fbm2_l(x + k w_l), the
//      innermost level folded w -> mix(w, 2 (|w|_soft - c), P.crease) so its zero
//      curves become creases. thickness h = fbm(x + k w_L).
//      The plateau darkening uses a second Jacobian chain that ignores the fold's
//      sign flip, so creases stay bright instead of picking up dark hairlines. Every noise call returns
//      an exact analytic gradient and the Jacobians are chained, so |grad h| (per
//      short side) is exact: no dFdx, identical across tiles, crops and supersampling.
//      Motion: every octave samples 3D simplex noise along a loop-periodic circle
//      (radius ~ P.flow), so t and t + loopSeconds are bit-identical.
//   3. colour: s = h * rampFreq + rampPhase; inside each cycle the first `plateau`
//      fraction holds colour 0 (the dark film), the rest runs through the cyclic
//      ramp c0 -> c1 -> ... -> c(n-1) -> c0 (closed Catmull-Rom spline in sRGB: no hard bands).
//      Where the field is flat (steepness from the sign-free Jacobian chain) the ramp is
//      pulled towards colour 0 (P.gradInfluence),
//      so flat regions read as dark plateaus and steep regions (near creases) as
//      tightly packed bright bands. Bands thinner than a pixel fade to the mean ramp
//      colour (analytic band frequency) instead of aliasing.
//   4. gloss: a fake normal from grad h, Blinn-Phong highlight.
//   5. exposure, vignette (towards colour 0) in linear light; encode sRGB, contrast;
//      optional static grain; triangular dither.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_COLORS = 8;
const N_FBM = 8; // 2 per warp level (max 3), 6 = thickness

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
uniform vec4 uFbm[${N_FBM}];  // per noise field: offset xy, circle phase (turns), circle direction (turns)
uniform float uTheta;      // 2 pi * loop phase
uniform float uFlowR;      // circle radius, noise units
uniform int uIter;         // warp levels
uniform int uOct;          // octaves
uniform int uWOct;         // octaves of the warp fields
uniform float uGain;       // fbm gain
uniform float uWarpK;      // warp strength k
uniform float uCrease;     // fold amount of the innermost warp
uniform float uCreaseE;    // softness of the fold (noise units)
uniform float uAsym;       // 0 = symmetric fold (ridge), 1 = one-sided fold (drape edge)
uniform float uSweep;      // linear thickness slope across the field

uniform vec3 uCol[${MAX_COLORS}];  // cyclic ramp (sRGB-encoded, colour-matrixed)
uniform int uColN;
uniform vec3 uAvg;         // mean film colour over a cycle (incl. plateau), linear
uniform vec3 uDark;        // colour 0 (plateau), linear
uniform float uRampF, uRampPh, uPlateau, uGradInfl, uGradRef, uGloss;
uniform float uPxN;        // pixel footprint, normalized units
uniform vec2 uHalfExt;     // half image extents, normalized units
uniform float uVig;
uniform float uExpo, uContrast, uGrain;
uniform uint uGrainKey;
uniform int uDebug;        // dev only: 1 = thickness, 2 = log2(|grad h| / ref) / 8 + 0.5, 3 = crease fold, 4 = ramp strip
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

// ------------------------------------------------------------------ fields
const float TAU = 6.28318530718;
// octave rotation (~36.9 deg) times lacunarity 2.03
const mat2 OCT = mat2(0.8, 0.6, -0.6, 0.8) * 2.03;

// loop-periodic fbm j at point x -> (value, d/dx, d/dy), value ~ [-1, 1]
vec3 fbm(vec2 x, int j, int oct, float gain) {
  vec4 F = uFbm[j];
  vec2 y = x + F.xy;
  mat2 M = mat2(1.0);
  float a = 1.0, s = 0.0, an_ = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float fi = float(i);
    // loop-periodic circle through the noise volume: integer cycles per loop
    float cyc = i < 2 ? 1.0 : 2.0;
    float an = cyc * uTheta + TAU * (F.z + 0.618 * fi);
    float dA = TAU * F.w + 2.4 * fi;
    float R = uFlowR / (1.0 + 0.5 * fi);
    vec3 sp = vec3(y + R * cos(an) * vec2(cos(dA), sin(dA)), R * sin(an) + 3.7 * fi);
    vec4 n = snoiseD(sp);
    s += a * n.x;
    g += a * (transpose(M) * n.yz);
    an_ += a;
    y = OCT * y + vec2(1.7, -3.1);
    M = OCT * M;
    a *= gain;
  }
  return vec3(s, g) / an_;
}

float creaseDbg;
vec2 gradU;   // gradient of h with the fold's sign flip ignored (smooth across creases)

// thickness h and its gradient wrt field space x
vec3 thickness(vec2 x) {
  vec2 w = vec2(0.0);
  mat2 Jw = mat2(0.0), JwU = mat2(0.0);
  creaseDbg = 0.0;
  for (int l = 0; l < 3; l++) {
    if (l >= uIter) break;
    vec2 y = x + uWarpK * w;
    mat2 J = mat2(1.0) + uWarpK * Jw;
    mat2 JU = mat2(1.0) + uWarpK * JwU;
    vec3 n1 = fbm(y, 2 * l, uWOct, uGain), n2 = fbm(y, 2 * l + 1, uWOct, uGain);
    w = vec2(n1.x, n2.x);
    mat2 G = transpose(mat2(n1.yz, n2.yz));   // rows = gradients wrt y
    Jw = G * J;
    JwU = G * JU;
    if (l == 0 && uCrease > 0.0) {
      // fold: |w| (softened) -> the zero curves of w become creases downstream
      vec2 sa = sqrt(w * w + uCreaseE * uCreaseE);
      // symmetric fold 2(|w| - c) (a ridge, mirrored bands) blended with a one-sided
      // fold |w| + w - c (flat on one side, slope 2 on the other: a drape-like edge
      // where the bands bunch up on one side and grade smoothly on the other)
      vec2 fw = mix(2.0 * (sa - 0.32), sa + w - 0.3, uAsym);
      vec2 dfw = mix(2.0 * w / sa, w / sa + 1.0, uAsym);
      creaseDbg = 1.0 - smoothstep(0.0, 3.0 * uCreaseE, min(abs(w.x), abs(w.y)));
      w = mix(w, fw, uCrease);
      vec2 d = mix(vec2(1.0), dfw, uCrease);
      Jw = mat2(d.x, 0.0, 0.0, d.y) * Jw;
      // steepness path: the fold's slope magnitude without its sign flip / zero at the
      // crease, so the plateau darkening does not draw dark hairlines along creases
      JwU = (1.0 + uCrease * (1.0 - 0.5 * uAsym)) * JwU;
    }
  }
  vec2 y = x + uWarpK * w;
  mat2 J = mat2(1.0) + uWarpK * Jw;
  mat2 JU = mat2(1.0) + uWarpK * JwU;
  vec3 f = fbm(y, 6, uOct, uGain);
  // sweep: a gentle linear slope across the (warped) field, so the thickness has few
  // closed extrema and the bands run as long folded S-curves instead of rings
  vec2 g = f.yz + vec2(0.0, uSweep);
  gradU = transpose(JU) * g;
  return vec3(f.x + uSweep * y.y, transpose(J) * g);
}

// cyclic ramp: v in [0, 1) -> c0 .. c(n-1) -> c0, a closed Catmull-Rom spline through
// the slots (gamma-encoded, so dark -> bright falls off perceptually evenly; no flat
// steps at the slots, no kinks between them)
vec3 colAt(int i) { return uCol[(i + 2 * uColN) % uColN]; }
vec3 rampColor(float v) {
  float x = fract(v) * float(uColN);
  int i = min(int(floor(x)), uColN - 1);
  float f = x - float(i);
  vec3 p0 = colAt(i - 1), p1 = colAt(i), p2 = colAt(i + 1), p3 = colAt(i + 2);
  float f2 = f * f, f3 = f2 * f;
  vec3 c = 0.5 * ((2.0 * p1) + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (3.0 * p1 - p0 + p3 - 3.0 * p2) * f3);
  return clamp(c, 0.0, 1.0);
}
// film colour for thickness coordinate s: plateau (colour 0), then the cyclic ramp
vec3 filmColor(float s) {
  float u = fract(s);
  if (u < uPlateau) return uCol[0];
  return rampColor((u - uPlateau) / max(1.0 - uPlateau, 1e-4));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 dbgOut;

vec3 render(vec2 p) {
  vec2 x = uCam * p + uCamOff;
  vec3 th = thickness(x);
  vec2 gp = transpose(uCam) * th.yz;          // wrt p (per short side)
  float G = length(gp);
  float gn = length(transpose(uCam) * gradU) / uGradRef;   // steepness (smooth across creases)

  if (uDebug == 1) dbgOut = vec3(0.5 + 0.5 * th.x);
  if (uDebug == 2) dbgOut = vec3(clamp(0.5 + log2(max(gn, 1e-6)) / 8.0, 0.0, 1.0), 0.0, 0.0);
  if (uDebug == 3) dbgOut = vec3(clamp(creaseDbg, 0.0, 1.0));
  if (uDebug == 4) dbgOut = filmColor(p.x + 0.5);   // one ramp cycle across the short side (sRGB)

  // film colour (gamma-encoded ramp -> linear)
  float s = th.x * uRampF + uRampPh;
  vec3 c = toLinear(filmColor(s));
  // bands narrower than ~a pixel: fade to the cycle mean (analytic band frequency)
  float bpp = uRampF * G * uPxN;
  c = mix(c, uAvg, smoothstep(0.25, 0.9, bpp));
  // flat film -> dark plateau colour
  float m = smoothstep(0.08, 0.9, gn);
  c = mix(uDark, c, mix(1.0, m, uGradInfl));

  // gloss: fake normal from the thickness gradient
  if (uGloss > 0.0) {
    vec3 n = normalize(vec3(-gp * 0.018, 1.0));
    vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float sp = pow(max(dot(n, H), 0.0), 40.0);
    float sheen = pow(1.0 - n.z, 2.0);
    c += uGloss * (1.6 * sp + 0.3 * sheen) * mix(vec3(1.0), 0.5 + c, 0.4);
  }
  return c;
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
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
  if (uDebug != 0) { outColor = vec4(dacc / float(uSS), 1.0); return; }
  vec3 lin = acc / float(uSS) * uExpo;
  // vignette towards the plateau colour
  vec2 e = p0 / uHalfExt;
  lin = mix(lin, uDark, uVig * smoothstep(0.55, 1.55, length(e)));
  vec3 c = toSrgb(lin);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  if (uGrain > 0.0) {
    // static fine grain on an absolute grid (fraction of the short side)
    vec2 gp = p0 / 0.0012;
    float n = 0.7 * vnoise(gp, uGrainKey + 11u) + 0.5 * vnoise(mat2(0.6, 0.8, -0.8, 0.6) * gp * 1.9 + 31.7, uGrainKey + 23u);
    float L = dot(c, vec3(0.299, 0.587, 0.114));
    c += uGrain * 0.25 * n * (0.35 + 2.6 * L * (1.0 - L));
  }
  // triangular dither on the absolute output pixel
  ivec2 ip = ivec2(floor(apx));
  c += (hashF(ip, 0x5bd1e995u) + hashF(ip, 0x27d4eb2fu) - 1.0) / 255.0;
  outColor = vec4(c, 1.0);
}`;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const DEG = Math.PI / 180;
const BASE_FREQ = 0.44;
// typical |grad h| per short side at scale 1 / zoom 1 (measured with debug=2), per unit kf
const GRAD_NORM = 8.0;

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
const applyM = (M, v) => [0, 1, 2].map((i) => Math.max(0, M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]));

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hexToLinear(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => s2l(v / 255));
}

const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** Same closed Catmull-Rom spline as the shader's rampColor (v in [0, 1)). */
function catmull(cols, v) {
  const n = cols.length, x = (v - Math.floor(v)) * n;
  const i = Math.min(Math.floor(x), n - 1), f = x - i, f2 = f * f, f3 = f2 * f;
  const at = (j) => cols[((j % n) + n) % n];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  return [0, 1, 2].map((k) => Math.min(1, Math.max(0, 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * f
    + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (3 * p1[k] - p0[k] + p3[k] - 3 * p2[k]) * f3))));
}

export class OilRenderer {
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

    this.colBuf = new Float32Array(MAX_COLORS * 3);
    this.fbmBuf = new Float32Array(N_FBM * 4);
    this.out = null; // { tex, fbo, w, h } RGBA8 for renderRegion
    this.scene = null;
    this._colKey = '';
    this._colCache = null;
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
    if (!this.scene) throw new Error('OilRenderer: setScene() must be called before draw()');
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
    if (!this.scene) throw new Error('OilRenderer: setScene() must be called before renderRegion()');
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

  /** Palette slots -> colour-matrixed linear colours + cycle mean (cached by key). */
  _colors(P) {
    const n = clamp(Math.round(num(P.colorCount, 7)), 2, MAX_COLORS);
    const hexes = [];
    for (let i = 0; i < n; i++) hexes.push(P[`c${i}`] || '#000000');
    const hue = num(P.hueShift, 0), sat = clamp(num(P.saturation, 1), 0, 3);
    const plateau = clamp(num(P.plateau, 0.3), 0, 0.95);
    const key = `${hexes.join(',')}|${hue}|${sat}|${plateau}`;
    if (key === this._colKey) return this._colCache;
    const M = colorMatrix(hue, sat);
    const lins = hexes.map((hx) => applyM(M, hexToLinear(hx)));
    const cols = lins.map((c) => c.map((v) => l2s(Math.min(1, v)))); // the shader interpolates in sRGB
    // mean film colour over one cycle (linear): plateau share of c0 + the ramp, sampled
    const avg = [0, 0, 0];
    const N = 64 * n;
    for (let j = 0; j < N; j++) {
      const c = catmull(cols, (j + 0.5) / N).map(s2l);
      for (let k = 0; k < 3; k++) avg[k] += c[k] / N;
    }
    for (let k = 0; k < 3; k++) avg[k] = plateau * lins[0][k] + (1 - plateau) * avg[k];
    const buf = this.colBuf;
    for (let i = 0; i < MAX_COLORS; i++) buf.set(cols[Math.min(i, n - 1)], i * 3);
    this._colKey = key;
    this._colCache = { n, avg, dark: lins[0], buf };
    return this._colCache;
  }

  _render(P, t, job) {
    const gl = this.gl;
    const U = this.U;
    const sc = this.scene;
    const loop = Math.max(1e-3, num(P.loopSeconds, 20));
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
    gl.uniform2f(U.uHalfExt, job.fullW / S / 2, job.fullH / S / 2);

    // camera: p -> field space (BASE_FREQ noise cells per short side at scale 1)
    const zoom = clamp(num(P.zoom, 1), 0.05, 50);
    const scale = clamp(num(P.scale, 1), 0.05, 20);
    const kf = BASE_FREQ * scale;
    const k = kf / zoom;
    const stretch = clamp(num(P.stretch, 0.35), 0, 1);
    const ang = num(P.angle, 70) * DEG;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // rotate into the stretch frame (x' along angle), squash frequency along it
    const sx = 1 - 0.72 * stretch, sy = 1 + 0.25 * stretch;
    const m00 = sx * ca * k, m01 = sx * sa * k, m10 = -sy * sa * k, m11 = sy * ca * k;
    gl.uniformMatrix2fv(U.uCam, false, new Float32Array([m00, m10, m01, m11]));
    const ox = num(P.offsetX, 0) * kf, oy = num(P.offsetY, 0) * kf;
    gl.uniform2f(U.uCamOff, sx * (ca * ox + sa * oy), sy * (-sa * ox + ca * oy));

    const F = this.fbmBuf;
    for (let j = 0; j < N_FBM; j++) {
      F[j * 4] = (ph[(j * 2) % 32] - 0.5) * 200;
      F[j * 4 + 1] = (ph[(j * 2 + 1) % 32] - 0.5) * 200;
      F[j * 4 + 2] = ph[(18 + j) % 32];
      F[j * 4 + 3] = ph[(26 + j) % 32] + j * 0.137;
    }
    gl.uniform4fv(U.uFbm, F);
    gl.uniform1f(U.uTheta, 2 * Math.PI * tau);
    gl.uniform1f(U.uFlowR, 0.05 * clamp(num(P.flow, 1), 0, 3));

    const iter = clamp(Math.round(num(P.warpIterations, 2)), 1, 3);
    gl.uniform1i(U.uIter, iter);
    const oct = clamp(Math.round(num(P.octaves, 4)), 1, 6);
    gl.uniform1i(U.uOct, oct);
    gl.uniform1i(U.uWOct, clamp(Math.round(num(P.dbgWOct, Math.min(oct, 2))), 1, 6));
    gl.uniform1f(U.uGain, num(P.dbgGain, 0.4));
    gl.uniform1f(U.uWarpK, clamp(num(P.warp, 1.6), 0, 6));
    gl.uniform1f(U.uCrease, clamp(num(P.crease, 0.55), 0, 1));
    gl.uniform1f(U.uAsym, clamp(num(P.creaseAsym, 0.7), 0, 1));
    gl.uniform1f(U.uSweep, 0.6 * clamp(num(P.sweep, 0.5), 0, 2));
    gl.uniform1f(U.uCreaseE, 0.005 + 0.12 * clamp(num(P.creaseSoft, 0.5), 0, 1));

    const C = this._colors(P);
    gl.uniform3fv(U.uCol, C.buf);
    gl.uniform1i(U.uColN, C.n);
    gl.uniform3fv(U.uAvg, C.avg);
    gl.uniform3fv(U.uDark, C.dark);
    gl.uniform1f(U.uRampF, clamp(num(P.rampFreq, 2.2), 0, 40));
    gl.uniform1f(U.uRampPh, num(P.rampPhase, 0));
    gl.uniform1f(U.uPlateau, clamp(num(P.plateau, 0.3), 0, 0.95));
    gl.uniform1f(U.uGradInfl, clamp(num(P.gradInfluence, 0.55), 0, 1));
    gl.uniform1f(U.uGradRef, GRAD_NORM * k);
    gl.uniform1f(U.uGloss, clamp(num(P.gloss, 0.12), 0, 2));
    gl.uniform1f(U.uPxN, 1 / (S * Math.sqrt(ss)));
    gl.uniform1f(U.uVig, clamp(num(P.vignette, 0.2), 0, 1));

    gl.uniform1f(U.uExpo, Math.pow(2, clamp(num(P.exposure, 0), -4, 4)));
    gl.uniform1f(U.uContrast, clamp(num(P.contrast, 1), 0, 4));
    gl.uniform1f(U.uGrain, clamp(num(P.grain, 0), 0, 1));
    gl.uniform1ui(U.uGrainKey, (Math.floor((ph[31] || 0) * 65536) * 7919) >>> 0);

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
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('OilRenderer: framebuffer incomplete (' + st + ')');
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
