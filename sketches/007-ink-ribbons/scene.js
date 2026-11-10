// scene.js
// Seeded, resolution-independent data for an "ink ribbons" picture:
//   - palettes (paper ground, ink, accent, echo outline, three wash colours, frame),
//   - hash / value-noise helpers shared with the renderer,
//   - the background shapes (watercolour blobs): positions, sizes and pre-deformed
//     polygons in unit space (unit radius, centred), so size / count sliders
//     never reshuffle them.
//
// The ribbons themselves are not stored: the renderer derives them every frame
// from the live params and hash4(seed, ...), so every ribbon slider is live.
//
// Coordinates: image width = 1, origin top-left, y down, image height = H / W.

export const MAX_SHAPES = 40;
export const WASH_LAYERS = 22;

// ground (paper, also the fill of opaque ribbons), ink (main lines), accent (highlight
// lines), echo (offset outlines), wash (background shape colours), frame (border),
// backdrop (coloured background inside the padding, full-page composition)
export const PALETTES = {
  cobalt: {
    label: 'Cobalt & ink',
    ground: '#f5f3ef', ink: '#141414', accent: '#3c4fd9', echo: '#8a8a8a',
    wash: ['#9aa7f0', '#3c4fd9', '#c9cff7'], frame: '#141414', backdrop: '#3c4fd9',
  },
  vermilion: {
    label: 'Vermilion',
    ground: '#f7f4ee', ink: '#1a1a1a', accent: '#e8432b', echo: '#f29a7f',
    wash: ['#f6b3a3', '#e8432b', '#ffd6c9'], frame: '#1a1a1a', backdrop: '#e8432b',
  },
  carmine: {
    label: 'Carmine pen',
    ground: '#f3f1ec', ink: '#c4122f', accent: '#7d0a1f', echo: '#e86a7d',
    wash: ['#f6c9cf', '#f0a5ae', '#e07a88'], frame: '#1e1e1e', backdrop: '#1f2a44',
  },
  sumi: {
    label: 'Sumi & coral',
    ground: '#efebe2', ink: '#2c2b2a', accent: '#d6262c', echo: '#e3825c',
    wash: ['#f2a184', '#ec8a6e', '#8e3d55'], frame: '#2c2b2a', backdrop: '#3c4fd9',
  },
  indigo: {
    label: 'Indigo ink',
    ground: '#f0ece3', ink: '#1d2a5b', accent: '#c8553d', echo: '#6f86c6',
    wash: ['#a9bde0', '#e6b09c', '#3a4f8f'], frame: '#1d2a5b', backdrop: '#e2a93b',
  },
  tricolore: {
    label: 'Tricolore',
    ground: '#f4f1ee', ink: '#1b2a6b', accent: '#d9434f', echo: '#3a5bbf',
    wash: ['#e98b93', '#9fb0e6', '#d9434f'], frame: '#1b2a6b', backdrop: '#d9434f',
  },
  sunset: {
    label: 'Sunset',
    ground: '#2a0f2b', ink: '#fff1e0', accent: '#ff6f5e', echo: '#ffd23f',
    wash: ['#8e3b6e', '#ff6f5e', '#f7a072'], frame: '#f7a072', backdrop: '#ff6f5e',
  },
  lagoon: {
    label: 'Lagoon',
    ground: '#06213f', ink: '#e9f7f4', accent: '#18b5b0', echo: '#7fe3d8',
    wash: ['#18b5b0', '#0b2f5c', '#e9d8b4'], frame: '#7fe3d8', backdrop: '#18b5b0',
  },
  sepia: {
    label: 'Sepia',
    ground: '#efe4cf', ink: '#4a2e1d', accent: '#a0522d', echo: '#c08a5a',
    wash: ['#d9b88f', '#c9906a', '#7a4a2e'], frame: '#4a2e1d', backdrop: '#7a8f6b',
  },
  forest: {
    label: 'Forest',
    ground: '#eef0e6', ink: '#1f3a2b', accent: '#d98c2b', echo: '#6f9c7a',
    wash: ['#b7cfa8', '#e3c07a', '#4d7a5c'], frame: '#1f3a2b', backdrop: '#d98c2b',
  },
  blush: {
    label: 'Blush',
    ground: '#f7ece8', ink: '#3b2c4f', accent: '#e2557a', echo: '#9b7fc0',
    wash: ['#f2b8c6', '#d9c2ef', '#f6d6a8'], frame: '#3b2c4f', backdrop: '#3b2c4f',
  },
  noir: {
    label: 'Noir',
    ground: '#111111', ink: '#ecebe6', accent: '#e0533a', echo: '#8a8a8a',
    wash: ['#3a3a3a', '#5a2a24', '#2a2a2a'], frame: '#ecebe6', backdrop: '#c8382b',
  },
};

// ---------------------------------------------------------------- random
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash of four integers -> [0, 1). */
export function hash4(a, b, c, d) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77) ^ Math.imul((c | 0) + 0x7f4a7c15, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 13), 0x2c1b3c6d) ^ Math.imul((d | 0) + 0x1b873593, 0x297a2d39);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Seeded 3D value noise in [-1, 1]. */
export function noise3(seed, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const h = (i, j, k) => hash4(seed, xi + i, yi + j, (zi + k) * 7919);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * u;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * u;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * u;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

// ---------------------------------------------------------------- colour
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbCss = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Relative luminance 0..1 of '#rrggbb' (rough, gamma-encoded). */
export const luminance = (hex) => { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

// ---------------------------------------------------------------- shapes
const sub = (seed, k) => (Math.imul((seed >>> 0) ^ 0x85ebca6b, 0x27d4eb2d) + Math.imul(k, 0x9e3779b1)) >>> 0;

function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One deformation pass of a closed polygon (flat array x0,y0,x1,y1,...) with per-vertex
 * variance (watercolour technique: recursive midpoint displacement).
 */
function deform(pts, vars, r, amount) {
  const out = [], ov = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const v = (vars[i] + vars[j]) * 0.5;
    out.push(ax, ay); ov.push(vars[i]);
    const s = len * v * amount;
    out.push((ax + bx) / 2 + gauss(r) * s, (ay + by) / 2 + gauss(r) * s);
    ov.push(v * (0.7 + 0.3 * r()));
  }
  return [out, ov];
}

function deformN(pts, vars, r, amount, n) {
  let p = pts, v = vars;
  for (let k = 0; k < n; k++) [p, v] = deform(p, v, r, amount);
  return [p, v];
}

/**
 * Build the scene description.
 * @param {number} seed
 * @param {object} P params. Uses shapeIrregularity (polygon roughness).
 * @returns {object} scene: { seed, shapes: [{x, y, size, drop, color, base: Float32Array, layers: Float32Array[]}] }
 */
export function buildScene(seed, P = {}) {
  seed = (Number.isFinite(seed) ? seed : 1) >>> 0;
  const irr = Number.isFinite(P.shapeIrregularity) ? P.shapeIrregularity : 0.5;
  const r = mulberry32(sub(seed, 11));
  const shapes = [];
  for (let i = 0; i < MAX_SHAPES; i++) {
    const drop = r() < 0.3;
    const x = r(), y = r();
    const size = drop ? 0.08 + r() * 0.12 : 0.45 + Math.pow(r(), 1.5) * 0.9;
    const color = Math.floor(r() * 3);
    // base polygon: 10 vertices on a unit circle with radial jitter and per-vertex variance
    const nv = 10, pts = [], vars = [];
    const squash = 1 + (r() - 0.5) * 0.35 * irr, rot = r() * Math.PI * 2;
    for (let k = 0; k < nv; k++) {
      const a = (k / nv) * Math.PI * 2;
      const rad = 1 + (r() - 0.5) * 0.25 * irr;
      const px = Math.cos(a) * rad * squash, py = Math.sin(a) * rad / squash;
      pts.push(px * Math.cos(rot) - py * Math.sin(rot), px * Math.sin(rot) + py * Math.cos(rot));
      vars.push(0.4 + r() * 0.8);
    }
    const amt = 0.05 + 0.3 * irr;
    const [bp, bv] = deformN(pts, vars, r, amt, 3);
    const layers = [];
    for (let l = 0; l < WASH_LAYERS; l++) {
      const [lp] = deformN(bp, bv, r, amt * 1.2, 2);
      // layers shrink a little towards the top of the stack: soft, slightly darker core
      const k = 1.04 - 0.22 * (l / (WASH_LAYERS - 1)) * (0.7 + 0.6 * r());
      for (let q = 0; q < lp.length; q++) lp[q] *= k;
      layers.push(Float32Array.from(lp));
    }
    shapes.push({ x, y, size, drop, color, base: Float32Array.from(bp), layers });
  }
  return { seed, shapes };
}
