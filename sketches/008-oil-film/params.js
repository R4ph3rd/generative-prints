// params.js
// Defaults, presets and palette slot helpers for 008-oil-film (shared by sketch.js and dev.html).
import { PALETTES, MAX_COLORS, resolvePalette } from './scene.js';

export const SLOT_KEYS = Array.from({ length: MAX_COLORS }, (_, i) => `c${i}`);

/** Colour params of a palette ('random' resolved by seed): colorCount + c0..c7. */
export function paletteColors(key, seed = 1) {
  const pal = PALETTES[resolvePalette(key, seed)];
  const cols = pal.colors.slice(0, MAX_COLORS);
  const out = { colorCount: Math.max(2, cols.length) };
  for (let i = 0; i < MAX_COLORS; i++) out[`c${i}`] = cols[Math.min(i, cols.length - 1)];
  return out;
}

// Look params get these values unless a preset says otherwise.
export const DEFAULTS = {
  seed: 12,
  // field
  scale: 1.1,             // noise cells per short side (x 0.44)
  warp: 1.4,              // k in f(p + k fbm(p + k fbm(p)))
  warpIterations: 2,      // nesting depth (1..3)
  octaves: 3,
  crease: 0.8,            // fold of the inner warp (|.|): sharp crease lines
  creaseSoft: 0.25,       // width of the crease fold (smaller = crisper)
  creaseAsym: 0.7,        // 0 = symmetric ridge fold, 1 = one-sided drape fold
  sweep: 0.8,             // linear slope of the thickness: long S-folds instead of closed rings
  elongation: 0.2,        // stretch the forms along the drift direction (drips)
  stretch: 0,             // extra anisotropy along angle
  angle: 0,
  zoom: 1.0,
  offsetX: 0,
  offsetY: 0,
  // film / colour
  rampFreq: 1.8,          // ramp cycles per unit of thickness
  rampPhase: 0.4,
  gradInfluence: 0.5,     // steep -> bright bands, flat -> dark plateaus
  plateau: 0.22,          // fraction of each ramp cycle held at the plateau colour
  gloss: 0.05,
  palette: 'oil',
  ...paletteColors('oil'),
  hueShift: 0,
  saturation: 0.9,
  contrast: 1.0,
  exposure: 0.0,
  grain: 0.04,
  vignette: 0.2,
  // motion
  speed: 1.0,
  fixedStep: false,
  loopSeconds: 30,
  driftAngle: 55,         // drift direction, deg clockwise from screen +x (45 = towards bottom-right)
  drift: 0.085,           // drift speed, short sides per second of sketch time
  detailSpeed: 1.1,       // each finer octave drifts this much faster (drips run ahead of the big folds)
  flow: 1.0,              // churn: the local wobble (loop-circle morphing) on top of the drift (0 = pure drift)
  time: 0,
  playing: true,
  previewScale: 0.75,
  frame: 'video',
  // still export
  paper: '9x16',
  orientation: 'portrait',
  dpi: 300,
  customW: 400,
  customH: 500,
  stillSS: 2,
  // video export
  videoSize: '1080x1920',
  videoFps: 30,
  videoLength: 30,          // target video length, seconds (see videoFit)
  videoFit: 'loop',         // 'loop': exact length + speed (export loop period resized) · 'loops': keep speed+loop, ≈ length · 'exact': nudge speed
  videoBitrate: 30,
  videoFormat: 'mp4',
  videoSS: 2,
  // preview
  view: 'fit',
};

/** Keys a preset / reset does not touch (seed, output, motion transport). */
export const NON_LOOK_KEYS = new Set([
  'seed', 'speed', 'fixedStep', 'loopSeconds', 'time', 'playing', 'previewScale', 'frame',
  'paper', 'orientation', 'dpi', 'customW', 'customH', 'stillSS',
  'videoSize', 'videoFps', 'videoLength', 'videoFit', 'videoBitrate', 'videoFormat', 'videoSS', 'view',
]);

// One-click looks: DEFAULTS (look keys) + these overrides + the palette colours.
export const PRESETS = {
  'Oil slick': {},
  'Silk folds': {
    warp: 1.1, warpIterations: 2, crease: 1.0, creaseSoft: 0.12, creaseAsym: 1.0, sweep: 1.0, elongation: 0.2, driftAngle: 60, rampFreq: 1.7,
    plateau: 0.25, gradInfluence: 0.75, gloss: 0.15,
  },
  'Soft holo': {
    palette: 'holo', scale: 1.1, warp: 1.2, crease: 0.3, creaseSoft: 0.7, octaves: 3, rampFreq: 1.2, plateau: 0.1,
    gradInfluence: 0.25, gloss: 0.2, saturation: 1.0, vignette: 0.1,
  },
  'Ember crease': {
    palette: 'ember', warp: 1.1, crease: 0.9, creaseSoft: 0.2, rampFreq: 1.6, plateau: 0.3,
    gradInfluence: 0.7, gloss: 0.1, saturation: 1.0,
  },
  'Aurora drift': {
    palette: 'aurora', scale: 1.1, warp: 1.4, elongation: 0.3, driftAngle: 75, drift: 0.09, flow: 1.2, rampFreq: 1.5, plateau: 0.3, gloss: 0.08,
    saturation: 1.0,
  },
};

/** Full look of a preset (palette colours included). */
export function presetLook(name, seed = 1) {
  const pr = PRESETS[name];
  if (!pr) return null;
  const look = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!NON_LOOK_KEYS.has(k)) look[k] = v;
  Object.assign(look, pr, paletteColors(pr.palette || DEFAULTS.palette, seed));
  return look;
}
