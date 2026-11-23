// scene.js
// Seeded, resolution-independent description of an "oil film" picture: the palette
// presets (cyclic colour ramps) and a seeded set of 32 uniform phases used for the
// noise offsets / loop-circle directions.
//
// Colours are not part of the scene: they live in the editable params c0..c7
// (colorCount of them), so editing a slot is live without a rebuild. Only the seed
// changes the scene.
//
// Coordinates: short side of the image = 1, origin at the image centre, y up.

export const MAX_COLORS = 8;
export const PHASE_COUNT = 32;

// Each ramp is CYCLIC: the last colour blends back into the first. The first colour
// is the "plateau" colour (the dark film where the thickness field is flat).
export const PALETTES = {
  oil: {
    label: 'Oil slick',
    colors: ['#0d052e', '#0a2cd0', '#1a5cff', '#3fd6a0', '#c9a6d8', '#e0a8c8', '#e8602a', '#5a1408'],
  },
  holo: {
    label: 'Holo pastel',
    colors: ['#2a2350', '#7fa8ff', '#a8f0e0', '#fff2fb', '#ffb8d8', '#b98cff', '#4a3a7a'],
  },
  ember: {
    label: 'Ember',
    colors: ['#0b0303', '#3a0a06', '#b3220e', '#ff7a2a', '#ffd27a', '#fff1d6', '#7a1a0a'],
  },
  aurora: {
    label: 'Aurora',
    colors: ['#020a12', '#06305a', '#00a3a3', '#5cff9d', '#e8ffb0', '#8a4dff', '#1a0a3a'],
  },
  pearl: {
    label: 'Pearl',
    colors: ['#141418', '#5a5e6a', '#c9ccd6', '#fbfaf7', '#e6d9cf', '#8a8f9c', '#2c2e36'],
  },
  mono: {
    label: 'Mono chrome',
    colors: ['#000000', '#2a2a2a', '#8a8a8a', '#ffffff', '#5a5a5a'],
  },
  petrol: {
    label: 'Petrol',
    colors: ['#02060a', '#003a4f', '#00c2b8', '#f2e86d', '#ff4f9a', '#4b1a6e'],
  },
};
export const PALETTE_KEYS = Object.keys(PALETTES);

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
export const sub = (seed, k) => (Math.imul((seed >>> 0) ^ 0x85ebca6b, 0x27d4eb2d) + Math.imul(k, 0x9e3779b1)) >>> 0;

/** 'random' -> a palette key picked by seed; unknown -> 'oil'. */
export function resolvePalette(key, seed) {
  if (key === 'random') {
    const r = mulberry32(sub(num(seed, 1) >>> 0, 1))();
    return PALETTE_KEYS[Math.floor(r * PALETTE_KEYS.length)];
  }
  return Object.prototype.hasOwnProperty.call(PALETTES, key) ? key : 'oil';
}

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
 * @returns {object} scene: { phases, info }
 */
export function buildScene(seed) {
  seed = num(seed, 1) >>> 0;
  const pr = mulberry32(sub(seed, 3));
  const phases = new Float32Array(PHASE_COUNT);
  for (let i = 0; i < PHASE_COUNT; i++) phases[i] = pr();
  return { phases, info: {} };
}
