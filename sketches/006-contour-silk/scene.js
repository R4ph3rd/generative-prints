// scene.js
// Seeded, resolution-independent description of a "contour silk" picture:
//   - a resolved palette: ground, empty-ribbon fill, base line colour and a
//     density ramp (low density -> high density), all baked to LINEAR rgb,
//   - a seeded set of 32 uniform phases used for noise offsets / directions.
//
// Values here are plain colour data and seeded randoms. The renderer
// (contour-gl.js) reads the live params (scale, warp, lineCount, ...) at draw
// time, so sliders do not need a scene rebuild. Only seed and palette change
// the scene.
//
// Coordinates: short side of the image = 1, origin at the image centre, y up.
// Independent random streams (sub-seeds) for palette pick and phases, so
// changing one does not reshuffle the other.

export const MAX_RAMP = 8;
export const PHASE_COUNT = 32;

// Ramps run from low line density (cool / faint) through white to high
// density (warm). Line colours contrast with the ground.
export const PALETTES = {
  indigo: {
    label: 'Indigo',
    ground: '#1b1c6b',
    ribbon: '#17186a',
    line: '#b9b6e8',
    ramp: ['#8f8fd6', '#d9d4f2', '#fff4ea', '#ffd2b0', '#f5a46e', '#d9683c'],
  },
  ember: {
    label: 'Ember',
    ground: '#0a0806',
    ribbon: '#120d08',
    line: '#c9892e',
    ramp: ['#7a4a1a', '#c9892e', '#ffd27a', '#fff4dc', '#ffb347', '#e8641e'],
  },
  paper: {
    label: 'Paper',
    ground: '#f4efe3',
    ribbon: '#ebe4d2',
    line: '#1f2a4a',
    ramp: ['#2b3a6b', '#1f2a4a', '#3d4f86', '#8a2a22', '#c8382b', '#e0533a'],
  },
  mint: {
    label: 'Mint',
    ground: '#0b3d3f',
    ribbon: '#093437',
    line: '#8fe3c8',
    ramp: ['#5fd3b0', '#b8f2e0', '#ffffff', '#ffc2b0', '#ff7f6b'],
  },
  rose: {
    label: 'Rose',
    ground: '#3a1630',
    ribbon: '#321229',
    line: '#f2a7c8',
    ramp: ['#e27aa8', '#ffd1e6', '#fff8f2', '#ffe7a3', '#f2c24a'],
  },
  noir: {
    label: 'Noir',
    ground: '#070707',
    ribbon: '#0c0c0c',
    line: '#8a8a8a',
    ramp: ['#4a4a4a', '#9a9a9a', '#e6e6e6', '#ffffff'],
  },
  blueprint: {
    label: 'Blueprint',
    ground: '#1a4fb0',
    ribbon: '#1846a0',
    line: '#e9f3ff',
    ramp: ['#e9f3ff', '#ffffff', '#b8f4ff', '#5fe3ff'],
  },
  sunset: {
    label: 'Sunset',
    ground: '#2a1247',
    ribbon: '#24103f',
    line: '#f0a6c8',
    ramp: ['#f07aa8', '#ff9cb0', '#ffc27a', '#ffe27a', '#ffb13b'],
  },
  forest: {
    label: 'Forest',
    ground: '#14291c',
    ribbon: '#112317',
    line: '#9cc7a5',
    ramp: ['#7fb08a', '#c8dcb8', '#f5f0dc', '#e8c46a', '#d99a2b'],
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
 * @param {object} P params. Uses palette.
 * @returns {object} scene: { ground, ribbon, line, ramp, rampCount, phases, info }
 */
export function buildScene(seed, P = {}) {
  seed = num(seed, 1) >>> 0;

  // palette: 'random' -> pick by seed; unknown -> indigo
  let palKey = P.palette;
  if (palKey === 'random') {
    const r = mulberry32(sub(seed, 1))();
    palKey = PALETTE_KEYS[Math.floor(r * PALETTE_KEYS.length)];
  }
  if (!Object.prototype.hasOwnProperty.call(PALETTES, palKey)) palKey = 'indigo';
  const pal = PALETTES[palKey];

  const lin = (hex) => Float32Array.from(hexToLinear(hex));

  // ramp: linear rgb, unused slots repeat the last colour
  const rampHex = pal.ramp.slice(0, MAX_RAMP);
  const rampCount = rampHex.length;
  const ramp = new Float32Array(MAX_RAMP * 3);
  for (let i = 0; i < MAX_RAMP; i++) {
    const rgb = hexToLinear(rampHex[Math.min(i, rampCount - 1)]);
    ramp[i * 3] = rgb[0]; ramp[i * 3 + 1] = rgb[1]; ramp[i * 3 + 2] = rgb[2];
  }

  // seeded uniforms for noise offsets / directions (own stream)
  const pr = mulberry32(sub(seed, 3));
  const phases = new Float32Array(PHASE_COUNT);
  for (let i = 0; i < PHASE_COUNT; i++) phases[i] = pr();

  return {
    ground: lin(pal.ground),
    ribbon: lin(pal.ribbon),
    line: lin(pal.line),
    ramp,
    rampCount,
    phases,
    info: { palette: pal.label },
  };
}
