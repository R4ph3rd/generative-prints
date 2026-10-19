// groovy-gl.js
// WebGL2 renderer for the groovy swirl sketch: a retro 70s flat vector picture of
// big flowing streams of flat colour, rounded droplets floating inside them,
// tight spiral vortices and a thin dark outline on every boundary, drawn by a
// single full-screen fragment shader.
//
// Every pixel is a pure function of (normalized position, loop phase, params,
// scene), so preview, 100% loupe, tiled poster export and video frames agree:
//   p = ((pixel + 0.5) - full / 2) / min(fullW, fullH), y up.
//
// Per sample:
//   1. camera: q = p / zoom + offset (image space, short side = 1).
//   2. vortices: each of the first P.vortices scene vortices twists the domain
//      around its (slowly drifting) centre c: q <- c + Rot(theta(r)) (q - c),
//      theta = K * 0.5 ln(1 + R^2 / r^2) (log spiral inside R, ~1/r^2 outside),
//      K ~ 2 pi * vortexStrength. A twist map is a diffeomorphism (no folds).
//      Its Jacobian is carried exactly.
//   3. x = A q (scale, stretch along angle), then advection as in 004: the point
//      moves in small Euler steps along a smooth twisted noise velocity field
//      (P.warpIterations passes, P.flowWarp), Jacobian carried exactly.
//      Motion: noise is sampled along loop-periodic circles in 3D.
//   4. regions: f = 2-octave fbm(a), u = (0.5 + 0.5 tanh(k f)) * bands * N
//      + ramp + offset + spiral waves; colour = palette[floor(u) mod N].
//      Spiral wave: per vortex amp * exp(-(r/Rb)^2) * sin(phi + theta(r) - omega),
//      omega = 2 pi vortexSpin * loop phase: rotating arms in which several
//      colours wind into the centre; seamless because it is periodic in omega.
//   5. blobs: power-diagram "Worley" droplets in the blob domain
//      y = blobFreq * mix(x, a, blobStretch) + drift (so droplets are stretched
//      along the flow and drift with it; the cell lattice is periodic along the
//      drift axis and the drift is a whole period per loop -> seamless). Each
//      droplet is a disc with noise lobes (blobRoundness), clipped against its
//      neighbours' radical axes (never overlap), shrunk towards region edges and
//      suppressed where it would be thinner than a minimum (no slivers), and kept
//      a margin away from region boundaries. Colour: hash(droplet, region index),
//      never the parent region's colour.
//   6. outline: every boundary distance is (field value) / |exact gradient| in
//      normalized units, so the line (constant width, P.outlineWidth * 0.0012 of
//      the short side) and the anti-aliasing are resolution-independent and
//      identical across tiles, crops and supersampling. Line coverage is a box
//      filter of the line strip, so sub-pixel lines stay correct in tone.
//   7. exposure, optional paper tint (linear), sRGB, contrast, optional static
//      grain, triangular dither.
//
// Cost at default params: ~19 simplex-noise evaluations + a 3x3 cell search per sample.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_COLORS = 10;
const MAX_VORTICES = 4;
const N_FBM = 10; // 2 per warp pass (max 4) + region fbm + blob lobes

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uOrigin;      // window origin, abs px (top-left, y down)
uniform vec2 uSize;        // window size, px
uniform vec2 uFull;        // full image size, px
uniform int uFlipY;        // 1: FBO read back top-down (row 0 = top)
uniform int uSS;           // samples per pixel (1, 2, 4)

uniform float uZoom;       // q = p / zoom + off
uniform vec2 uOff;
uniform mat2 uA;           // q -> field space x
uniform int uNV;
uniform float uCore;        // vortex core radius / influence radius
uniform vec4 uV[${MAX_VORTICES}];   // centre xy, twist K (signed, rad), radius R
uniform vec4 uW[${MAX_VORTICES}];   // wave: omega (rad), amplitude (band units), radius, -
uniform vec4 uFbm[${N_FBM}];        // per fbm: offset xy, circle phase (turns), circle direction (turns)
uniform float uTheta;      // 2 pi * loop phase
uniform float uFlowR;      // circle radius, noise units
uniform int uIter;
uniform float uWarpAmt, uSwirl;
uniform float uGain, uOctNorm;

uniform float uTanhK, uBandK, uBandO, uRampK;
uniform vec3 uReg[${MAX_COLORS}];
uniform int uRegN;
uniform vec3 uRegAvg;
uniform vec3 uBlobC[${MAX_COLORS}];
uniform int uBlobN;
uniform vec3 uOutline;
uniform float uLineA, uLineHW;

uniform float uBlobF, uBlobS, uBlobPres, uBlobR0, uBlobR1, uBlobJit, uBlobWob;
uniform float uBlobMod, uBlobModF, uBlobShrink, uBlobMinR, uBlobGap, uBlobMargin, uBlobK, uDrift;
uniform int uBlobPer;
uniform uint uBlobSeed;

uniform float uPxN;        // AA width, normalized units (one pixel / sqrt(ss))
uniform float uExpo, uContrast, uGrain, uGrainCell, uPaperT;
uniform vec3 uPaper;
uniform uint uGrainKey;
uniform int uDebug;        // dev only: 1 = region field, 2 = |grad u| analytic (r) vs screen (g),
                           //           3 = blob distance, 4 = flat colours (no outline)
out vec4 outColor;

// ---------------------------------------------------------------- hashing
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
uint hash3(uvec3 v) { v = pcg3d(v); return v.x ^ v.z; }
float u01(uint h) { return float(h) * (1.0 / 4294967296.0); }
float hashF(ivec2 c, uint s) { return u01(hash3(uvec3(uvec2(c), s))); }
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
const float PI = 3.14159265359;
// octave rotation (~36.9 deg) times lacunarity 2.03
const mat2 OCT = mat2(0.8, 0.6, -0.6, 0.8) * 2.03;

vec2 perp(vec2 v) { return vec2(-v.y, v.x); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// fbm j at point x -> (value, d/dx, d/dy), value ~ [-1, 1]
vec3 fbm(vec2 x, int j, float oct, float norm, float rmul) {
  vec4 F = uFbm[j];
  vec2 y = x + F.xy;
  mat2 M = mat2(1.0);            // dy/dx
  float a = 1.0, s = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    if (fi >= oct) break;
    float aw = a * min(oct - fi, 1.0);
    // loop-periodic circle through the noise volume: integer cycles per loop
    float an = uTheta + TAU * (F.z + 0.618 * fi);
    float dA = TAU * F.w + 2.4 * fi;
    float R = uFlowR * rmul;
    vec3 sp = vec3(y + R * cos(an) * vec2(cos(dA), sin(dA)), R * sin(an) + 3.7 * fi);
    vec4 n = snoiseD(sp);
    s += aw * n.x;
    g += aw * (transpose(M) * n.yz);
    y = OCT * y + vec2(1.7, -3.1);
    M = OCT * M;
    a *= uGain;
  }
  return vec3(s, g) * norm;
}

// advection (as in 004): NSUB small Euler steps per pass along a twisted noise
// velocity field; the Jacobian da/dx is carried along exactly.
const int NSUB = 4;
vec2 advect(vec2 x, out mat2 J) {
  vec2 a = x;
  J = mat2(1.0);
  float h = uWarpAmt / float(NSUB);
  for (int k = 0; k < 4; k++) {
    if (k >= uIter) break;
    for (int s = 0; s < NSUB; s++) {
      vec3 f1 = fbm(a, 2 * k, 1.0, 1.0, 1.0), f2 = fbm(a, 2 * k + 1, 1.0, 1.0, 1.0);
      vec2 v0 = vec2(f1.x, f2.x);
      mat2 Jv = transpose(mat2(f1.yz, f2.yz));
      float al = uSwirl * (2.2 * v0.x - 1.3 * v0.y) + 0.6 * uSwirl * float(k + 1);
      vec2 ga = uSwirl * (2.2 * f1.yz - 1.3 * f2.yz);
      mat2 R = rot(al);
      Jv = R * (Jv + outerProduct(perp(v0), ga));
      J = (mat2(1.0) + h * Jv) * J;
      a += h * (R * v0);
    }
  }
  return a;
}

// vortex twist profile: theta = K T(r / Rc) Wn(r), T(rho) = 0.5 ln(1 + 1 / rho^2) (log
// spiral inside the core radius Rc), Wn = exp(-(r / Rw)^2) confines it to the influence
// radius Rw. V = (centre, K, Rw); Rc = uCore * Rw. Returns (theta, dtheta/dr).
vec2 twistTh(vec4 V, float r) {
  float Rc = uCore * V.w;
  float rho = max(r / Rc, 1e-6);
  float T = 0.5 * log(1.0 + 1.0 / (rho * rho));
  float dT = -1.0 / (rho * (rho * rho + 1.0)) / Rc;
  float Wn = exp(-(r * r) / (V.w * V.w));
  float dW = -2.0 * r / (V.w * V.w) * Wn;
  return V.z * vec2(T * Wn, dT * Wn + T * dW);
}

// sequential twists around each vortex centre; J <- dq'/dq
vec2 twist(vec2 q, inout mat2 J) {
  for (int i = 0; i < ${MAX_VORTICES}; i++) {
    if (i >= uNV) break;
    vec4 V = uV[i];
    vec2 d = q - V.xy;
    float r = max(length(d), 1e-7);
    vec2 th = twistTh(V, r);
    mat2 R = rot(th.x);
    J = R * (mat2(1.0) + outerProduct(perp(d), d) * (th.y / r)) * J;
    q = V.xy + R * d;
  }
  return q;
}

// rotating spiral waves added to the band coordinate -> (value, d/dq)
vec3 waves(vec2 q) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < ${MAX_VORTICES}; i++) {
    if (i >= uNV) break;
    vec4 V = uV[i], W = uW[i];
    if (W.y == 0.0) continue;
    vec2 d = q - V.xy;
    float r = max(length(d), 1e-7);
    float b = exp(-(r * r) / (W.z * W.z));
    if (b < 1e-4) continue;
    vec2 th = twistTh(V, r);
    float psi = atan(d.y, d.x) + th.x - W.x;
    float sn = sin(psi), cs = cos(psi);
    vec2 er = d / r;
    float db = -2.0 * r / (W.z * W.z) * b;
    vec2 gpsi = perp(d) / (r * r) + th.y * er;
    s.x += W.y * b * sn;
    s.yz += W.y * (db * sn * er + b * cs * gpsi);
  }
  return s;
}

vec3 regColor(int k) {
  int n = max(uRegN, 1);
  int i = k - (k / n) * n;
  if (i < 0) i += n;
  return uReg[i];
}

vec3 blobColor(uint id, int k, vec3 regC) {
  int n = max(uBlobN, 1);
  uint h = hash3(uvec3(id, uint(k + 4096), 0x2545f491u));
  int i = int(h % uint(n));
  vec3 c = uBlobC[i];
  // never the parent region's colour
  for (int t = 0; t < 2; t++) {
    if (distance(c, regC) < 0.02) { i = (i + 1) % n; c = uBlobC[i]; }
  }
  return c;
}

// polynomial smooth min; its gradient is exactly mix(grad b, grad a, h)
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sigmaMax(mat2 M) {
  float F = dot(M[0], M[0]) + dot(M[1], M[1]);
  float D = determinant(M);
  return sqrt(max(0.5 * (F + sqrt(max(F * F - 4.0 * D * D, 0.0))), 1e-12));
}

// coverage of a line strip |d| < hw by a pixel box of width aa
float lineCov(float d, float hw, float aa) {
  float ad = abs(d);
  return clamp((min(ad + hw, 0.5 * aa) - max(ad - hw, -0.5 * aa)) / aa, 0.0, 1.0);
}

vec3 dbgOut;
float dbgU;

vec3 render(vec2 p) {
  vec2 q = p / uZoom + uOff;
  mat2 Jv = mat2(1.0);
  vec2 qt = twist(q, Jv);
  vec2 x = uA * qt;
  mat2 Mq = uA * Jv;                                       // dx/dq
  mat2 Ja;
  vec2 a = advect(x, Ja);                                  // Ja = da/dx

  // ---- regions
  vec3 f = fbm(a, ${N_FBM - 2}, 2.0, uOctNorm, 1.0);
  float g = tanh(uTanhK * f.x);
  vec3 wv = waves(q);
  float u = (0.5 + 0.5 * g) * uBandK + a.y * uRampK + uBandO + wv.x;
  vec2 gA = 0.5 * uBandK * uTanhK * (1.0 - g * g) * f.yz + vec2(0.0, uRampK);
  vec2 gq = transpose(Mq) * (transpose(Ja) * gA) + wv.yz;  // grad u wrt q
  float gl = max(length(gq) / uZoom, 1e-9);                // |grad u| wrt p
  float aa = uPxN;
  float aaU = gl * aa;                                     // one pixel, in u
  dbgU = u;

  float kb = floor(u + 0.5);
  float d = u - kb;                                        // [-0.5, 0.5]
  float dR = abs(d) / gl;                                  // distance to region edge, normalized units
  int ki = int(kb);
  vec3 c0 = regColor(ki - 1), c1 = regColor(ki);
  float tb = clamp(d / max(aaU, 1e-9) + 0.5, 0.0, 1.0);
  vec3 col = mix(c0, c1, tb);
  int kr = int(floor(u));
  vec3 regC = regColor(kr);

  // ---- blobs
  float dB = -1.0;
  vec3 bc = regC;
  if (uBlobPres > 0.0 && uBlobR1 > 0.0) {
    vec2 y = uBlobF * mix(x, a, uBlobS) + vec2(uDrift, 0.0);
    mat2 Jb = uBlobF * (((1.0 - uBlobS) * mat2(1.0) + uBlobS * Ja) * Mq);  // dy/dq
    vec2 cf = floor(y);
    float pw1 = 1e9, pw2 = 1e9;
    vec3 b1 = vec3(0.0), b2 = vec3(0.0);
    uint id1 = 0u;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec2 c = ivec2(cf) + ivec2(i, j);
        int cx = c.x % uBlobPer;
        if (cx < 0) cx += uBlobPer;
        uvec3 A = pcg3d(uvec3(uint(cx), uint(c.y + 65536), uBlobSeed));
        if (u01(A.x) >= uBlobPres) continue;
        uvec3 B = pcg3d(A ^ uvec3(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u));
        float wp = TAU * u01(B.y) + ((B.y & 1u) == 1u ? uTheta : -uTheta);
        vec2 pc = vec2(c) + 0.5 + (vec2(u01(A.y), u01(A.z)) - 0.5) * uBlobJit + uBlobWob * vec2(cos(wp), sin(wp));
        float r = mix(uBlobR0, uBlobR1, u01(B.x)) * (1.0 + 0.08 * sin(uTheta + TAU * u01(B.z)));
        vec2 dd = y - pc;
        float pw = dot(dd, dd) - r * r;
        if (pw < pw1) { pw2 = pw1; b2 = b1; pw1 = pw; b1 = vec3(pc, r); id1 = B.z ^ A.y; }
        else if (pw < pw2) { pw2 = pw; b2 = vec3(pc, r); }
      }
    }
    if (pw1 < 1e8) {
      vec2 dd = y - b1.xy;
      float dist = max(length(dd), 1e-6);
      // lobes: one smooth noise modulating the radius
      vec4 F = uFbm[${N_FBM - 1}];
      float an = uTheta + TAU * F.z, dA = TAU * F.w, Rl = 6.0 * uFlowR;
      vec4 nm = snoiseD(vec3(y * uBlobModF + F.xy + Rl * cos(an) * vec2(cos(dA), sin(dA)), Rl * sin(an)));
      // droplets thinner than uBlobMinR (image units) shrink away: no slivers
      float keep = smoothstep(0.6, 1.0, b1.z / (sigmaMax(Jb) * uBlobMinR));
      float rr = b1.z * keep * (1.0 + uBlobMod * nm.x);
      float t1 = rr - dist;
      if (uDebug == 5) dbgOut = vec3(b1.z - dist > 0.0 ? 1.0 : 0.0, t1 > 0.0 ? 1.0 : 0.0, keep);
      vec2 g1 = transpose(Jb) * (-dd / dist + b1.z * keep * uBlobMod * uBlobModF * nm.yz);
      // shrink towards region edges: droplets float in the middle of the streams
      float fr = fract(u);
      float oe = max(1.0 - sin(PI * fr), 0.0);
      float so = sqrt(oe);
      t1 -= uBlobShrink * oe * so;
      g1 += uBlobShrink * 1.5 * so * PI * cos(PI * fr) * gq;
      dB = t1 / max(length(g1), 1e-9) * uZoom;              // normalized units
      if (pw2 < 1e8) {
        // clip against the neighbour's radical axis (power diagram): never overlap
        vec2 e2 = b1.xy - b2.xy;
        float L = max(length(e2), 1e-6);
        float t2 = (pw2 - pw1) / (2.0 * L);
        float d2 = t2 / max(length(transpose(Jb) * (e2 / L)), 1e-9) * uZoom - uBlobGap;
        dB = smin(dB, d2, uBlobK);
      }
      dB = smin(dB, dR - uBlobMargin, uBlobK);
      bc = blobColor(id1, kr, regC);
    }
  }
  if (uDebug == 1) dbgOut = vec3(fract(u / float(max(uRegN, 1))));
  if (uDebug == 2) dbgOut = vec3(aaU, 0.0, 0.0);
  if (uDebug == 3) dbgOut = vec3(0.5 + 8.0 * dB, 0.5 + 8.0 * dR, dB > 0.0 ? 1.0 : 0.0);

  float covB = clamp(dB / aa + 0.5, 0.0, 1.0);
  col = mix(col, bc, covB);
  if (uDebug == 4) dbgOut = col;

  // outlines: one constant-width line on every boundary (regions and blobs)
  float lr = lineCov(dR, uLineHW, aa);
  float lb = lineCov(dB, uLineHW, aa);
  col = mix(col, uOutline, uLineA * max(lr, lb));
  // bands narrower than a few pixels (vortex core): converge to their average look
  float lineFrac = clamp(2.0 * uLineHW * gl, 0.0, 1.0);
  vec3 far = mix(uRegAvg, uOutline, uLineA * lineFrac);
  col = mix(col, far, smoothstep(0.3, 0.9, aaU));
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
  if (uDebug != 0) {
    vec3 dv = dacc / float(uSS);
    if (uDebug == 2) {
      // screen-space estimate of the band-coordinate change per pixel, for comparison
      render(p0);
      float fd = length(vec2(dFdx(dbgU), dFdy(dbgU)));
      dv = vec3(dv.r, fd * uPxN * Smin, 0.0);
    }
    if (uDebug == 4) dv = toSrgb(dv);
    outColor = vec4(dv, 1.0);
    return;
  }
  vec3 lin = acc / float(uSS) * uExpo;
  lin *= mix(vec3(1.0), uPaper, uPaperT);
  vec3 c = toSrgb(lin);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

  // optional static print grain on an absolute grid (fraction of the short side)
  if (uGrain > 0.0) {
    vec2 gp = p0 / uGrainCell;
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
const BASE_FREQ = 0.75;     // region noise cells per short side at scale 1
const BLOB_FREQ = 2.2;     // droplet cells per field unit at blobScale 1
const BLOB_PERIOD = 8;     // droplet lattice period along the drift axis (cells)
const PAPER = [1.0, 0.9, 0.74]; // warm paper multiply (linear)

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

export class GroovyRenderer {
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

    this.regBuf = new Float32Array(MAX_COLORS * 3);
    this.blobBuf = new Float32Array(MAX_COLORS * 3);
    this.fbmBuf = new Float32Array(N_FBM * 4);
    this.vBuf = new Float32Array(MAX_VORTICES * 4);
    this.wBuf = new Float32Array(MAX_VORTICES * 4);
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
    if (!this.scene) throw new Error('GroovyRenderer: setScene() must be called before draw()');
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
    if (!this.scene) throw new Error('GroovyRenderer: setScene() must be called before renderRegion()');
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
    const TAU = 2 * Math.PI;
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

    // camera: q = p / zoom + offset (image units); x = A q (field units)
    const zoom = clamp(num(P.zoom, 1), 0.05, 50);
    const scale = clamp(num(P.scale, 1), 0.05, 20);
    gl.uniform1f(U.uZoom, zoom);
    gl.uniform2f(U.uOff, num(P.offsetX, 0), num(P.offsetY, 0));
    const k = num(P.bf, BASE_FREQ) * scale;
    const stretch = clamp(num(P.stretch, 0.4), 0, 1);
    const ang = num(P.angle, 60) * DEG;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // rotate into the stretch frame (x' along angle), squash frequency along it
    const sx = 1 - 0.6 * stretch, sy = 1 + 0.2 * stretch;
    // A = diag(sx, sy) * Rot(-ang) * k   (row-major -> column-major upload)
    gl.uniformMatrix2fv(U.uA, false, new Float32Array([sx * ca * k, -sy * sa * k, sx * sa * k, sy * ca * k]));

    // vortices (image units): twist K, radius R, drifting centre, rotating spiral wave
    const nv = clamp(Math.round(num(P.vortices, 1)), 0, MAX_VORTICES);
    const vs = clamp(num(P.vortexStrength, 1), 0, 3);
    const vR = clamp(num(P.vortexSize, 0.35), 0.01, 2);
    const spin = Math.round(clamp(num(P.vortexSpin, 1), -8, 8));
    const V = this.vBuf, W = this.wBuf;
    V.fill(0); W.fill(0);
    const vt = sc.vortices || new Float32Array(MAX_VORTICES * 4);
    for (let i = 0; i < nv; i++) {
      const sgn = vt[i * 4 + 2] < 0 ? -1 : 1;
      const unit = clamp(num(vt[i * 4 + 3], 0.75), 0.05, 2);
      const dph = TAU * ph[(20 + i) % 32];
      const drift = 0.02 * vR;
      V[i * 4] = vt[i * 4] + drift * Math.cos(TAU * tau + dph);
      V[i * 4 + 1] = vt[i * 4 + 1] + drift * Math.sin(TAU * tau + dph);
      // twist: ~0.55 turns per e-fold of radius inside R at strength 1; gently breathing
      V[i * 4 + 2] = sgn * TAU * num(P.vk, 0.6) * vs * unit * (1 + 0.06 * Math.sin(TAU * tau + 2.1 * dph));
      V[i * 4 + 3] = vR;
      W[i * 4] = sgn * TAU * spin * tau;                 // whole turns per loop
      W[i * 4 + 1] = num(P.wa, 1.6) * Math.min(1, vs) * (0.7 + 0.3 * unit);
      W[i * 4 + 2] = num(P.wr, 0.45) * vR;
    }
    gl.uniform1i(U.uNV, nv);
    gl.uniform1f(U.uCore, num(P.vc, 0.45));
    gl.uniform4fv(U.uV, V);
    gl.uniform4fv(U.uW, W);

    // per-fbm seeded offsets
    const F = this.fbmBuf;
    for (let j = 0; j < N_FBM; j++) {
      F[j * 4] = (ph[(j * 2) % 32] - 0.5) * 200;
      F[j * 4 + 1] = (ph[(j * 2 + 1) % 32] - 0.5) * 200;
      F[j * 4 + 2] = ph[(18 + j) % 32];
      F[j * 4 + 3] = ph[(27 + j) % 32] + j * 0.137;
    }
    gl.uniform4fv(U.uFbm, F);
    gl.uniform1f(U.uTheta, TAU * tau);
    const flow = clamp(num(P.flow, 1), 0, 3);
    gl.uniform1f(U.uFlowR, 0.05 * flow);
    const gain = 0.4;
    gl.uniform1f(U.uGain, gain);
    gl.uniform1f(U.uOctNorm, 1 / (1 + gain));
    const iter = clamp(Math.round(num(P.warpIterations, 2)), 1, 4);
    const warp = clamp(num(P.flowWarp, 1.2), 0, 6);
    gl.uniform1i(U.uIter, iter);
    gl.uniform1f(U.uWarpAmt, num(P.wk, 0.5) * Math.pow(warp / 1.2, warp > 1.2 ? 0.6 : 1) * 1.2 * Math.pow(2 / iter, 0.35));
    gl.uniform1f(U.uSwirl, 0.35);

    // colours (hue / saturation, linear)
    const M = colorMatrix(num(P.hueShift, 0), clamp(num(P.saturation, 1), 0, 3));
    const n = clamp(sc.regionCount | 0, 1, MAX_COLORS);
    const C = this.regBuf;
    for (let i = 0; i < MAX_COLORS; i++) C.set(applyM(M, sc.regions, Math.min(i, n - 1) * 3), i * 3);
    gl.uniform3fv(U.uReg, C);
    const avg = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) avg[c] += C[i * 3 + c] / n;
    gl.uniform3fv(U.uRegAvg, avg);
    gl.uniform1i(U.uRegN, n);
    const nb = clamp(sc.blobCount | 0, 1, MAX_COLORS);
    const Bc = this.blobBuf;
    for (let i = 0; i < MAX_COLORS; i++) Bc.set(applyM(M, sc.blobs, Math.min(i, nb - 1) * 3), i * 3);
    gl.uniform3fv(U.uBlobC, Bc);
    gl.uniform1i(U.uBlobN, nb);
    gl.uniform3fv(U.uOutline, applyM(M, sc.outline));

    // region bands: regionBands = palette cycles across the (flattened) field range
    const bands = clamp(num(P.regionBands, 1), 0.01, 64);
    gl.uniform1f(U.uTanhK, num(P.tk, 3));
    gl.uniform1f(U.uBandK, bands * n);
    gl.uniform1f(U.uRampK, num(P.rk, 0) * stretch * bands * n);
    gl.uniform1f(U.uBandO, num(P.colorOffset, 0) * n + 0.5);

    // outline: full width outlineWidth * 0.0015 of the short side
    const ow = clamp(num(P.outlineWidth, 1), 0, 10);
    const hw = 0.00075 * ow;
    gl.uniform1f(U.uLineA, ow > 0 ? clamp(num(P.outline, 1), 0, 1) : 0);
    gl.uniform1f(U.uLineHW, hw);
    gl.uniform1f(U.uPxN, 1 / (S * Math.sqrt(ss)));

    // blobs
    const cov = clamp(num(P.blobs, 0.55), 0, 1);
    const round = clamp(num(P.blobRoundness, 0.6), 0, 1);
    const bscale = clamp(num(P.blobScale, 2.6), 0.2, 20);
    gl.uniform1f(U.uBlobF, num(P.bfq, BLOB_FREQ) * bscale);
    gl.uniform1f(U.uBlobS, clamp(num(P.blobStretch, 0.6), 0, 1));
    gl.uniform1f(U.uBlobPres, cov <= 0 ? 0 : clamp(0.25 + 0.9 * cov, 0, 0.95));
    gl.uniform1f(U.uBlobR0, cov <= 0 ? 0 : 0.12 + 0.1 * cov);
    gl.uniform1f(U.uBlobR1, cov <= 0 ? 0 : 0.26 + 0.16 * cov);
    gl.uniform1f(U.uBlobJit, 0.75);
    gl.uniform1f(U.uBlobWob, 0.06);
    gl.uniform1f(U.uBlobMod, 0.06 + 0.34 * (1 - round));
    gl.uniform1f(U.uBlobModF, 1.4);
    gl.uniform1f(U.uBlobShrink, 0.3);
    gl.uniform1f(U.uBlobMinR, 0.012);                    // minimum droplet half-thickness, image units
    gl.uniform1f(U.uBlobMargin, 0.005 * zoom + 2.5 * hw);
    gl.uniform1f(U.uBlobGap, 0.004 * zoom + 2.0 * hw);
    gl.uniform1f(U.uBlobK, 0.008 * zoom);
    gl.uniform1i(U.uBlobPer, BLOB_PERIOD);
    // drift: whole lattice periods per loop along the stretch axis (seamless)
    const nd = flow > 0 ? Math.max(1, Math.round(flow)) : 0;
    gl.uniform1f(U.uDrift, BLOB_PERIOD * nd * tau);
    gl.uniform1ui(U.uBlobSeed, (Math.floor(ph[30] * 4294967295) >>> 0));

    // look
    gl.uniform1f(U.uExpo, Math.pow(2, clamp(num(P.exposure, 0), -4, 4)));
    gl.uniform1f(U.uContrast, clamp(num(P.contrast, 1), 0, 4));
    gl.uniform1f(U.uPaperT, clamp(num(P.paperTint, 0), 0, 1));
    gl.uniform3fv(U.uPaper, PAPER);
    gl.uniform1f(U.uGrain, clamp(num(P.grain, 0), 0, 1));
    gl.uniform1f(U.uGrainCell, 0.0015);
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
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GroovyRenderer: framebuffer incomplete (' + st + ')');
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
