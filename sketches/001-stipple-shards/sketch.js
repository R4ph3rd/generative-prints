// 001-stipple-shards
// 1-bit stippled light slabs / shattered-glass shards, after Matt DesLauriers' stipple prints.
// Pipeline: seeded composition (composition.js) -> tone + grain layers (Canvas 2D, per tile)
// -> WebGL2 stipple shader (stipple-gl.js) -> preview canvas or tiled poster PNG (lib/poster-export.js).
import { Pane } from 'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js';
import { generateComposition, computeHalo } from './composition.js';
import { StippleRenderer } from './stipple-gl.js';
import {
  PAPER_PRESETS, paperSizePx, posterFilename, exportPosterPNG, downloadJSON, pickJSONFile,
} from '../../lib/poster-export.js';

const SKETCH = 'stipple-shards';
const PARAMS_VERSION = 1;
const KB = 0.42; // dot radius / cell size (must match the shader)

const DEFAULTS = {
  seed: 1234,
  // composition
  mode: 'shards',
  shapeCount: 48,
  focalCount: 3,
  slabCount: 4,
  slabCross: 0.35,
  slabEdgeOnly: 0.4,
  bandCount: 4,
  bandWidth: 0.035,
  perspective: 0.6,
  frame: true,
  frameMargin: 0.1,
  edgeFreq: 0.5,
  // light / tone
  brightness: 1.0,
  contrast: 1.1,
  gamma: 1.25,
  edgeLines: 1.0,
  haloAmount: 0.2,
  haloSpread: 0.03,
  haloFalloff: 1.3,
  background: 0.003,
  starDensity: 0.12,
  starSize: 1.0,
  // grain
  dotUnit: 'relative',
  dotSize: 0.22,
  grainVariation: 0.8,
  sizeJitter: 0.35,
  density: 1.0,
  bgGrain: 1.0,
  hard: true,
  invert: false,
  // export
  paper: 'A2',
  orientation: 'portrait',
  dpi: 300,
  customW: 400,
  customH: 500,
  // preview
  view: 'fit',
};

const MODE_PRESETS = {
  shards: { frame: true, haloAmount: 0.2, haloSpread: 0.03, haloFalloff: 1.3, bandCount: 4, starDensity: 0.12, gamma: 1.25 },
  slabs: { frame: false, haloAmount: 0.85, haloSpread: 0.06, haloFalloff: 1.25, bandCount: 0, starDensity: 0.2, gamma: 1.4 },
  mixed: { frame: false, haloAmount: 0.5, haloSpread: 0.05, haloFalloff: 1.25, bandCount: 2, starDensity: 0.16, gamma: 1.3 },
};

const P = { ...DEFAULTS };
const info = { pixels: '', dot: '', tiles: '', progress: 'idle' };

// ----------------------------------------------------------------------------- state
let renderer = null;
let comp = null, compKey = '';
let exporting = false, abortCtl = null;
let renderTimer = null;
let loupe = { cx: 0.5, cy: 0.5 }; // centre of the 100% view, as fraction of the image
let cnv = null, pInst = null;
const statusEl = document.getElementById('status');

const setStatus = (s) => { statusEl.textContent = s; };

function paper() {
  return paperSizePx(P.paper, P.orientation, P.dpi, { w: P.customW, h: P.customH });
}
function dotMM(pp) {
  return P.dotUnit === 'mm' ? P.dotSize : (P.dotSize / 100) * Math.min(pp.widthMM, pp.heightMM);
}

function ensureComposition(pp) {
  const aspect = pp.widthMM / pp.heightMM;
  const keyObj = {
    seed: P.seed, aspect: aspect.toFixed(5), mode: P.mode, shapeCount: P.shapeCount, focalCount: P.focalCount,
    slabCount: P.slabCount, slabCross: P.slabCross, slabEdgeOnly: P.slabEdgeOnly, bandCount: P.bandCount, bandWidth: P.bandWidth, perspective: P.perspective,
    frame: P.frame, frameMargin: P.frameMargin, edgeFreq: P.edgeFreq, grainVariation: P.grainVariation,
    bgGrain: P.bgGrain, haloSpread: P.haloSpread,
  };
  const key = JSON.stringify(keyObj);
  if (key === compKey) return;
  pInst.randomSeed(P.seed); // composition uses its own mulberry32 stream; kept in sync for any p5 extras
  pInst.noiseSeed(P.seed);
  comp = generateComposition(P.seed, P, aspect);
  // largest dot cell scale used by any shape -> tile padding
  let maxCode = comp.bgCode;
  for (const L of comp.layers) {
    maxCode = Math.max(maxCode, L.lineCode);
    for (const it of L.items) if (it.grain) maxCode = Math.max(maxCode, it.grain);
  }
  comp.maxScale = Math.pow(2, (maxCode - 128) / 32);
  renderer.setHalo(computeHalo(comp, aspect, P.haloSpread));
  compKey = key;
}

function uniforms(pp) {
  const short = Math.min(pp.widthMM, pp.heightMM);
  return {
    uCellMM: dotMM(pp) / (2 * KB),
    uBright: P.brightness, uContrast: P.contrast, uGamma: P.gamma,
    uHaloAmt: P.haloAmount, uHaloPow: P.haloFalloff, uBg: P.background,
    uDensity: P.density, uSizeJitter: P.sizeJitter,
    uStarCellMM: short * 0.02, uStarDensity: P.starDensity * 0.5, uStarSize: P.starSize,
    uInvert: P.invert ? 1 : 0,
  };
}

function padFor(pp, mmPerPx) {
  const cellPx = (dotMM(pp) / (2 * KB)) * comp.maxScale / mmPerPx;
  return Math.min(512, Math.ceil(cellPx * 2.2) + 2);
}

/** Render region [x,y,w,h] of an image laid out at fullW x fullH. Splits into GL-safe tiles. */
function renderArea(pp, fullW, fullH, x, y, w, h, hard) {
  const mmPerPx = pp.widthMM / fullW;
  const pad = padFor(pp, mmPerPx);
  const tile = renderer.maxTile(pad);
  const out = new Uint8ClampedArray(w * h * 4);
  const U = uniforms(pp);
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      const tw = Math.min(tile, w - tx), th = Math.min(tile, h - ty);
      const px = renderer.renderRegion({
        comp, fullW, fullH, mmPerPx, x: x + tx, y: y + ty, w: tw, h: th, pad,
        seed: P.seed, hard, uniforms: U, edgeIntensity: P.edgeLines,
      });
      for (let r = 0; r < th; r++) out.set(px.subarray(r * tw * 4, (r + 1) * tw * 4), ((ty + r) * w + tx) * 4);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- preview
function layoutCanvas() {
  const pp = paper();
  const wide = window.innerWidth > 900;
  const availW = window.innerWidth - (wide ? 330 : 0) - 32;
  const availH = window.innerHeight - 32 - 22;
  const aspect = pp.widthMM / pp.heightMM;
  let cssW = availW, cssH = availW / aspect;
  if (cssH > availH) { cssH = availH; cssW = availH * aspect; }
  cssW = Math.max(64, Math.floor(cssW)); cssH = Math.max(64, Math.floor(cssH));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (pInst.width !== pw || pInst.height !== ph) pInst.resizeCanvas(pw, ph, true);
  cnv.elt.style.width = `${cssW}px`;
  cnv.elt.style.height = `${cssH}px`;
  return { pw, ph };
}

function renderPreview() {
  if (exporting) return;
  const t0 = performance.now();
  lastParamsKey = JSON.stringify(P);
  const pp = paper();
  const { pw, ph } = layoutCanvas();
  ensureComposition(pp);
  let data, label;
  if (P.view === 'fit') {
    data = renderArea(pp, pw, ph, 0, 0, pw, ph, false);
    label = `fit preview ${pw}×${ph}`;
  } else {
    const W = pp.width, H = pp.height;
    const w = Math.min(pw, W), h = Math.min(ph, H);
    const x = Math.round(Math.max(0, Math.min(W - w, loupe.cx * W - w / 2)));
    const y = Math.round(Math.max(0, Math.min(H - h, loupe.cy * H - h / 2)));
    data = renderArea(pp, W, H, x, y, w, h, P.hard);
    if (w < pw || h < ph) { // paper smaller than the view: pad with black
      const full = new Uint8ClampedArray(pw * ph * 4);
      for (let r = 0; r < h; r++) full.set(data.subarray(r * w * 4, (r + 1) * w * 4), (r * pw) * 4);
      data = full;
    }
    label = `100% view @${P.dpi}dpi, x ${x} y ${y}`;
  }
  pInst.drawingContext.putImageData(new ImageData(data, pw, ph), 0, 0);
  const ms = Math.round(performance.now() - t0);
  setStatus(`seed ${P.seed} · ${P.mode} · ${label} · ${ms} ms   [R new seed · ←/→ prev/next · S export · Z/click 100% view]`);
  updateInfo();
  try { history.replaceState(null, '', `#seed=${P.seed}`); } catch { /* file:// etc */ }
}

function scheduleRender(delay = 60) {
  if (exporting) return;
  setStatus(`rendering… seed ${P.seed}`);
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, delay);
}

function updateInfo() {
  const pp = paper();
  const mp = (pp.width * pp.height) / 1e6;
  info.pixels = `${pp.width} × ${pp.height} px (${mp.toFixed(1)} MP) ${pp.widthMM.toFixed(0)}×${pp.heightMM.toFixed(0)} mm`;
  const d = dotMM(pp);
  info.dot = `${d.toFixed(2)} mm = ${((d / 25.4) * P.dpi).toFixed(1)} px @${P.dpi}dpi = ${((100 * d) / Math.min(pp.widthMM, pp.heightMM)).toFixed(2)}% short side`;
  const tile = 2048;
  info.tiles = `${Math.ceil(pp.width / tile) * Math.ceil(pp.height / tile)} tiles of ${tile}px · ${P.hard ? '1-bit' : '8-bit gray'} PNG`;
}

// ----------------------------------------------------------------------------- export
async function doExport(opts = {}) {
  if (exporting) return null;
  let blob = null;
  exporting = true;
  clearTimeout(renderTimer);
  abortCtl = new AbortController();
  exportBtn.disabled = true;
  cancelBtn.disabled = false;
  const pp = paper();
  const t0 = performance.now();
  try {
    ensureComposition(pp);
    const mmPerPx = pp.widthMM / pp.width;
    const pad = padFor(pp, mmPerPx);
    const tileSize = Math.floor(Math.min(opts.tileSize || 2048, renderer.maxTile(pad)) / 8) * 8;
    const U = uniforms(pp);
    const paperName = P.paper === 'custom' ? `${P.customW}x${P.customH}mm` : P.paper;
    const filename = posterFilename({ name: SKETCH, seed: P.seed, paper: paperName, dpi: P.dpi, orientation: P.orientation });
    blob = await exportPosterPNG({
      width: pp.width, height: pp.height, dpi: P.dpi, tileSize,
      bitDepth: P.hard ? 1 : 8,
      renderTile: async (x, y, w, h) => ({
        data: renderer.renderRegion({ comp, fullW: pp.width, fullH: pp.height, mmPerPx, x, y, w, h, pad, seed: P.seed, hard: P.hard, uniforms: U, edgeIntensity: P.edgeLines }),
        channels: 4,
      }),
      text: { Title: `${SKETCH} seed ${P.seed}`, Software: 'Generative/001-stipple-shards', Comment: JSON.stringify(serializeParams()) },
      filename: opts.noDownload ? undefined : filename,
      signal: abortCtl.signal,
      onProgress: ({ done, total, phase }) => {
        info.progress = phase === 'encode' ? 'encoding PNG…' : phase === 'done' ? 'done' : `tile ${done}/${total}`;
        setStatus(`exporting ${filename} · ${info.progress}`);
      },
    });
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    info.progress = `saved ${filename} (${s}s)`;
  } catch (e) {
    info.progress = e.name === 'AbortError' ? 'cancelled' : `error: ${e.message}`;
    console.error(e);
  } finally {
    renderer.trim(); // free the big tile canvases / FBO
    exporting = false;
    exportBtn.disabled = false;
    cancelBtn.disabled = true;
    renderPreview();
    setStatus(`${statusEl.textContent} · export: ${info.progress}`);
  }
  return blob;
}

function serializeParams() {
  const out = { sketch: SKETCH, version: PARAMS_VERSION };
  for (const k of Object.keys(DEFAULTS)) out[k] = P[k];
  return out;
}

async function loadParams() {
  try {
    const obj = await pickJSONFile();
    if (!obj) return;
    for (const k of Object.keys(DEFAULTS)) if (k in obj && typeof obj[k] === typeof DEFAULTS[k]) P[k] = obj[k];
    refreshPane();
    scheduleRender(0);
  } catch (e) {
    setStatus(`could not load params: ${e.message}`);
  }
}

// ----------------------------------------------------------------------------- UI
let suppress = false;
const pane = new Pane({ title: 'Stipple Shards', container: document.getElementById('pane') });
function refreshPane() { suppress = true; try { pane.refresh(); } finally { suppress = false; } }
function setSeed(s) { P.seed = ((s % 1000000) + 1000000) % 1000000; refreshPane(); scheduleRender(0); }

const fSeed = pane.addFolder({ title: 'Seed' });
fSeed.addBinding(P, 'seed', { min: 0, max: 999999, step: 1 });
fSeed.addButton({ title: 'Randomize seed (R)' }).on('click', () => setSeed(Math.floor(Math.random() * 1000000)));
fSeed.addButton({ title: 'Re-render' }).on('click', () => scheduleRender(0));

const fComp = pane.addFolder({ title: 'Composition' });
fComp.addBinding(P, 'mode', { options: { 'Slabs (light sheets)': 'slabs', 'Shards (shattered glass)': 'shards', Mixed: 'mixed' } })
  .on('change', (ev) => {
    if (suppress) return;
    Object.assign(P, MODE_PRESETS[ev.value] || {});
    refreshPane();
  });
fComp.addBinding(P, 'shapeCount', { label: 'shards', min: 6, max: 160, step: 1 });
fComp.addBinding(P, 'focalCount', { label: 'focal points', min: 1, max: 8, step: 1 });
fComp.addBinding(P, 'slabCount', { label: 'slabs', min: 1, max: 9, step: 1 });
fComp.addBinding(P, 'slabCross', { label: 'slab crosswise', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'slabEdgeOnly', { label: 'slab edge-only', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'bandCount', { label: 'bands', min: 0, max: 14, step: 1 });
fComp.addBinding(P, 'bandWidth', { label: 'band width', min: 0.005, max: 0.12, step: 0.001 });
fComp.addBinding(P, 'perspective', { label: 'perspective/rot', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'edgeFreq', { label: 'edge lines freq', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'frame');
fComp.addBinding(P, 'frameMargin', { label: 'frame margin', min: 0, max: 0.3, step: 0.005 });

const fTone = pane.addFolder({ title: 'Light / Tone' });
fTone.addBinding(P, 'brightness', { min: 0.2, max: 2, step: 0.01 });
fTone.addBinding(P, 'contrast', { min: 0.5, max: 2.5, step: 0.01 });
fTone.addBinding(P, 'gamma', { min: 0.4, max: 3, step: 0.01 });
fTone.addBinding(P, 'edgeLines', { label: 'edge intensity', min: 0, max: 2, step: 0.01 });
fTone.addBinding(P, 'haloAmount', { label: 'halo amount', min: 0, max: 2, step: 0.01 });
fTone.addBinding(P, 'haloSpread', { label: 'halo spread', min: 0.005, max: 0.2, step: 0.001 });
fTone.addBinding(P, 'haloFalloff', { label: 'halo falloff', min: 0.3, max: 2, step: 0.01 });
fTone.addBinding(P, 'background', { label: 'bg grain', min: 0, max: 0.05, step: 0.0005 });
fTone.addBinding(P, 'starDensity', { label: 'stars', min: 0, max: 1, step: 0.01 });
fTone.addBinding(P, 'starSize', { label: 'star size', min: 0.2, max: 4, step: 0.01 });

const fGrain = pane.addFolder({ title: 'Grain' });
fGrain.addBinding(P, 'dotUnit', { label: 'dot unit', options: { '% of short side': 'relative', 'mm on paper': 'mm' } })
  .on('change', (ev) => {
    if (suppress) return;
    const pp = paper();
    const short = Math.min(pp.widthMM, pp.heightMM);
    // keep the physical dot the same when switching units
    P.dotSize = ev.value === 'mm' ? +((P.dotSize / 100) * short).toFixed(3) : +((P.dotSize / short) * 100).toFixed(3);
    refreshPane();
  });
fGrain.addBinding(P, 'dotSize', { label: 'dot size', min: 0.02, max: 3, step: 0.005 });
fGrain.addBinding(P, 'grainVariation', { label: 'size by shape', min: 0, max: 1.5, step: 0.01 });
fGrain.addBinding(P, 'sizeJitter', { label: 'size jitter', min: 0, max: 1, step: 0.01 });
fGrain.addBinding(P, 'density', { min: 0.2, max: 3, step: 0.01 });
fGrain.addBinding(P, 'bgGrain', { label: 'halo dot scale', min: 0.3, max: 4, step: 0.01 });
fGrain.addBinding(P, 'hard', { label: 'hard 1-bit' });
fGrain.addBinding(P, 'invert');
fGrain.addBinding(info, 'dot', { readonly: true, label: 'dot' });

const fExp = pane.addFolder({ title: 'Export' });
const paperOpts = {};
for (const [k, v] of Object.entries(PAPER_PRESETS)) paperOpts[v.label] = k;
fExp.addBinding(P, 'paper', { options: paperOpts });
fExp.addBinding(P, 'orientation', { options: { portrait: 'portrait', landscape: 'landscape' } });
fExp.addBinding(P, 'customW', { label: 'custom W mm', min: 50, max: 2000, step: 1 });
fExp.addBinding(P, 'customH', { label: 'custom H mm', min: 50, max: 2000, step: 1 });
fExp.addBinding(P, 'dpi', { options: { '150': 150, '200': 200, '300': 300, '400': 400 } });
fExp.addBinding(info, 'pixels', { readonly: true, label: 'size' });
fExp.addBinding(info, 'tiles', { readonly: true, label: 'output' });
const exportBtn = fExp.addButton({ title: 'Export PNG (S)' });
exportBtn.on('click', () => doExport());
const cancelBtn = fExp.addButton({ title: 'Cancel export' });
cancelBtn.disabled = true;
cancelBtn.on('click', () => abortCtl?.abort());
fExp.addBinding(info, 'progress', { readonly: true, label: 'status' });
fExp.addButton({ title: 'Save params JSON' }).on('click', () => downloadJSON(serializeParams(), `${SKETCH}_seed-${P.seed}.json`));
fExp.addButton({ title: 'Load params JSON' }).on('click', loadParams);

const fView = pane.addFolder({ title: 'Preview' });
fView.addBinding(P, 'view', { options: { 'fit (downscaled, AA)': 'fit', '100% (export pixels)': 'actual' } });

// Only re-render when a real parameter changed (readonly monitors also emit 'change').
let lastParamsKey = '';
pane.on('change', () => {
  if (suppress) return;
  const k = JSON.stringify(P);
  if (k === lastParamsKey) return;
  scheduleRender();
});

// ----------------------------------------------------------------------------- p5
new p5((p) => {
  pInst = p;
  p.setup = () => {
    p.pixelDensity(1);
    cnv = p.createCanvas(400, 400);
    cnv.parent('stage');
    p.noLoop();
    try {
      renderer = new StippleRenderer();
    } catch (e) {
      setStatus(`WebGL2 unavailable: ${e.message}`);
      return;
    }
    const m = /seed=(\d+)/.exec(location.hash);
    if (m) P.seed = +m[1] % 1000000;
    refreshPane();
    cnv.elt.addEventListener('pointerdown', onCanvasDown);
    renderPreview();
  };
  p.draw = () => {};
  p.windowResized = () => scheduleRender(120);
  p.keyPressed = (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (e && (e.ctrlKey || e.metaKey || e.altKey)) return true; // keep Ctrl+R / Ctrl+S etc. for the browser
    if (p.key === 'r' || p.key === 'R') setSeed(Math.floor(Math.random() * 1000000));
    else if (p.key === 's' || p.key === 'S') doExport();
    else if (p.keyCode === p.LEFT_ARROW) setSeed(P.seed - 1);
    else if (p.keyCode === p.RIGHT_ARROW) setSeed(P.seed + 1);
    else if (p.key === 'z' || p.key === 'Z') { P.view = P.view === 'fit' ? 'actual' : 'fit'; refreshPane(); scheduleRender(0); }
    else if (p.keyCode === p.ESCAPE && P.view !== 'fit') { P.view = 'fit'; refreshPane(); scheduleRender(0); }
    else return true;
    return false;
  };
});

// click in fit view -> 100% view centred there; drag in 100% view -> pan
function onCanvasDown(e) {
  const rect = cnv.elt.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
  if (P.view === 'fit') {
    loupe = { cx: fx, cy: fy };
    P.view = 'actual';
    refreshPane();
    scheduleRender(0);
    return;
  }
  const pp = paper();
  const start = { x: e.clientX, y: e.clientY, cx: loupe.cx, cy: loupe.cy };
  const dpr = cnv.elt.width / rect.width;
  const move = (ev) => {
    const dx = (ev.clientX - start.x) * dpr, dy = (ev.clientY - start.y) * dpr;
    cnv.elt.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
    loupe = { cx: start.cx - dx / pp.width, cy: start.cy - dy / pp.height };
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    cnv.elt.style.transform = '';
    loupe.cx = Math.min(1, Math.max(0, loupe.cx));
    loupe.cy = Math.min(1, Math.max(0, loupe.cy));
    scheduleRender(0);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Console access, e.g. stipple.set({ mode: 'slabs', seed: 7 })
window.stipple = {
  P,
  set(obj) { Object.assign(P, obj); refreshPane(); scheduleRender(0); },
  export: doExport,
  /** Render [x,y,w,h] of the full-resolution export in one pass (for checking tile seams). */
  renderExportRegion(x, y, w, h) {
    const pp = paper();
    ensureComposition(pp);
    return renderArea(pp, pp.width, pp.height, x, y, w, h, P.hard);
  },
};
