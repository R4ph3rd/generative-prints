// params.js
// Defaults, presets and output formats for 007-ink-ribbons (shared by sketch.js and dev.html).
import { PALETTES } from './scene.js';

// Vertical Instagram formats: width 1080 at 1x, height = width * ratio.
export const FORMATS = {
  '4:5': { label: '4:5 portrait post (1080×1350)', ratio: 5 / 4 },
  '3:4': { label: '3:4 grid post (1080×1440)', ratio: 4 / 3 },
  '9:16': { label: '9:16 story / reel (1080×1920)', ratio: 16 / 9 },
};
export const formatSize = (format, width = 1080) => {
  const f = FORMATS[format] || FORMATS['4:5'];
  const w = Math.round(width / 2) * 2;
  return { width: w, height: Math.round((w * f.ratio) / 2) * 2 };
};

/** Colour params of a palette (they become editable colour fields). */
export function paletteColors(key) {
  const p = PALETTES[key] || PALETTES.cobalt;
  return {
    ground: p.ground, ink: p.ink, accent: p.accent, echo: p.echo,
    wash1: p.wash[0], wash2: p.wash[1], wash3: p.wash[2], frameColor: p.frame, backdropColor: p.backdrop,
  };
}

// Look params get these values unless a preset says otherwise.
export const DEFAULTS = {
  seed: 1234,
  // composition
  format: '4:5',
  composition: 'full',      // 'full' page or 'frames' mosaic
  borderMargin: 0.06,       // padding around the drawing (fraction of width)
  border: true,             // draw the frame line(s)
  borderWidth: 2.2,
  clipToFrame: true,
  backdrop: true,           // coloured background inside the padding (full page only)
  // frames mosaic
  cellCount: 16,
  cellGap: 0.018,
  cellIrregular: 0.35,
  cellJag: 0.4,
  tinyCell: 0.05,
  cellRibbons: 2,
  cellFill: 1.1,
  cellSpacing: 7,
  cellCurl: 0.7,
  cellPinches: 1.5,
  // layout
  layout: 'tangle',
  ribbonCount: 7,
  ribbonWidth: 0.85,
  margin: 0.04,
  sway: 0.35,
  swayFreq: 1.5,
  meander: 0.6,
  turns: 1.6,
  pathLength: 1.7,
  curl: 1.0,
  curlFreq: 1.3,
  weave: 1.0,
  // twist & shape
  pinches: 2.5,
  pinchJitter: 0.4,
  twistNoise: 1.0,
  cup: 0.55,
  cupVar: 0.8,
  tilt: 0.35,
  widthVar: 0.45,
  widthFreq: 2,
  fan: 1.0,
  ruffle: 0.15,
  ruffleFreq: 7,
  // lines
  surface: true,            // opaque ribbons that hide each other
  fillOpacity: 1,
  lines: 30,
  spread: 1.0,
  lineJitter: 0.2,
  lineWidth: 1.5,
  lineWidthVar: 0.25,
  edgeWeight: 1.5,
  coreWeight: 1,
  pressure: 0.25,
  depthWidth: 0.4,
  shade: 0.9,
  lineOpacity: 1,
  dashMix: 0,
  dashLength: 9,
  dashGap: 6,
  axisLine: false,
  // accents
  accentRatio: 0,
  accentLength: 0.35,
  echoCount: 0,
  echoGap: 0.25,
  echoWobble: 0.4,
  echoWidth: 0.9,
  echoOpacity: 0.8,
  // background shapes
  shapes: false,
  shapeStyle: 'watercolor',
  shapeCount: 9,
  shapeSize: 1.0,
  shapeOpacity: 0.55,
  shapeDrops: 1,
  shapeRim: 0.6,
  shapeIrregularity: 0.5,
  shapeBlend: 'auto',
  // colour
  palette: 'cobalt',
  ...paletteColors('cobalt'),
  lineColorMode: 'ink',
  inkBlend: 'auto',
  paperTexture: 0.35,
  // motion
  speed: 1.0,
  fixedStep: false,
  loopSeconds: 12,
  flow: 1,
  flowAlternate: true,
  morph: 0.5,
  time: 0,
  playing: true,
  previewScale: 0.75,
  // still export
  stillScale: 3,
  stillSS: 2,
  // video export
  videoWidth: 1080,
  videoFps: 30,
  videoLoops: 1,
  videoBitrate: 30,
  videoFormat: 'mp4',
  videoSS: 2,
  // preview
  view: 'fit',
};

/** Keys a preset / reset does not touch (seed, output, motion transport). */
export const NON_LOOK_KEYS = new Set([
  'seed', 'format', 'speed', 'fixedStep', 'loopSeconds', 'time', 'playing', 'previewScale',
  'stillScale', 'stillSS', 'videoWidth', 'videoFps', 'videoLoops', 'videoBitrate', 'videoFormat', 'videoSS', 'view',
]);

// One-click looks. Only the listed keys change (plus the palette colours).
// One-click looks: DEFAULTS (look keys) + these overrides + the palette colours.
export const PRESETS = {
  'Tangle on cobalt': {},
  'Ink knots (no backdrop)': {
    backdrop: false, border: false, borderMargin: 0.05, ribbonCount: 5, ribbonWidth: 1.1, pathLength: 2.0,
    curl: 1.2, lines: 34, lineWidth: 1.8, shade: 1.3, cup: 0.7, palette: 'cobalt',
  },
  'Fan ribbons': {
    backdrop: false, border: false, borderMargin: 0.05, ribbonCount: 3, ribbonWidth: 1.0, pathLength: 2.2, curl: 1.3,
    fan: 2.2, ruffle: 0.5, ruffleFreq: 9, coreWeight: 5, edgeWeight: 1.2, lines: 34, lineWidth: 0.9, cup: 0.8,
    tilt: 0.5, shade: 0.8, pinches: 3, palette: 'cobalt', paperTexture: 0.45,
  },
  'Mosaic frames': {
    composition: 'frames', borderMargin: 0.1, backdrop: false, border: true, borderWidth: 1.4, cellCount: 17,
    cellRibbons: 2, cellSpacing: 6, lineWidth: 1.0, shade: 1.2, cup: 0.5, palette: 'carmine', paperTexture: 0.3,
  },
  'Red pen columns': {
    layout: 'columns', ribbonCount: 4, ribbonWidth: 0.62, pinches: 5, cup: 0.5, tilt: 0.4, ruffle: 0, widthVar: 0.3,
    lines: 26, lineWidth: 1.3, edgeWeight: 1.6, shade: 0.3, surface: false, lineOpacity: 0.92, backdrop: false,
    palette: 'carmine',
  },
  'Dashed columns': {
    layout: 'columns', ribbonCount: 4, ribbonWidth: 0.7, sway: 0.4, pinches: 4, cup: 0.45, tilt: 0.35, ruffle: 0,
    widthVar: 0.3, lines: 30, lineWidth: 1.1, edgeWeight: 1.4, dashMix: 0.5, axisLine: true, shade: 0.2,
    surface: false, lineOpacity: 0.92, backdrop: false, palette: 'carmine',
  },
  'Ink meander + wash': {
    layout: 'meander', ribbonCount: 1, ribbonWidth: 0.75, meander: 0.62, turns: 1.7, sway: 0.4, pinches: 2.2,
    cup: 0.45, cupVar: 0.8, tilt: 0.35, widthVar: 0.4, ruffle: 0, lines: 22, lineWidth: 2.6, lineWidthVar: 0.6,
    edgeWeight: 1.8, pressure: 0.45, shade: 0.4, accentRatio: 0.12, accentLength: 0.3, echoCount: 1, echoGap: 0.12,
    border: false, borderMargin: 0, backdrop: false, shapes: true, shapeOpacity: 0.5, palette: 'sumi',
  },
  'Twin meanders': {
    layout: 'meander', ribbonCount: 2, ribbonWidth: 0.9, meander: 0.5, turns: 1.3, pinches: 2.6, cup: 0.35, tilt: 0.3,
    ruffle: 0, lines: 24, lineWidth: 1.4, edgeWeight: 1.5, accentRatio: 0.05, echoCount: 2, echoGap: 0.15,
    border: false, borderMargin: 0, backdrop: false, shapes: true, shapeStyle: 'flat', shapeCount: 6, shapeOpacity: 0.35,
    palette: 'indigo', lineColorMode: 'ribbons',
  },
  'Night rows': {
    layout: 'rows', ribbonCount: 5, ribbonWidth: 0.7, sway: 0.45, pinches: 3, cup: 0.25, tilt: 0.25, ruffle: 0,
    lines: 28, lineWidth: 1.0, edgeWeight: 1.6, dashMix: 0.2, surface: false, backdrop: false,
    shapes: true, shapeCount: 7, shapeOpacity: 0.5, palette: 'lagoon', lineColorMode: 'gradient',
  },
};

/** Full look of a preset (palette colours included). */
export function presetLook(name) {
  const pr = PRESETS[name];
  if (!pr) return null;
  const look = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!NON_LOOK_KEYS.has(k)) look[k] = v;
  Object.assign(look, pr, paletteColors(pr.palette || DEFAULTS.palette));
  return look;
}
