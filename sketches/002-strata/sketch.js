// 002-strata
// Layered landscape / strata compositions rendered as hatched strokes or stipple in full colour.
// Pipeline: seeded scene (scene.js) -> WebGL2 renderer (strata-gl.js) -> preview canvas
// or tiled 24-bit poster PNG (lib/poster-export.js).
import { Pane } from 'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js';
import { PALETTES, buildScene } from './scene.js';
import { StrataRenderer } from './strata-gl.js';
import {
  PAPER_PRESETS, paperSizePx, posterFilename, exportPosterPNG, downloadJSON, pickJSONFile,
} from '../../lib/poster-export.js';

const SKETCH = 'strata';
const PARAMS_VERSION = 1;

const DEFAULTS = {
  seed: 1234,
  // composition
  scene: 'landscape',
  horizon: 0.38,
  ranges: 4,
  mountainHeight: 0.35,
  ridgeSharpness: 0.6,
  bandCount: 30,
  bandVariance: 0.7,
  warp: 0.8,
  warpScale: 1.2,
  detail: 5,
  roughness: 0.5,
  edgeJag: 0.5,
  tilt: 0.0,
  // colour
  palette: 'random',
  colorCount: 6,
  paperBands: 0.05,
  colorJitter: 0.08,
  shading: 0.25,
  paperColor: '#e8e3d7',
  margin: 0.075,
  // texture
  texture: 'strokes',
  grainUnit: 'relative',
  grainSize: 0.3,
  strokeLength: 3.0,
  strokeWidth: 0.35,
  flowAlign: 0.8,
  flowCurl: 0.3,
  density: 1.0,
  paperShow: 0.1,
  raggedEdge: 0.5,
  // export
  paper: '9x16',
  orientation: 'portrait',
  dpi: 300,
  customW: 300,
  customH: 533,
  // preview
  view: 'fit',
};

const P = { ...DEFAULTS };
const info = { pixels: '', grain: '', tiles: '', progress: 'idle', scene: '', palette: '' };

// ----------------------------------------------------------------------------- state
let renderer = null;
let sceneInfo = { scene: '', palette: '' };
let exporting = false, abortCtl = null;
let renderTimer = null;
let loupe = { cx: 0.5, cy: 0.5 }; // centre of the 100% view, as fraction of the image
let cnv = null, pInst = null;
let lastParamsKey = '';
const statusEl = document.getElementById('status');

const setStatus = (s) => { statusEl.textContent = s; };

function paper() {
  return paperSizePx(P.paper, P.orientation, P.dpi, { w: P.customW, h: P.customH });
}
function cellMMFor(pp) {
  return P.grainUnit === 'mm' ? P.grainSize : (P.grainSize / 100) * Math.min(pp.widthMM, pp.heightMM);
}

function ensureScene(pp) {
  const aspect = pp.widthMM / pp.heightMM;
  pInst.randomSeed(P.seed);
  pInst.noiseSeed(P.seed);
  const scene = buildScene(P.seed, P, aspect);
  renderer.setScene(scene);
  const si = scene.info || {};
  sceneInfo = { scene: String(si.scene ?? ''), palette: String(si.palette ?? '') };
  info.scene = sceneInfo.scene;
  info.palette = sceneInfo.palette;
}

/** Render region [x,y,w,h] of an image laid out at fullW x fullH. Splits into GL-safe tiles. */
function renderArea(pp, fullW, fullH, x, y, w, h) {
  const mmPerPx = pp.widthMM / fullW;
  const cellMM = cellMMFor(pp);
  const tile = Math.max(64, renderer.maxTile());
  const out = new Uint8ClampedArray(w * h * 4);
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      const tw = Math.min(tile, w - tx), th = Math.min(tile, h - ty);
      const px = renderer.renderRegion({ P, fullW, fullH, mmPerPx, cellMM, x: x + tx, y: y + ty, w: tw, h: th });
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
  ensureScene(pp);
  let data, label;
  if (P.view === 'fit') {
    data = renderArea(pp, pw, ph, 0, 0, pw, ph);
    label = `fit preview ${pw}×${ph}`;
  } else {
    const W = pp.width, H = pp.height;
    const w = Math.min(pw, W), h = Math.min(ph, H);
    const x = Math.round(Math.max(0, Math.min(W - w, loupe.cx * W - w / 2)));
    const y = Math.round(Math.max(0, Math.min(H - h, loupe.cy * H - h / 2)));
    data = renderArea(pp, W, H, x, y, w, h);
    if (w < pw || h < ph) { // paper smaller than the view: pad with transparent
      const full = new Uint8ClampedArray(pw * ph * 4);
      for (let r = 0; r < h; r++) full.set(data.subarray(r * w * 4, (r + 1) * w * 4), (r * pw) * 4);
      data = full;
    }
    label = `100% view @${P.dpi}dpi, x ${x} y ${y}`;
  }
  pInst.drawingContext.putImageData(new ImageData(data, pw, ph), 0, 0);
  const ms = Math.round(performance.now() - t0);
  setStatus(`seed ${P.seed} · ${sceneInfo.scene} · ${sceneInfo.palette} · ${label} · ${ms} ms   [R new seed · Shift+R randomize params · ←/→ prev/next · S export · Z/click 100% view]`);
  updateInfo();
  try { history.replaceState(null, '', `#seed=${P.seed}`); } catch { /* file:// etc */ }
}

function scheduleRender(delay = 60) {
  if (exporting) return;
  setStatus(`rendering… seed ${P.seed}`);
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, delay);
}

function exportTileSize() {
  return Math.max(64, Math.floor(Math.min(2048, renderer ? renderer.maxTile() : 2048) / 8) * 8);
}

function updateInfo() {
  const pp = paper();
  const mp = (pp.width * pp.height) / 1e6;
  info.pixels = `${pp.width} × ${pp.height} px (${mp.toFixed(1)} MP) ${pp.widthMM.toFixed(0)}×${pp.heightMM.toFixed(0)} mm`;
  const d = cellMMFor(pp);
  info.grain = `${d.toFixed(2)} mm = ${((d / 25.4) * P.dpi).toFixed(1)} px @${P.dpi}dpi = ${((100 * d) / Math.min(pp.widthMM, pp.heightMM)).toFixed(2)}% short side`;
  const tile = exportTileSize();
  info.tiles = `${Math.ceil(pp.width / tile) * Math.ceil(pp.height / tile)} tiles of ${tile}px · 24-bit RGB PNG`;
}

// ----------------------------------------------------------------------------- export
async function doExport(opts = {}) {
  if (exporting || !renderer) return null;
  let blob = null;
  exporting = true;
  clearTimeout(renderTimer);
  abortCtl = new AbortController();
  exportBtn.disabled = true;
  cancelBtn.disabled = false;
  const pp = paper();
  const t0 = performance.now();
  try {
    ensureScene(pp);
    const mmPerPx = pp.widthMM / pp.width;
    const cellMM = cellMMFor(pp);
    const tileSize = exportTileSize();
    const paperName = P.paper === 'custom' ? `${P.customW}x${P.customH}mm` : P.paper;
    const filename = posterFilename({ name: SKETCH, seed: P.seed, paper: paperName, dpi: P.dpi, orientation: P.orientation });
    blob = await exportPosterPNG({
      width: pp.width, height: pp.height, dpi: P.dpi, tileSize,
      bitDepth: 24,
      renderTile: async (x, y, w, h) => ({
        data: renderer.renderRegion({ P, fullW: pp.width, fullH: pp.height, mmPerPx, cellMM, x, y, w, h }),
        channels: 4,
      }),
      text: { Title: `${SKETCH} seed ${P.seed}`, Software: 'Generative/002-strata', Comment: JSON.stringify(serializeParams()) },
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

// ----------------------------------------------------------------------------- randomize / reset
const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const r2 = (v) => +v.toFixed(2);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randomizeParams() {
  Object.assign(P, {
    scene: pick(['landscape', 'landscape', 'strata', 'random']),
    horizon: r2(rnd(0.2, 0.6)),
    ranges: rndInt(2, 6),
    mountainHeight: r2(rnd(0.15, 0.6)),
    ridgeSharpness: r2(rnd(0.2, 0.9)),
    bandCount: rndInt(8, 70),
    bandVariance: r2(rnd(0.3, 1)),
    warp: r2(rnd(0.2, 1.6)),
    warpScale: r2(rnd(0.5, 3)),
    detail: rndInt(3, 7),
    roughness: r2(rnd(0.35, 0.65)),
    edgeJag: r2(rnd(0.2, 0.8)),
    tilt: r2(rnd(-0.4, 0.4)),
    palette: pick(['random', ...PALETTES.map((p) => p.name)]),
    colorCount: rndInt(3, 8),
    paperBands: r2(rnd(0, 0.2)),
    colorJitter: r2(rnd(0.03, 0.15)),
    shading: r2(rnd(0.1, 0.5)),
    margin: r2(rnd(0.04, 0.12)),
    texture: pick(['strokes', 'strokes', 'stipple']),
    grainSize: r2(rnd(0.15, 0.6)),
    strokeLength: r2(rnd(1.5, 5)),
    strokeWidth: r2(rnd(0.2, 0.6)),
    flowAlign: r2(rnd(0.4, 1)),
    flowCurl: r2(rnd(0, 0.6)),
    density: r2(rnd(0.7, 1.5)),
    paperShow: r2(rnd(0.03, 0.3)),
    raggedEdge: r2(rnd(0.2, 0.8)),
  });
  refreshPane();
  scheduleRender(0);
}

function resetParams() {
  const keep = { paper: P.paper, orientation: P.orientation, dpi: P.dpi, customW: P.customW, customH: P.customH, view: P.view, seed: P.seed };
  Object.assign(P, DEFAULTS, keep);
  refreshPane();
  scheduleRender(0);
}

// ----------------------------------------------------------------------------- UI
let suppress = false;
const pane = new Pane({ title: 'Strata', container: document.getElementById('pane') });
function refreshPane() { suppress = true; try { pane.refresh(); } finally { suppress = false; } }
function setSeed(s) { P.seed = ((s % 1000000) + 1000000) % 1000000; refreshPane(); scheduleRender(0); }

const fSeed = pane.addFolder({ title: 'Seed' });
fSeed.addBinding(P, 'seed', { min: 0, max: 999999, step: 1 });
fSeed.addButton({ title: 'Randomize seed (R)' }).on('click', () => setSeed(Math.floor(Math.random() * 1000000)));
fSeed.addButton({ title: 'Randomize params (Shift+R)' }).on('click', randomizeParams);
fSeed.addButton({ title: 'Reset to defaults' }).on('click', resetParams);
fSeed.addButton({ title: 'Re-render' }).on('click', () => scheduleRender(0));
fSeed.addBinding(info, 'scene', { readonly: true, label: 'resolved scene' });
fSeed.addBinding(info, 'palette', { readonly: true, label: 'resolved palette' });

const fComp = pane.addFolder({ title: 'Composition' });
fComp.addBinding(P, 'scene', { options: { 'Landscape (sky + ranges)': 'landscape', 'Strata (bands only)': 'strata', 'Random (by seed)': 'random' } });
fComp.addBinding(P, 'horizon', { min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'ranges', { min: 1, max: 8, step: 1 });
fComp.addBinding(P, 'mountainHeight', { label: 'mountain height', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'ridgeSharpness', { label: 'ridge sharpness', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'bandCount', { label: 'bands', min: 3, max: 120, step: 1 });
fComp.addBinding(P, 'bandVariance', { label: 'band variance', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'warp', { min: 0, max: 2, step: 0.01 });
fComp.addBinding(P, 'warpScale', { label: 'warp scale', min: 0.2, max: 5, step: 0.01 });
fComp.addBinding(P, 'detail', { min: 1, max: 8, step: 1 });
fComp.addBinding(P, 'roughness', { min: 0.2, max: 0.8, step: 0.01 });
fComp.addBinding(P, 'edgeJag', { label: 'edge jaggedness', min: 0, max: 1, step: 0.01 });
fComp.addBinding(P, 'tilt', { min: -1, max: 1, step: 0.01 });

const fCol = pane.addFolder({ title: 'Colour' });
const paletteOpts = { 'Random (by seed)': 'random' };
for (const pal of PALETTES) paletteOpts[pal.name] = pal.name;
fCol.addBinding(P, 'palette', { options: paletteOpts });
fCol.addBinding(P, 'colorCount', { label: 'colour count', min: 2, max: 10, step: 1 });
fCol.addBinding(P, 'paperBands', { label: 'paper bands', min: 0, max: 0.5, step: 0.005 });
fCol.addBinding(P, 'colorJitter', { label: 'colour jitter', min: 0, max: 0.3, step: 0.005 });
fCol.addBinding(P, 'shading', { min: 0, max: 1, step: 0.01 });
fCol.addBinding(P, 'paperColor', { label: 'paper colour' });
fCol.addBinding(P, 'margin', { min: 0, max: 0.25, step: 0.005 });

const fTex = pane.addFolder({ title: 'Texture' });
fTex.addBinding(P, 'texture', { options: { 'Strokes (hatching)': 'strokes', 'Stipple (dots)': 'stipple' } });
fTex.addBinding(P, 'grainUnit', { label: 'grain unit', options: { '% of short side': 'relative', 'mm on paper': 'mm' } })
  .on('change', (ev) => {
    if (suppress) return;
    const pp = paper();
    const short = Math.min(pp.widthMM, pp.heightMM);
    // keep the physical grain the same when switching units
    P.grainSize = ev.value === 'mm' ? +((P.grainSize / 100) * short).toFixed(3) : +((P.grainSize / short) * 100).toFixed(3);
    refreshPane();
  });
fTex.addBinding(P, 'grainSize', { label: 'grain size', min: 0.05, max: 3, step: 0.005 });
fTex.addBinding(P, 'strokeLength', { label: 'stroke length', min: 1, max: 8, step: 0.05 });
fTex.addBinding(P, 'strokeWidth', { label: 'stroke width', min: 0.05, max: 1, step: 0.01 });
fTex.addBinding(P, 'flowAlign', { label: 'flow align', min: 0, max: 1, step: 0.01 });
fTex.addBinding(P, 'flowCurl', { label: 'flow curl', min: 0, max: 1, step: 0.01 });
fTex.addBinding(P, 'density', { min: 0.3, max: 2.5, step: 0.01 });
fTex.addBinding(P, 'paperShow', { label: 'paper show-through', min: 0, max: 0.6, step: 0.01 });
fTex.addBinding(P, 'raggedEdge', { label: 'ragged edge', min: 0, max: 1, step: 0.01 });
fTex.addBinding(info, 'grain', { readonly: true, label: 'grain' });

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
      renderer = new StrataRenderer();
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
  p.windowResized = () => { if (renderer) scheduleRender(120); };
  p.keyPressed = (e) => {
    if (!renderer) return true;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (e && (e.ctrlKey || e.metaKey || e.altKey)) return true; // keep Ctrl+R / Ctrl+S etc. for the browser
    if (p.key === 'R') randomizeParams();
    else if (p.key === 'r') setSeed(Math.floor(Math.random() * 1000000));
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

// Console access, e.g. strata.set({ scene: 'strata', seed: 7 })
window.strata = {
  P,
  set(obj) { Object.assign(P, obj); refreshPane(); scheduleRender(0); },
  export: doExport,
  randomize: randomizeParams,
  reset: resetParams,
  /** Render [x,y,w,h] of the full-resolution export in one pass (for checking tile seams). */
  renderExportRegion(x, y, w, h) {
    const pp = paper();
    ensureScene(pp);
    return renderArea(pp, pp.width, pp.height, x, y, w, h);
  },
};
