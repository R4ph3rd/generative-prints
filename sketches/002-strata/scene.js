// scene.js
// Seeded, resolution-independent description of a "strata" picture:
//   - the scene kind (horizontal strata, or a sky + stacked mountain ranges),
//   - the geometry of the ranges / bulges (in art-relative coordinates),
//   - a 1D colour LUT that maps the (fract of the) scalar field to a band colour.
//
// The heavy lifting (field evaluation, strokes / stipple) happens in strata-gl.js;
// everything here is cheap (< 1 ms) and is rebuilt whenever params change.
//
// Coordinates used by the shader: "units" where the SHORT side of the image = 1,
// origin top-left, y down. Geometry stored here is relative to the art rectangle
// (the image minus the margin) so it adapts to any aspect / resolution.
//
// Independent random streams are used for each part (pick / geometry / bands /
// colours) so that, e.g., changing bandCount does not reshuffle the mountains.

export const PALETTES = [
  { name: 'meridian', colors: ['#2c2b6f', '#1f8a9a', '#f59b2c', '#f3e7b6', '#a5cfee', '#1b1d2b', '#d98b8b', '#d9381e', '#f2601b', '#e9b94a'] },
  { name: 'orchard', colors: ['#f7a531', '#f9d867', '#2f5d3a', '#2f6fa3', '#d32f2f', '#c79aa4', '#f2b38a', '#9fd3c4'] },
  { name: 'carnival', colors: ['#f5841f', '#e23c96', '#b5141e', '#e0d27a', '#2a8fc4', '#2a7f87', '#4b3f5e', '#1f7a33', '#f07a5a', '#d9a3a0'] },
  { name: 'vermilion', colors: ['#f05a32'] },
  { name: 'harbour', colors: ['#f5860f', '#f6a623', '#213a8f', '#6f8ccc'] },
  { name: 'riso', colors: ['#ff48b0', '#ffe800', '#0078bf', '#00a95c', '#ff6c2f', '#765ba7', '#3d5588'] },
  { name: 'desert', colors: ['#c8553d', '#f28f3b', '#f6d2b8', '#588b8b', '#2d3047', '#e9c46a', '#8c2f39'] },
  { name: 'glacier', colors: ['#0b2545', '#134074', '#8da9c4', '#eef4ed', '#5fa8d3', '#c9e4ca', '#1b998b'] },
  { name: 'ember', colors: ['#1a1a2e', '#e94560', '#f5a623', '#ff7b54', '#533483', '#ffd56b'] },
  { name: 'moss', colors: ['#283618', '#606c38', '#dda15e', '#bc6c25', '#fefae0', '#8a9a5b', '#3a5a40'] },
  { name: 'dusk', colors: ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4', '#e07a5f', '#3d405b', '#f2cc8f'] },
  { name: 'tropic', colors: ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#073b4c', '#f78c6b'] },
  { name: 'indigo', colors: ['#26307a'] },
];

export const LUT_SIZE = 4096;
export const MAX_RANGES = 8;
export const MAX_BUMPS = 8;

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
  const rng = {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => Math.floor(a + (b - a + 1) * r()),
    chance: (p) => r() < p,
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    sign: () => (r() < 0.5 ? -1 : 1),
    gauss: () => {
      let u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
// sub-stream seeds: same seed, different purpose -> independent sequences
const sub = (seed, k) => (Math.imul((seed >>> 0) ^ 0x85ebca6b, 0x27d4eb2d) + Math.imul(k, 0x9e3779b1)) >>> 0;

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build the scene description.
 * @param {number} seed
 * @param {object} P params (see sketch.js DEFAULTS)
 * @param {number} aspect width / height (geometry is art-relative, kept for reference)
 */
export function buildScene(seed, P, aspect) {
  seed = num(seed, 1) >>> 0;
  const pick = makeRng(sub(seed, 1));

  // --- resolved choices (deterministic from seed when 'random') ---
  let kind = P.scene;
  const kindRoll = pick.next();
  if (kind !== 'landscape' && kind !== 'strata') kind = kindRoll < 0.6 ? 'landscape' : 'strata';
  const palRoll = pick.next();
  let palette = PALETTES.find((p) => p.name === P.palette);
  if (!palette) palette = PALETTES[Math.floor(palRoll * PALETTES.length)];

  const scene = {
    info: { scene: kind, palette: palette.name },
    kind: kind === 'landscape' ? 1 : 0,
    aspect: num(aspect, 9 / 16),
    seedHash: sub(seed, 7),
    ranges: new Float32Array(MAX_RANGES * 8), // per range: A(base, height, freq, lutOffset) B(bandScale, diag, diagAngle, noiseY)
    rangeCount: 0,
    bumps: new Float32Array(MAX_BUMPS * 4),     // (fx, fy) art-relative, radius (units), amplitude (field units)
    bumpCount: 0,
    skyScale: 1.0,
    lut: null,
    lutSize: LUT_SIZE,
  };

  // --- bands -> LUT (built first: ranges snap their LUT offset to band starts) ---
  const { lut, starts } = buildLut(seed, P, palette);
  scene.lut = lut;

  // --- geometry ---
  const geo = makeRng(sub(seed, 2));
  const mh = clamp(num(P.mountainHeight, 0.35), 0, 1);
  if (scene.kind === 1) {
    const N = clamp(Math.round(num(P.ranges, 4)), 1, MAX_RANGES);
    const horizon = clamp(num(P.horizon, 0.38), 0, 1);
    const hs = [];
    for (let i = 0; i < N; i++) {
      const t = N === 1 ? 1 : i / (N - 1);
      hs.push(mh * lerp(0.5, 1.25, t) * geo.range(0.85, 1.15));
    }
    const base0 = horizon + 0.75 * hs[0];
    const baseN = Math.max(base0 + 0.05, 1.03);
    for (let i = 0; i < N; i++) {
      const t = N === 1 ? 1 : i / (N - 1);
      const base = N === 1 ? base0 : lerp(base0, baseN, Math.pow(t, 0.85));
      const freq = geo.range(1.0, 1.7) * lerp(1.7, 0.85, t);
      // start the range's strata exactly at a band edge (preferably a thin inked line)
      // so a line traces every ridge silhouette
      const k0 = Math.floor(geo.next() * starts.length);
      let k = k0;
      for (let s = 0; s < starts.length; s++) {
        const c = starts[(k0 + s) % starts.length];
        if (c.ink && c.thin) { k = (k0 + s) % starts.length; break; }
        if (s === 0 && c.ink) k = k0;
      }
      const lutOff = starts[k].t + 0.5 / LUT_SIZE;
      const bandScale = lerp(3.0, 1.8, t) * geo.range(0.85, 1.15);
      const diag = i === N - 1 && N >= 2 && geo.chance(0.4);
      const ang = geo.sign() * geo.range(0.3, 0.75);
      const noiseY = 3.7 + i * 7.31 + geo.range(0, 50);
      scene.ranges.set([base, hs[i], freq, lutOff, bandScale, diag ? 1 : 0, ang, noiseY], i * 8);
    }
    scene.rangeCount = N;
    scene.skyScale = 1.0;
  } else {
    const nb = geo.int(2, 5);
    for (let b = 0; b < nb; b++) {
      const up = geo.chance(0.75) ? 1 : -1;
      scene.bumps.set([
        geo.range(0.08, 0.92), geo.range(0.2, 0.95),
        geo.range(0.06, 0.26),
        up * geo.range(0.05, 0.17) * (mh / 0.35),
      ], b * 4);
    }
    scene.bumpCount = nb;
  }

  return scene;
}

function buildLut(seed, P, palette) {
  const bandRng = makeRng(sub(seed, 3));
  const colRng = makeRng(sub(seed, 4));
  const nBands = clamp(Math.round(num(P.bandCount, 30)), 3, 400);
  const v = clamp(num(P.bandVariance, 0.7), 0, 1);
  const paperP = clamp(num(P.paperBands, 0.05), 0, 0.5);

  // colour subset
  const all = palette.colors.slice();
  for (let i = all.length - 1; i > 0; i--) { // seeded shuffle
    const j = Math.floor(colRng.next() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const nCol = clamp(Math.round(num(P.colorCount, 6)), 1, all.length);
  const cols = all.slice(0, nCol).map(hexToRgb);
  const weights = cols.map(() => colRng.range(0.5, 1.5));
  const monochrome = cols.length === 1;

  // band widths: lognormal body + a share of very thin lines (heavy tail on both ends)
  const thinP = 0.4 * v;
  const sigma = 0.08 + 0.9 * v;
  const bands = [];
  let prev = -2, prevPaper = true;
  for (let k = 0; k < nBands; k++) {
    const thin = bandRng.chance(thinP);
    const w = thin ? bandRng.range(0.07, 0.25) : Math.exp(bandRng.gauss() * sigma);
    // colour: weighted pick avoiding the previous colour; bare paper sometimes
    let c;
    const rollPaper = colRng.next();
    if (monochrome) {
      c = (prev === 0 || (!prevPaper && rollPaper < 0.5)) ? -1 : 0; // alternate ink / paper
      if (prev === -1) c = 0;
    } else if (!prevPaper && rollPaper < paperP) {
      c = -1;
    } else {
      let tot = 0;
      for (let i = 0; i < cols.length; i++) if (i !== prev) tot += weights[i];
      let x = colRng.next() * tot;
      c = 0;
      for (let i = 0; i < cols.length; i++) {
        if (i === prev) continue;
        c = i;
        x -= weights[i];
        if (x <= 0) break;
      }
    }
    const tone = colRng.range(0.38, 0.92); // stipple ink coverage of the band
    // bare-paper gaps read as gaps: keep them from becoming huge empty areas
    bands.push({ w: c < 0 ? Math.min(w * 0.6, 1.5) : w, c, tone, thin });
    prevPaper = c === -1;
    prev = c;
  }
  // the LUT wraps (fract): make the last band differ from the first
  const first = bands[0], last = bands[bands.length - 1];
  if (last.c === first.c) {
    if (monochrome) last.c = first.c === -1 ? 0 : -1;
    else if (cols.length > 1) {
      for (let i = 0; i < cols.length; i++) {
        const prevC = bands.length > 1 ? bands[bands.length - 2].c : -2;
        if (i !== first.c && i !== prevC) { last.c = i; break; }
      }
    }
  }

  const total = bands.reduce((s, b) => s + b.w, 0);
  const starts = [];
  let cum = 0;
  for (const b of bands) {
    const t0 = cum / total;
    cum += b.w;
    if ((cum / total - t0) * LUT_SIZE >= 2) starts.push({ t: t0, ink: b.c >= 0, thin: !!b.thin });
  }
  if (!starts.length) starts.push({ t: 0, ink: true, thin: false });
  const lut = new Uint8Array(LUT_SIZE * 4);
  let acc = 0, bi = 0;
  let end = (bands[0].w / total) * LUT_SIZE;
  for (let t = 0; t < LUT_SIZE; t++) {
    while (t + 0.5 > end && bi < bands.length - 1) { bi++; acc = end; end = acc + (bands[bi].w / total) * LUT_SIZE; }
    const b = bands[bi];
    const o = t * 4;
    if (b.c < 0) { lut[o] = lut[o + 1] = lut[o + 2] = lut[o + 3] = 0; continue; }
    const rgb = cols[b.c];
    lut[o] = rgb[0]; lut[o + 1] = rgb[1]; lut[o + 2] = rgb[2];
    lut[o + 3] = 1 + Math.round(b.tone * 254); // alpha 0 = bare paper, otherwise band tone
  }
  return { lut, starts };
}
