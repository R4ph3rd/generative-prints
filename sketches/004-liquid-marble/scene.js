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
  acid: {
    label: 'Acid',
    colors: ['#c6f432', '#ff2fa6', '#5b1fb3', '#0a0a0a'],
    line: '#fbffe0',
    fringeA: '#ff5ad5',
    fringeB: '#3ef0ff',
    paper: '#050505',
  },
  'mono-ink': {
    label: 'Mono Ink',
    colors: ['#1d1a6b', '#3b35b0', '#7a74e0', '#c9c4f5'],
    line: '#fdfcff',
    fringeA: '#ff6fd0',
    fringeB: '#6cf0ff',
    paper: '#0d0b33',
  },
  candy: {
    label: 'Candy',
    colors: ['#ff7eb6', '#7fffd4', '#b8a1ff', '#fff3a3'],
    line: '#ffffff',
    fringeA: '#ff3d8b',
    fringeB: '#33e0ff',
    paper: '#3a1f4f',
  },
  ember: {
    label: 'Ember',
    colors: ['#120404', '#7a0f1f', '#ff6a1a', '#ffc53d'],
    line: '#fff4d6',
    fringeA: '#ff4fa0',
    fringeB: '#41e6ff',
    paper: '#1a0606',
  },
  forest: {
    label: 'Forest',
    colors: ['#5d7a3a', '#1f3b2d', '#c08a3e', '#efe6cf'],
    line: '#fbf7e8',
    fringeA: '#ff7aa8',
    fringeB: '#7ef0d2',
    paper: '#0f2118',
  },
  riso: {
    label: 'Riso',
    colors: ['#ff48b0', '#0078bf', '#ffe800', '#f2ece0'],
    line: '#fffdf6',
    fringeA: '#ff48b0',
    fringeB: '#00c2ff',
    paper: '#0a2a52',
  },
  noir: {
    label: 'Noir',
    colors: ['#0b0b0d', '#3d3d45', '#8a8a94', '#f2f2f5'],
    line: '#ffffff',
    fringeA: '#ff5c8a',
    fringeB: '#5cd8ff',
    paper: '#000000',
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
