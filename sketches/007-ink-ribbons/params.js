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
  const p = PALETTES[key] || PALETTES.carmine;
  return {
    ground: p.ground, ink: p.ink, accent: p.accent, echo: p.echo,
    wash1: p.wash[0], wash2: p.wash[1], wash3: p.wash[2], frameColor: p.frame,
  };
}

export const DEFAULTS = {
  seed: 1234,
  // layout
  format: '4:5',
  layout: 'columns',
  ribbonCount: 4,
  ribbonWidth: 0.62,
  margin: 0.04,
  sway: 0.35,
  swayFreq: 1.5,
  meander: 0.6,
  turns: 1.6,
  // twist
  pinches: 5,
  pinchJitter: 0.35,
  twistNoise: 1.0,
  cup: 0.5,
  cupVar: 0.7,
  tilt: 0.4,
  widthVar: 0.3,
  widthFreq: 2,
  // lines
  lines: 26,
  spread: 1.0,
  lineJitter: 0.25,
  lineWidth: 1.3,
  lineWidthVar: 0.35,
  edgeWeight: 1.6,
  pressure: 0.35,
  depthWidth: 0.4,
  lineOpacity: 0.92,
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
  // frame
  border: true,
  borderMargin: 0.06,
  borderWidth: 2.2,
  clipToFrame: true,
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
  palette: 'carmine',
  ...paletteColors('carmine'),
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
  previewScale: 1,
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

// One-click looks. Only the listed keys change (plus the palette colours).
export const PRESETS = {
  'Red pen columns': {
    layout: 'columns', ribbonCount: 4, ribbonWidth: 0.62, sway: 0.35, pinches: 5, cup: 0.5, tilt: 0.4,
    lines: 26, lineWidth: 1.3, edgeWeight: 1.6, dashMix: 0, axisLine: false, accentRatio: 0, echoCount: 0,
    border: true, clipToFrame: true, shapes: false, palette: 'carmine', lineColorMode: 'ink',
  },
  'Dashed columns': {
    layout: 'columns', ribbonCount: 4, ribbonWidth: 0.7, sway: 0.4, pinches: 4, cup: 0.45, tilt: 0.35,
    lines: 30, lineWidth: 1.1, edgeWeight: 1.4, dashMix: 0.5, dashLength: 8, dashGap: 6, axisLine: true,
    accentRatio: 0, echoCount: 0, border: true, clipToFrame: true, shapes: false, palette: 'carmine', lineColorMode: 'ink',
  },
  'Ink meander + wash': {
    layout: 'meander', ribbonCount: 1, ribbonWidth: 0.75, meander: 0.62, turns: 1.7, sway: 0.4, pinches: 2.2,
    cup: 0.45, cupVar: 0.8, tilt: 0.35, widthVar: 0.4, lines: 22, lineWidth: 2.6, lineWidthVar: 0.6, edgeWeight: 1.8,
    pressure: 0.45, dashMix: 0, axisLine: false, accentRatio: 0.12, accentLength: 0.3, echoCount: 1, echoGap: 0.12,
    border: false, shapes: true, shapeStyle: 'watercolor', shapeCount: 10, shapeOpacity: 0.5, palette: 'sumi',
    lineColorMode: 'ink',
  },
  'Twin meanders': {
    layout: 'meander', ribbonCount: 2, ribbonWidth: 0.9, meander: 0.5, turns: 1.3, pinches: 2.6, cup: 0.35, tilt: 0.3,
    lines: 24, lineWidth: 1.4, edgeWeight: 1.5, dashMix: 0, accentRatio: 0.05, echoCount: 2, echoGap: 0.15,
    border: false, shapes: true, shapeStyle: 'flat', shapeCount: 6, shapeOpacity: 0.35, palette: 'indigo',
    lineColorMode: 'ribbons',
  },
  'Night rows': {
    layout: 'rows', ribbonCount: 5, ribbonWidth: 0.7, sway: 0.45, pinches: 3, cup: 0.25, tilt: 0.25,
    lines: 28, lineWidth: 1.0, edgeWeight: 1.6, dashMix: 0.2, axisLine: false, accentRatio: 0, echoCount: 0,
    border: true, clipToFrame: true, shapes: true, shapeStyle: 'watercolor', shapeCount: 7, shapeOpacity: 0.5,
    palette: 'lagoon', lineColorMode: 'gradient',
  },
};
