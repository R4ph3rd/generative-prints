// scene.js
// Seeded, resolution-independent description of a "silk flow" picture:
//   - a resolved palette, baked into a small colour LUT (front / back / accent
//     ramps, dark -> light, interpolated in OKLab),
//   - per-ribbon raw shape data: centreline harmonics, width, twist, curl,
//     billow, depth, colour offset, and the INTEGER temporal harmonics that make
//     every motion term periodic with the loop,
//   - a few thin satellite strands that ride next to a parent ribbon,
//   - the shared fluid domain-warp phases.
//
// Values here are mostly unit randoms ("shape" of each ribbon). The renderer
// (silk-gl.js) scales them by the live params (ribbonWidth, spread, angle,
// curvature, twist, curl, dof, ...) at draw time, so sliders do not need a
// scene rebuild. Only seed, ribbons, strands and palette change the scene.
//
// Coordinates: short side of the image = 1, origin at the image centre, y up.
// Independent random streams per ribbon (sub-seeds), so changing the ribbon
// count adds / removes ribbons without reshuffling the others.

export const MAX_RIBBONS = 12;
export const MAX_STRANDS = 8;
export const MAX_SLOTS = MAX_RIBBONS + MAX_STRANDS; // shader slots
export const LUT_W = 256;
export const LUT_ROWS = 4; // 0 front, 1 back, 2 accent (alt back), 3 spare (= front)

// Ramps run dark -> light; the shader indexes them with the lighting.
// trans: tint seen where the fabric turns edge-on (between the two faces).
export const PALETTES = {
  ember: {
    label: 'Ember',
    front: ['#b8384a', '#e85a26', '#ff7f17', '#ffa015', '#ffc21a', '#ffe23a', '#fff4a8'],
    back: ['#160f3c', '#241f72', '#3330a8', '#4d44d6', '#7d64f2', '#b39bff', '#e6dcff'],
    accent: ['#3a0d2e', '#7c1d5c', '#c23a86', '#ee6fae', '#ffb1d2', '#ffe4ef'],
    accentChance: 0.12,
    backChance: 0.32,
    trans: '#e0609a',
    rim: '#fff1a0',
    glowWarm: '#ffb878',
    glowCool: '#a68cff',
  },
  glacier: {
    label: 'Glacier',
    front: ['#5b6fc4', '#93a6e6', '#c9d3f4', '#e8ecfa', '#f8f9fe', '#ffffff'],
    back: ['#08113f', '#0f2275', '#1a3db4', '#2f66da', '#6ea0ef', '#b9d3fb', '#eaf2ff'],
    accent: ['#3e1606', '#8a3a0c', '#d36a14', '#f89a32', '#ffc77a', '#ffecd0'],
    accentChance: 0.22,
    backChance: 0.35,
    trans: '#f29ccc',
    rim: '#ffffff',
    glowWarm: '#f5c6e6',
    glowCool: '#9fb8ff',
  },
  dusk: {
    label: 'Dusk',
    front: ['#5a3d86', '#9a6cc0', '#d690c4', '#f6aebd', '#ffcdb4', '#fff0e4'],
    back: ['#141c55', '#283f9c', '#4a6fd0', '#82a2ee', '#bcd0fa', '#eef3ff'],
    accent: ['#5c2216', '#b5523a', '#ec8a64', '#ffb98f', '#ffe2cc'],
    accentChance: 0.25,
    backChance: 0.35,
    trans: '#f7a1c4',
    rim: '#fff4ec',
    glowWarm: '#ffc4b0',
    glowCool: '#b49cf0',
  },
};
const PALETTE_KEYS = Object.keys(PALETTES);

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const r = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  for (let i = 0; i < 8; i++) r();
  return {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => Math.floor(a + (b - a + 1) * r()),
    chance: (p) => r() < p,
    sign: () => (r() < 0.5 ? -1 : 1),
    // non-zero integer harmonic in [-k, k]
    harm: (k) => (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * k)),
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TAU = Math.PI * 2;
// sub-stream seeds: same seed, different purpose -> independent sequences
const sub = (seed, k) => (Math.imul((seed >>> 0) ^ 0x85ebca6b, 0x27d4eb2d) + Math.imul(k, 0x9e3779b1)) >>> 0;

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------- colour
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** '#rrggbb' -> linear RGB [0..1] */
export function hexToLinear(hex) {
  return hexToRgb(hex).map((v) => s2l(v / 255));
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Bake the palette ramps into an sRGB8 LUT, LUT_W x LUT_ROWS (OKLab interpolation). */
function buildLut(pal) {
  const lut = new Uint8Array(LUT_W * LUT_ROWS * 4);
  const rows = [pal.front, pal.back, pal.accent, pal.front];
  rows.forEach((stops, row) => {
    const labs = stops.map((h) => linToOklab(hexToLinear(h)));
    for (let i = 0; i < LUT_W; i++) {
      const x = (i / (LUT_W - 1)) * (labs.length - 1);
      const k = Math.min(labs.length - 2, Math.floor(x));
      let f = x - k;
      f = f * f * (3 - 2 * f) * 0.5 + f * 0.5; // slightly eased: softer stops
      const L = labs[k].map((v, j) => v + (labs[k + 1][j] - v) * f);
      const rgb = oklabToLin(L).map((v) => Math.round(clamp(l2s(clamp(v, 0, 1)), 0, 1) * 255));
      const o = (row * LUT_W + i) * 4;
      lut[o] = rgb[0]; lut[o + 1] = rgb[1]; lut[o + 2] = rgb[2]; lut[o + 3] = 255;
    }
  });
  return lut;
}

// ---------------------------------------------------------------- scene
/**
 * Build the scene description.
 * @param {number} seed
 * @param {object} P params (DEFAULTS keys). Uses ribbons, strands, palette.
 * @returns {object} scene: { info, palette, lut, lutW, lutRows, ribbons[], strands[], warp[], seedHash }
 */
export function buildScene(seed, P = {}) {
  seed = num(seed, 1) >>> 0;
  const pick = makeRng(sub(seed, 1));
  const palRoll = pick.next();
  let palKey = P.palette;
  if (!PALETTES[palKey]) palKey = PALETTE_KEYS[Math.floor(palRoll * PALETTE_KEYS.length)];
  const pal = PALETTES[palKey];

  const N = clamp(Math.round(num(P.ribbons, 5)), 1, MAX_RIBBONS);
  const NS = clamp(Math.round(num(P.strands, 2)), 0, MAX_STRANDS);

  // depth ranks: a seeded permutation so depth is independent of position
  const perm = [];
  for (let i = 0; i < N; i++) perm.push(i);
  const pr = makeRng(sub(seed, 2));
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(pr.next() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }

  const ribbons = [];
  let accents = 0;
  for (let i = 0; i < N; i++) {
    const g = makeRng(sub(seed, 100 + i));
    const back = g.chance(pal.backChance);
    const accent = g.chance(pal.accentChance) && accents < Math.max(1, Math.round(N / 4));
    if (accent) accents++;
    ribbons.push({
      // lateral slot in [-1, 1] (scaled by spread), jitter in slot units
      slot: N === 1 ? 0 : (2 * (i + 0.5)) / N - 1,
      jitter: g.range(-0.35, 0.35),
      angleJitter: g.range(-1, 1),        // * ~18 deg
      width: g.range(-1.6, 0.7),          // log width factor (* widthVariance), skewed narrow
      depth: (perm[i] + g.range(0.15, 0.85)) / N, // 0 far .. 1 near
      opacity: g.range(0.97, 1.0),
      // centreline: 3 travelling harmonics (amp unit, spatial freq / unit, phase, integer time harmonic)
      c: [
        [g.range(0.7, 1.2), g.range(1.3, 2.4), g.range(0, TAU), g.harm(1)],
        [g.range(0.18, 0.4), g.range(3.0, 4.8), g.range(0, TAU), g.harm(1)],
        [g.range(0.05, 0.12), g.range(6.0, 9.0), g.range(0, TAU), g.harm(1)],
      ],
      wobble: [g.range(0.08, 0.28), g.range(1.0, 3.0), g.range(0, TAU), g.harm(1)],
      // twist angle: theta0 + twist * (k * u + A * sin(f * u + phase + 2pi m tau))
      theta0: (back ? Math.PI : 0) + g.range(-0.55, 0.55),
      twistK: g.range(-1.4, 1.4),
      twistA: g.range(1.2, 2.4),
      twistF: g.range(1.2, 2.8),
      twistPh: g.range(0, TAU),
      twistM: g.harm(1),
      curl: g.range(0.6, 1.4),
      billow: [g.range(0.25, 0.7), g.range(1.4, 3.2), g.range(0, TAU), g.harm(1)],
      ramp: g.range(-0.12, 0.12),
      rampDrift: [g.range(0.03, 0.08), g.range(0, TAU), g.harm(1)],
      rampFreq: g.range(0.8, 2.2),
      rampPh: g.range(0, TAU),
      row: accent ? 2 : 0,
      seed: g.range(0, 97),
      region: [g.range(0, TAU), g.harm(1)],
    });
  }

  // thin satellite strands riding alongside a parent ribbon
  const strands = [];
  for (let j = 0; j < NS; j++) {
    const g = makeRng(sub(seed, 300 + j));
    const parent = Math.floor(g.next() * N);
    strands.push({
      parent,
      side: g.sign(),
      gap: g.range(0.85, 1.9),             // offset in parent half-widths
      width: g.range(0.035, 0.14),          // fraction of parent half-width
      depthDelta: g.range(-0.3, 0.3),
      opacity: g.range(0.75, 1.0),
      theta0: g.range(-0.6, 0.6) + (g.chance(0.3) ? Math.PI : 0),
      twistK: g.range(-2.5, 2.5),
      twistA: g.range(1.0, 2.5),
      twistF: g.range(1.5, 4.0),
      twistPh: g.range(0, TAU),
      twistM: g.harm(1),
      lag: g.range(-0.6, 0.6),              // phase lag vs parent's centreline waves
      ramp: g.range(-0.2, 0.25),
      seed: g.range(0, 97),
    });
  }

  // shared fluid warp: 4 octaves (phase x, phase y, integer harmonics)
  const wr = makeRng(sub(seed, 9));
  const warp = [];
  for (let k = 0; k < 4; k++) warp.push([wr.range(0, TAU), wr.range(0, TAU), wr.harm(1), wr.harm(1)]);

  return {
    info: { palette: palKey },
    palette: pal,
    paletteKey: palKey,
    lut: buildLut(pal),
    lutW: LUT_W,
    lutRows: LUT_ROWS,
    ribbons,
    strands,
    warp,
    seedHash: sub(seed, 7),
  };
}
