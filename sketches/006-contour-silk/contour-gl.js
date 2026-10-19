// contour-gl.js
// WebGL2 renderer for the contour silk sketch: hundreds of hairline contour lines
// of a warped, advected height field on a dark ground; where the lines bunch up
// the picture brightens through cream into peach / orange creases; a few empty
// flat "rivers" (ribbons) cut through, lined by bright creases. One full-screen
// fragment shader, no extra passes.
//
// Every pixel is a pure function of (normalized position, loop phase, params,
// scene), so preview, 100% loupe, tiled poster export and video frames agree:
//   p = ((pixel + 0.5) - full / 2) / min(fullW, fullH), y up.
//
// Per sample:
//   1. camera (zoom / pan / scale) and an anisotropic squash along P.angle
//      (P.stretch) map p to field space x (as 004).
//   2. advection (as 004): P.warpIterations passes, each moving the sample point a
//      in 4 small Euler steps along a twisted smooth noise velocity field (P.warp).
//      The Jacobian da/dx is carried exactly, so every field below has an exact
//      analytic gradient wrt p (no screen-space derivatives): line widths and
//      anti-aliasing are identical across tiles, crops and supersampling.
//      Motion: every noise octave samples 3D simplex noise along a loop-periodic
//      circle (radius ~ P.flow), so t and t + loopSeconds are bit-identical.
//   3. height field (in "line units", lines at integer u):
//        H = ramp(a.y) + A fbm(a) + F soft|fbm2(a)|
//      the ramp across the stretch direction combs the contours into long sweeping
//      parallel lines, the fbm bumps close them into elongated loops around local
//      extrema, the soft-abs fold kinks them into cusps / chevrons; the advection
//      compresses whole bundles of lines into dense creases.
//      Ribbons: a separate low-frequency field r (not advected) gives meandering
//      zero curves; |r| (scaled to distance) < a tapering half width = empty ribbon
//      (lens-shaped where the width modulation fades out). Outside, H gets a term
//      S * (-L exp(-e / L)) of the edge distance e, which dominates the gradient
//      near the edge: the contours run parallel to the ribbon and bunch up along it
//      into a bright crease.
//      P.lineJitter warps u -> u + j(u) (smooth, monotonic) for irregular spacing.
//      P.families = 2 adds a second line family over the same advected domain
//      (ramp rotated ~55 deg, own fbm) -> mesh / moire.
//   4. line coverage: the periodic line pattern (width W = lineWidth * 0.002 of the
//      short side) is integrated exactly against a tent filter of one pixel
//      footprint in u (second antiderivative of the pulse train, locally linear
//      u). Sparse lines come out as crisp anti-aliased hairlines; where lines get
//      closer than a pixel the same formula converges to the mean coverage
//      W * density, so dense bundles fill smoothly instead of aliasing.
//   5. colour = f(density) with density = |grad u| / (typical density): the line
//      colour runs along [scene.line, ramp[1..]] (cool -> white -> warm, up to
//      P.warmth of the warm end), line opacity rises from P.lineOpacity to 1, and a
//      soft additive glow follows a lower density threshold (P.glow). Ribbons are
//      filled with scene.ribbon, edged by a hairline crease (P.ribbonEdge).
//   6. exposure in linear light; encode sRGB, contrast; optional static grain;
//      triangular dither.
//
// Cost at defaults (warpIterations 2, families 1): ~22 simplex-noise evaluations
// per sample (16 advection, 3 + 2 height, 1 + 1 ribbon) — about the same as 004.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_RAMP = 8;
const N_FBM = 14; // 0..7 advection (2 per pass, max 4), 8 height, 9 cliffs, 10 family 2, 11 ribbon, 12 ribbon width, 13 cliff envelope

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
uniform int uIter;         // advection passes
uniform float uWarpAmt;    // displacement per pass per unit noise
uniform float uSwirl;      // twist of the velocity field

uniform float uLineK;      // field units -> line units (u)
uniform float uRampK;      // ramp slope (field units)
uniform float uAmpA;       // fbm bump amplitude
uniform float uCliff;      // crease (cliff) height, field units
uniform float uCliffEps;   // crease sharpness (field value units of the cliff noise)
uniform int uFam;          // line families (1, 2)
uniform float uJitter;     // level jitter amount
uniform float uJitPh;      // level jitter phase
uniform float uDensRef;    // typical |grad u| (lines per short side) -> density 1
uniform float uLineW;      // line width, normalized units
uniform float uPxN;        // tent filter half width, normalized units

uniform float uRib;        // ribbon strength (0 = none)
uniform float uRibFreq;    // ribbon field frequency (field units)
uniform float uRibDist;    // r -> approx distance (normalized units)
uniform float uRibW;       // max ribbon half width, normalized units
uniform float uRibBias;    // ribbon width modulation bias (coverage)
uniform float uRibS;       // edge attraction slope, line units per normalized unit
uniform float uRibL;       // edge attraction decay length, normalized units
uniform float uRibEdge;    // edge crease brightness

uniform vec3 uGround, uRibbon;
uniform vec3 uSeq[${MAX_RAMP}];  // line colour sequence by density (linear, colour-matrixed)
uniform int uSeqN;
uniform float uSeqMax;     // max position along the sequence (warmth), 0..1
uniform float uOpacity, uDensGain, uGlow;
uniform float uExpo, uContrast, uGrain;
uniform uint uGrainKey;
uniform int uDebug;        // dev only: 1 = height field, 2 = |grad u| analytic (r) vs screen-space (g), 3 = density / 8
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

// fbm j at point x -> (value, d/dx, d/dy), value ~ [-1, 1]; oct <= 4 octaves, gain
vec3 fbm(vec2 x, int j, int oct, float gain) {
  vec4 F = uFbm[j];
  vec2 y = x + F.xy;
  mat2 M = mat2(1.0);
  float a = 1.0, s = 0.0, an_ = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    float fi = float(i);
    // loop-periodic circle through the noise volume: integer cycles per loop
    float cyc = i < 2 ? 1.0 : 2.0;
    float an = cyc * uTheta + TAU * (F.z + 0.618 * fi);
    float dA = TAU * F.w + 2.4 * fi;
    vec3 sp = vec3(y + uFlowR * cos(an) * vec2(cos(dA), sin(dA)), uFlowR * sin(an) + 3.7 * fi);
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

vec2 perp(vec2 v) { return vec2(-v.y, v.x); }

// advection as in 004: small Euler steps along a twisted noise velocity field,
// Jacobian da/dx carried exactly (J <- (I + h dv/da) J).
uniform int uSub;
vec2 advect(vec2 x, out mat2 J) {
  vec2 a = x;
  J = mat2(1.0);
  float h = uWarpAmt / float(uSub);
  for (int k = 0; k < 4; k++) {
    if (k >= uIter) break;
    for (int s = 0; s < 4; s++) {
      if (s >= uSub) break;
      vec3 f1 = fbm(a, 2 * k, 1, 0.5), f2 = fbm(a, 2 * k + 1, 1, 0.5);
      vec2 v0 = vec2(f1.x, f2.x);
      mat2 Jv = transpose(mat2(f1.yz, f2.yz));
      float al = uSwirl * (2.2 * v0.x - 1.3 * v0.y) + 0.6 * uSwirl * float(k + 1);
      vec2 ga = uSwirl * (2.2 * vec2(Jv[0][0], Jv[1][0]) - 1.3 * vec2(Jv[0][1], Jv[1][1]));
      float ca = cos(al), sa = sin(al);
      mat2 R = mat2(ca, sa, -sa, ca);
      vec2 pv = perp(v0);
      vec2 v = R * v0;
      Jv = R * (Jv + mat2(pv * ga.x, pv * ga.y));
      J = (mat2(1.0) + h * Jv) * J;
      a += h * v;
    }
  }
  return a;
}

// smooth monotonic level jitter: u -> u + j(u), returns (u', du'/du)
vec2 jitter(float u) {
  if (uJitter <= 0.0) return vec2(u, 1.0);
  float k = uJitter * 0.38;
  float a1 = TAU * 0.371 * u + uJitPh, a2 = TAU * 0.137 * u + 2.1 * uJitPh;
  return vec2(u + k * (0.6 * sin(a1) + 0.4 * sin(a2)),
              1.0 + k * TAU * (0.6 * 0.371 * cos(a1) + 0.4 * 0.137 * cos(a2)));
}

// second antiderivative of the pulse train (pulses [n, n + w] in v)
float C2(float v, float w) {
  float n = floor(v), f = v - n;
  float G = f < w ? 0.5 * f * f : w * f - 0.5 * w * w;
  return w * n * (n - 1.0) * 0.5 + n * (w - 0.5 * w * w) + n * w * f + G;
}
// coverage of lines (centred on integers, width w in u) under a tent filter of half
// width fu (in u): exact for locally linear u, -> w when lines are sub-pixel
float lineCov(float u, float w, float fu) {
  w = clamp(w, 0.0, 1.0);
  if (w >= 1.0) return 1.0;
  float v = u + 0.5 * w;
  if (fu > 6.0) return w;
  fu = max(fu, 2e-3);
  float n0 = floor(v);
  v -= n0;
  float c = (C2(v + fu, w) - 2.0 * C2(v, w) + C2(v - fu, w)) / (fu * fu);
  // tiny residual ripple at large footprints: settle onto the mean
  return mix(clamp(c, 0.0, 1.0), w, smoothstep(3.0, 6.0, fu));
}

vec3 seqColor(float s) {
  float x = clamp(s, 0.0, 1.0) * float(uSeqN - 1);
  int i = int(floor(x));
  int i1 = min(i + 1, uSeqN - 1);
  float f = x - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(uSeq[i], uSeq[i1], f);
}

vec3 dbgOut;
float dbgU;

vec3 render(vec2 p) {
  vec2 x = uCam * p + uCamOff;
  mat2 J;
  vec2 a = advect(x, J);
  mat2 CT = transpose(uCam);
  mat2 JT = transpose(J);

  // ---- height field, family 1 (field units, gradient wrt a)
  vec3 f1 = fbm(a, 8, 2, 0.35);
  float H = uRampK * a.y + uAmpA * f1.x;
  vec2 gH = vec2(0.0, uRampK) + uAmpA * f1.yz;
  if (uCliff > 0.0) {
    // creases: steep tanh cliffs along the zero curves of a second noise, faded in
    // and out along their length by an envelope -> bundles of lines converge into a
    // narrow seam, run along it and fan out again where it fades
    vec3 f2 = fbm(a, 9, 2, 0.4);
    vec3 en = fbm(a * 0.6, 13, 1, 0.5);
    float q = clamp(0.5 + 1.2 * en.x, 0.0, 1.0);
    float C = uCliff * q * q * (3.0 - 2.0 * q);
    vec2 gC = (q > 0.0 && q < 1.0 ? uCliff * 6.0 * q * (1.0 - q) * 1.2 * 0.6 : 0.0) * en.yz;
    float th = tanh(clamp(f2.x / uCliffEps, -12.0, 12.0));   // clamped: tanh overflows to NaN on some drivers
    H += C * th;
    gH += C * (1.0 - th * th) / uCliffEps * f2.yz + th * gC;
  }
  float u = uLineK * H;
  vec2 gu = uLineK * (CT * (JT * gH));       // wrt p (normalized units)

  // ---- ribbons
  float fill = 0.0, edgeCov = 0.0, eD = 1e3;
  if (uRib > 0.0) {
    vec3 r = fbm(x * uRibFreq, 11, 2, 0.3);
    vec3 m = fbm(x * uRibFreq * 0.8 + vec2(3.1, -1.7), 12, 1, 0.5);
    float dr = r.x * uRibDist;
    vec2 gdr = uRibDist * uRibFreq * (CT * r.yz);
    float q = clamp(0.5 + 0.5 * (m.x + uRibBias) * 1.6, 0.0, 1.0);
    float wq = q * q * (3.0 - 2.0 * q);
    float wr = uRibW * wq;
    vec2 gwr = uRibW * 6.0 * q * (1.0 - q) * 0.8 * (uRibFreq * 0.8) * (CT * m.yz) * (q > 0.0 && q < 1.0 ? 1.0 : 0.0);
    float sg = dr < 0.0 ? -1.0 : 1.0;
    float e = abs(dr) - wr;
    vec2 ge = sg * gdr - gwr;
    float gel = max(length(ge), 1e-6);
    eD = e / gel;                              // signed distance to the ribbon edge, normalized units
    // contours attracted to the edge: run parallel and bunch into a crease
    float ep = max(e, 0.0);
    float ex = exp(-ep / uRibL);
    u += uRibS * uRib * (-uRibL * ex);
    gu += uRibS * uRib * ex * ge;
    // fill (box filter over the pixel footprint) and edge hairline
    fill = clamp(0.5 - eD / (2.0 * uPxN), 0.0, 1.0) * step(1e-5, wr);
    float hw = 0.5 * uLineW * 1.4;
    float lo = clamp(eD - hw, -uPxN, uPxN), hi = clamp(eD + hw, -uPxN, uPxN);
    edgeCov = (hi - lo) / (2.0 * uPxN) * smoothstep(0.0, 0.25 * uRibW, wr);
  }

  // ---- lines
  vec2 jt = jitter(u);
  float gl = length(gu) * jt.y;
  float cov = lineCov(jt.x, uLineW * gl, uPxN * gl);
  float dens = gl / uDensRef;
  float gl2 = 0.0;
  if (uFam == 2) {
    vec3 f3 = fbm(a, 10, 2, 0.5);
    float H2 = uRampK * (0.82 * a.x + 0.57 * a.y) + 0.8 * uAmpA * f3.x;
    vec2 gH2 = uRampK * vec2(0.82, 0.57) + 0.8 * uAmpA * f3.yz;
    vec2 gu2 = uLineK * (CT * (JT * gH2));
    vec2 j2 = jitter(uLineK * H2 + 0.37);
    gl2 = length(gu2) * j2.y;
    float c2 = lineCov(j2.x, uLineW * gl2, uPxN * gl2);
    cov = 1.0 - (1.0 - cov) * (1.0 - c2);
    dens = max(dens, gl2 / uDensRef);
  }
  if (uDebug == 1) dbgOut = vec3(fract(u * 0.05));
  if (uDebug == 2) dbgOut = vec3(gl * uPxN, 0.0, 0.0);
  if (uDebug == 3) dbgOut = vec3(dens / 8.0, gl / 2000.0, 0.0);
  dbgU = u;

  // ---- colour by density
  float ld = log2(max(dens, 1e-4));
  float s = clamp(uDensGain * (ld - 1.2) / 4.2, 0.0, 1.0);
  vec3 lc = seqColor(s * uSeqMax);
  float al = mix(uOpacity, 1.0, smoothstep(0.05, 0.45, s));
  vec3 col = mix(uGround, lc, cov * al);
  // soft glow around dense bundles (lower threshold, broader than the lines)
  float gs = clamp(uDensGain * (ld - 0.8) / 4.6, 0.0, 1.0);
  col += uGlow * 0.55 * gs * gs * gs * seqColor(gs * uSeqMax) * (1.0 - 0.6 * cov);

  // ---- ribbon fill and edge crease
  if (uRib > 0.0) {
    col = mix(col, uRibbon, fill);
    vec3 ec = seqColor(max(s, 0.42) * uSeqMax);
    col = mix(col, ec, clamp(edgeCov * uRibEdge * 1.2, 0.0, 1.0));
  }
  return col;
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
  vec3 lin = acc / float(uSS) * uExpo;
  if (uDebug != 0) {
    vec3 dv = dacc / float(uSS);
    if (uDebug == 2) {
      render(p0);
      float fd = length(vec2(dFdx(dbgU), dFdy(dbgU)));
      dv = vec3(dv.r, fd * uPxN * Smin, 0.0);
    }
    outColor = vec4(dv, 1.0);
    return;
  }
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
const BASE_FREQ = 0.8;
// typical |grad H| (field units) at defaults, measured: keeps lineCount ~ lines per
// short side independent of the field params
const DENS_NORM = 1.0;

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

export class ContourRenderer {
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

    this.seqBuf = new Float32Array(MAX_RAMP * 3);
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
    if (!this.scene) throw new Error('ContourRenderer: setScene() must be called before draw()');
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
    if (!this.scene) throw new Error('ContourRenderer: setScene() must be called before renderRegion()');
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

    // camera: p -> field space (BASE_FREQ noise cells per short side at scale 1)
    const zoom = clamp(num(P.zoom, 1), 0.05, 50);
    const scale = clamp(num(P.scale, 1), 0.05, 20);
    const kf = BASE_FREQ * scale;
    const k = kf / zoom;
    const stretch = clamp(num(P.stretch, 0.5), 0, 1);
    const ang = num(P.angle, 10) * DEG;
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
      F[j * 4 + 3] = ph[(27 + j) % 32] + j * 0.137;
    }
    gl.uniform4fv(U.uFbm, F);
    gl.uniform1f(U.uTheta, 2 * Math.PI * tau);
    gl.uniform1f(U.uFlowR, 0.04 * clamp(num(P.flow, 1), 0, 3));

    const iter = clamp(Math.round(num(P.warpIterations, 2)), 1, 4);
    const warp = clamp(num(P.warp, 1), 0, 3);
    gl.uniform1i(U.uIter, iter);
    gl.uniform1i(U.uSub, num(P.dbgSub, 1));
    gl.uniform1f(U.uWarpAmt, num(P.dbgWarpK, 0.6) * warp * Math.pow(2 / iter, 0.4));
    gl.uniform1f(U.uSwirl, num(P.dbgSwirl, 0.45));

    // height field -> line units. H's ramp slope is uRampK per field unit; the field
    // is k field units per normalized unit -> lines per short side ~ N * |grad H| / zoom
    const N = clamp(num(P.lineCount, 160), 1, 5000);
    const rampK = num(P.dbgRamp, 0.9);
    gl.uniform1f(U.uRampK, rampK);
    gl.uniform1f(U.uAmpA, num(P.dbgAmp, 0.55) * (0.6 + 0.4 * Math.min(warp, 1.5)));
    gl.uniform1f(U.uCliff, num(P.dbgCliff, 0.3));
    gl.uniform1f(U.uCliffEps, num(P.dbgCliffEps, 0.02));
    gl.uniform1f(U.uLineK, N / (kf * DENS_NORM));
    const fam = clamp(Math.round(num(P.families, 1)), 1, 2);
    gl.uniform1i(U.uFam, fam);
    gl.uniform1f(U.uJitter, clamp(num(P.lineJitter, 0), 0, 1));
    gl.uniform1f(U.uJitPh, (ph[5] || 0) * 2 * Math.PI);
    gl.uniform1f(U.uDensRef, N * num(P.dbgDensRef, 1.3));
    // line width: lineWidth * 1.5 / 1000 of the short side (0.6 -> ~0.9 px at 1000 px)
    gl.uniform1f(U.uLineW, clamp(num(P.lineWidth, 0.6), 0, 20) * 0.0015);
    // tent half width ~0.75 px per sample (supersampling refines the footprint)
    gl.uniform1f(U.uPxN, 0.75 / (S * Math.sqrt(ss)));

    // ribbons
    const rib = clamp(num(P.ribbons, 0.35), 0, 1);
    const rw = clamp(num(P.ribbonWidth, 0.5), 0, 1);
    gl.uniform1f(U.uRib, rib > 0 ? 1 : 0);
    gl.uniform1f(U.uRibFreq, 0.5);
    // r in [-1, 1] with |grad r| ~ 1.5 * 0.5 * k: -> distance
    gl.uniform1f(U.uRibDist, 1 / (0.75 * k));
    gl.uniform1f(U.uRibW, (0.01 + 0.1 * rw) / zoom);
    gl.uniform1f(U.uRibBias, -1.1 + 2.2 * rib);
    gl.uniform1f(U.uRibS, N * 1.3 * num(P.dbgRibS, 4) * Math.min(1, rib * 4));
    gl.uniform1f(U.uRibL, num(P.dbgRibL, 0.03 + 0.03 * rw) / zoom);
    gl.uniform1f(U.uRibEdge, clamp(num(P.ribbonEdge, 0.6), 0, 1));

    // colours (hue / saturation applied in linear light)
    const M = colorMatrix(num(P.hueShift, 0), clamp(num(P.saturation, 1), 0, 3));
    gl.uniform3fv(U.uGround, applyM(M, sc.ground));
    gl.uniform3fv(U.uRibbon, applyM(M, sc.ribbon));
    // density sequence: base line colour, then the ramp from its 2nd entry (ramp[0] is
    // the faint end, usually close to / darker than the line colour)
    const n = clamp(sc.rampCount | 0, 1, MAX_RAMP);
    const seq = [Array.from(sc.line)];
    for (let i = n > 2 ? 1 : 0; i < n; i++) seq.push([sc.ramp[i * 3], sc.ramp[i * 3 + 1], sc.ramp[i * 3 + 2]]);
    const sn = Math.min(seq.length, MAX_RAMP);
    const B = this.seqBuf;
    for (let i = 0; i < MAX_RAMP; i++) B.set(applyM(M, seq[Math.min(i, sn - 1)]), i * 3);
    gl.uniform3fv(U.uSeq, B);
    gl.uniform1i(U.uSeqN, sn);
    // warmth: how far up the sequence the densest creases get (white sits mid-way)
    gl.uniform1f(U.uSeqMax, 0.5 + 0.5 * clamp(num(P.warmth, 0.7), 0, 1));
    gl.uniform1f(U.uOpacity, clamp(num(P.lineOpacity, 0.55), 0, 1));
    gl.uniform1f(U.uDensGain, clamp(num(P.densityGain, 1), 0, 5));
    gl.uniform1f(U.uGlow, clamp(num(P.glow, 0.4), 0, 1));

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
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('ContourRenderer: framebuffer incomplete (' + st + ')');
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
