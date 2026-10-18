// scene.js
// Seeded, resolution-independent description of a "liquid marble" picture:
//   - a resolved palette: band colours (band order), plus the line, chromatic
//     fringe colours and paper colour, all baked to LINEAR rgb,
//   - a seeded set of 32 uniform phases used for noise offsets / directions.
//
// Values here are plain colour data and seeded randoms. The renderer
// (marble-gl.js) reads the live params (scale, warp, bands, grain, ...) at draw
// time, so sliders do not need a scene rebuild. Only seed, palette and
// colorOrder change the scene.
//
// Coordinates: short side of the image = 1, origin at the image centre, y up.
// Independent random streams (sub-seeds) for palette pick, colour shuffle and
// phases, so changing one does not reshuffle the others.

export const MAX_COLORS = 8;
export const PHASE_COUNT = 32;

// Band colours are listed in band order (neighbouring bands contrast).
export const PALETTES = {
  tricolore: {
    label: 'Tricolore',
    colors: ['#d9434f', '#1b2a6b', '#f4f1ee', '#3a5bbf'],
    line: '#fffaf2',
    fringeA: '#ff5fa8',
    fringeB: '#4fe3ff',
    paper: '#141a3a',
  },
  sunset: {
    label: 'Sunset',
    colors: ['#ff6f5e', '#f7a072', '#8e3b6e', '#fff1e0'],
    line: '#fff6ea',
    fringeA: '#ffd23f',
    fringeB: '#5ad2e6',
    paper: '#2a0f2b',
  },
  lagoon: {
    label: 'Lagoon',
    colors: ['#18b5b0', '#7fe3d8', '#0b2f5c', '#e9d8b4'],
    line: '#f8fffd',
    fringeA: '#ff6fb5',
    fringeB: '#9af7ff',
    paper: '#06213f',
  },
  tidepool: {
    label: 'Tidepool',
    colors: ['#f3f1ec', '#3f8f8c', '#e3b448', '#f3f1ec', '#2e4256'],
    line: '#ffffff',
    fringeA: '#ff6ad5',
    fringeB: '#7dffb0',
    paper: '#1c2a38',
  },
  rosewood: {
    label: 'Rosewood',
    colors: ['#f4eeee', '#d9697a', '#4a2326', '#e98c95'],
    line: '#ffffff',
    fringeA: '#ffa94d',
    fringeB: '#5fe0ff',
    paper: '#2a1214',
  },
  aurora: {
    label: 'Aurora',
    colors: ['#1f6b57', '#f2f4f0', '#5fc4b0', '#0f3d33', '#a8e6cf'],
    line: '#fbfff8',
    fringeA: '#ffe14d',
    fringeB: '#ff4fd8',
    paper: '#08241e',
  },
  citrus: {
    label: 'Citrus',
    colors: ['#f2f1ea', '#8db32a', '#f0d419', '#2f6b3a', '#c9d94a'],
    line: '#fffef6',
    fringeA: '#ff7ad9',
    fringeB: '#3fd6ff',
    paper: '#1b3320',
  },
  abyss: {
    label: 'Abyss',
    colors: ['#0b4f8a', '#1a78b8', '#8fb8de', '#0a3566', '#5aa2d8'],
    line: '#d6ebff',
    fringeA: '#7ff0ff',
    fringeB: '#c39bff',
    paper: '#05213f',
  },
  apricot: {
    label: 'Apricot',
    colors: ['#f5f2ee', '#d9693a', '#e8b24a', '#b9d2dc', '#f2a98a'],
    line: '#ffffff',
    fringeA: '#ff79c6',
    fringeB: '#6ae4ff',
    paper: '#3a1c10',
  },
  coral: {
    label: 'Coral',
    colors: ['#e5463e', '#f5efe9', '#ef7b6c', '#c8312f'],
    line: '#ffffff',
    fringeA: '#37e3d0',
    fringeB: '#ffd84a',
    paper: '#3d0c0b',
  },
  magenta: {
    label: 'Magenta',
    colors: ['#3a1cff', '#a51cf0', '#ff2aa0', '#ff3f6c', '#ff1f5a'],
    line: '#ffd6f2',
    fringeA: '#ff9de6',
    fringeB: '#6aa0ff',
    paper: '#1a0866',
  },
  periwinkle: {
    label: 'Periwinkle',
    colors: ['#4a4fd6', '#7b83ea', '#b9bff7', '#6a62e0', '#e6e7fc'],
    line: '#ffffff',
    fringeA: '#ff9ee8',
    fringeB: '#8ff0ff',
    paper: '#1a1b5c',
  },
  glacier: {
    label: 'Glacier',
    colors: ['#0d3a63', '#8ee3ff', '#2fb6e6', '#cfeffc', '#2b5b8a'],
    line: '#f4fcff',
    fringeA: '#ffb84d',
    fringeB: '#ff6ac1',
    paper: '#061d33',
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
/**
 * Build the scene description.
 * @param {number} seed
 * @param {object} P params. Uses palette, colorOrder.
 * @returns {object} scene: { colors, colorCount, line, fringeA, fringeB, paper, phases, info }
 */
export function buildScene(seed, P = {}) {
  seed = num(seed, 1) >>> 0;

  // palette: 'random' -> pick by seed; unknown -> tricolore
  let palKey = P.palette;
  if (palKey === 'random') {
    const r = mulberry32(sub(seed, 1))();
    palKey = PALETTE_KEYS[Math.floor(r * PALETTE_KEYS.length)];
  }
  if (!PALETTES[palKey]) palKey = 'tricolore';
  const pal = PALETTES[palKey];

  // band colours, optionally permuted with a seeded rng (own stream)
  const order = pal.colors.slice(0, MAX_COLORS);
  if (P.colorOrder === 'shuffle') {
    const r = mulberry32(sub(seed, 2));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const colors = new Float32Array(MAX_COLORS * 3);
  const colorCount = order.length;
  for (let i = 0; i < MAX_COLORS; i++) {
    const rgb = hexToLinear(order[Math.min(i, colorCount - 1)]);
    colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
  }

  const lin = (hex) => Float32Array.from(hexToLinear(hex));

  // seeded uniforms for noise offsets / directions (own stream)
  const pr = mulberry32(sub(seed, 3));
  const phases = new Float32Array(PHASE_COUNT);
  for (let i = 0; i < PHASE_COUNT; i++) phases[i] = pr();

  return {
    colors,
    colorCount,
    line: lin(pal.line),
    fringeA: lin(pal.fringeA),
    fringeB: lin(pal.fringeB),
    paper: lin(pal.paper),
    phases,
    info: { palette: pal.label },
  };
}
