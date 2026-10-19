// scene.js
// Seeded, resolution-independent description of a "groovy swirl" picture:
//   - a resolved palette: region colours (large flowing streams), blob colours
//     (droplets floating inside the streams), outline and background colours,
//     all baked to LINEAR rgb,
//   - seeded vortex centres (spiral points where the streams wind in),
//   - a seeded set of 32 uniform phases used for noise offsets / directions.
//
// Values here are plain colour data and seeded randoms. The renderer
// (groovy-gl.js) reads the live params (scale, flowWarp, blobs, outline, ...)
// at draw time, so sliders do not need a scene rebuild. Only seed, palette and
// colorOrder change the scene.
//
// Coordinates: short side of the image = 1, origin at the image centre, y up.
// Independent random streams (sub-seeds) for palette pick, colour shuffle
// (regions and blobs separately), vortices and phases, so changing one does
// not reshuffle the others.

export const MAX_COLORS = 10;
export const MAX_VORTICES = 4;
export const PHASE_COUNT = 32;

// Region colours are listed in stream order (neighbouring colours contrast).
// Blob colours should pop against the regions and may share a few colours.
export const PALETTES = {
  groovy: {
    label: 'Groovy',
    regions: ['#7b9ccc', '#5a6283', '#ec8a35', '#e85d55', '#f1e8d8', '#2f7db6'],
    blobs: ['#dfa83f', '#f1e8d8', '#e85d55', '#7cc4d6', '#9474c9', '#f39a9a', '#a08ea8'],
    outline: '#1e1b2b',
    background: '#f1e8d8',
  },
  sunbleached: {
    label: 'Sun-bleached',
    regions: ['#b5573a', '#e3c79a', '#3f8b8a', '#7d7a3c', '#d98c7a'],
    blobs: ['#f4ead6', '#d9a441', '#9fcfc4', '#b5573a', '#f4ead6'],
    outline: '#2a2118',
    background: '#efe3cc',
  },
  lava: {
    label: 'Lava',
    regions: ['#7a1f2b', '#c8402a', '#f08a3c', '#5b1a4a'],
    blobs: ['#ffd166', '#ff9a5c', '#f7e7d0', '#ff5c4d', '#ffd166'],
    outline: '#1a0d12',
    background: '#2b0f16',
  },
  pastel: {
    label: 'Pastel',
    regions: ['#b8e6d0', '#f8c4a8', '#c9b8ec', '#fbf0a6'],
    blobs: ['#8fa6e8', '#ff8fab', '#fff9e6', '#7fd1ae', '#8fa6e8'],
    outline: '#2d2a4a',
    background: '#fdf8f2',
  },
  seventies: {
    label: 'Seventies',
    regions: ['#6b3e26', '#d9a02b', '#e0622c', '#7b8a2e'],
    blobs: ['#f6e4bf', '#f2a03d', '#b5452a', '#ffd88a', '#f6e4bf'],
    outline: '#2a170d',
    background: '#f3dfb8',
  },
  ocean: {
    label: 'Ocean',
    regions: ['#12305a', '#1f8a8f', '#6fd3dc', '#0b1f3d', '#3fb6c9'],
    blobs: ['#f2fbfb', '#ff7a66', '#ffd27a', '#3fb6c9', '#f2fbfb'],
    outline: '#071629',
    background: '#e8f7f8',
  },
  candyland: {
    label: 'Candyland',
    regions: ['#ff3d8b', '#c49cf0', '#7fc8ff', '#ff8fc7'],
    blobs: ['#fff06b', '#ffffff', '#6ee7b7', '#7b2ff7', '#fff06b'],
    outline: '#2a0f3a',
    background: '#fff4fb',
  },
  'mono-blue': {
    label: 'Mono blue',
    regions: ['#0b3d91', '#2a6fc4', '#6fa8e6', '#1a4f9c', '#a9cbef'],
    blobs: ['#f5efe0', '#e8f4ff', '#0a2a66', '#8fc1f2', '#f5efe0'],
    outline: '#06173a',
    background: '#f0f6ff',
  },
  forest: {
    label: 'Forest',
    regions: ['#1f4d2b', '#4f8a3c', '#8fb55a', '#2d6b4a'],
    blobs: ['#d9a441', '#f3ead2', '#c7e07a', '#b5542f', '#f3ead2'],
    outline: '#0f2415',
    background: '#efe9d2',
  },
  noir: {
    label: 'Noir',
    regions: ['#0e0e10', '#3a3a40', '#7a7a82', '#d8d4cc', '#1b1b1f'],
    blobs: ['#f2ede4', '#d7263d', '#9a9aa3', '#e6e1d6', '#d7263d'],
    outline: '#050506',
    background: '#0c0c0e',
  },
  tricolore: {
    label: 'Tricolore',
    regions: ['#d32f3a', '#1f3f8f', '#f4f1ee', '#2f5fbf'],
    blobs: ['#f4f1ee', '#d32f3a', '#ffd23f', '#2f5fbf'],
    outline: '#141a33',
    background: '#f4f1ee',
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

// ---------------------------------------------------------------- colour
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** '#rrggbb' -> linear RGB [0..1] */
export function hexToLinear(hex) {
  return hexToRgb(hex).map((v) => s2l(v / 255));
}

// ---------------------------------------------------------------- scene
function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// fixed-size linear colour array; unused slots repeat the last colour
function colorArray(hexes) {
  const arr = new Float32Array(MAX_COLORS * 3);
  const n = Math.min(hexes.length, MAX_COLORS);
  for (let i = 0; i < MAX_COLORS; i++) {
    const rgb = hexToLinear(hexes[Math.min(i, n - 1)]);
    arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2];
  }
  return { arr, count: n };
}

/**
 * Build the scene description.
 * @param {number} seed
 * @param {object} P params. Uses palette, colorOrder.
 * @returns {object} scene: { regions, regionCount, blobs, blobCount, outline,
 *   background, vortices, phases, info }
 */
export function buildScene(seed, P = {}) {
  seed = num(seed, 1) >>> 0;

  // palette: 'random' -> pick by seed; unknown -> groovy
  let palKey = P.palette;
  if (palKey === 'random') {
    const r = mulberry32(sub(seed, 1))();
    palKey = PALETTE_KEYS[Math.floor(r * PALETTE_KEYS.length)];
  }
  if (!PALETTES[palKey]) palKey = 'groovy';
  const pal = PALETTES[palKey];

  // colour lists, optionally shuffled with their own seeded streams
  let regionHex = pal.regions.slice(0, MAX_COLORS);
  let blobHex = pal.blobs.slice(0, MAX_COLORS);
  if (P.colorOrder === 'shuffle') {
    regionHex = shuffled(regionHex, mulberry32(sub(seed, 2)));
    blobHex = shuffled(blobHex, mulberry32(sub(seed, 6)));
  }
  const regions = colorArray(regionHex);
  const blobs = colorArray(blobHex);

  const lin = (hex) => Float32Array.from(hexToLinear(hex));

  // vortex centres (own stream). First vortex biased to the lower-right quadrant.
  const vr = mulberry32(sub(seed, 4));
  const vortices = new Float32Array(MAX_VORTICES * 4);
  for (let i = 0; i < MAX_VORTICES; i++) {
    let x, y;
    if (i === 0) {
      x = 0.05 + vr() * 0.3;
      y = -0.45 + vr() * 0.3;
    } else {
      x = -0.6 + vr() * 1.2;
      y = -0.6 + vr() * 1.2;
    }
    const spin = vr() < 0.5 ? -1 : 1;
    const strength = 0.5 + vr() * 0.5;
    vortices[i * 4] = x;
    vortices[i * 4 + 1] = y;
    vortices[i * 4 + 2] = spin;
    vortices[i * 4 + 3] = strength;
  }

  // seeded uniforms for noise offsets / directions (own stream)
  const pr = mulberry32(sub(seed, 3));
  const phases = new Float32Array(PHASE_COUNT);
  for (let i = 0; i < PHASE_COUNT; i++) phases[i] = pr();

  return {
    regions: regions.arr,
    regionCount: regions.count,
    blobs: blobs.arr,
    blobCount: blobs.count,
    outline: lin(pal.outline),
    background: lin(pal.background),
    vortices,
    phases,
    info: { palette: pal.label },
  };
}
