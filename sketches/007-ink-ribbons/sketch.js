// 007-ink-ribbons
// Twisted ribbons of pen lines that pinch and fan out, optionally over watercolour washes and paper
// texture, in vertical Instagram formats (4:5, 3:4, 9:16). Drawn with Canvas 2D.
// Pipeline: seeded scene (scene.js) -> Canvas 2D renderer (ribbon-2d.js, its own canvas shown directly
// in #stage) -> live preview, tiled high-res still PNG (lib/poster-export.js) or MP4/WebM video
// (lib/video-export.js) or PNG sequence (lib/frame-sequence.js). A requestAnimationFrame loop drives the animation.
import { Pane } from 'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js';
import { PALETTES, buildScene } from './scene.js';
import { RibbonRenderer } from './ribbon-2d.js';
import { DEFAULTS, PRESETS, FORMATS, formatSize, paletteColors } from './params.js';
import { exportPosterPNG, downloadJSON, pickJSONFile, downloadBlob } from '../../lib/poster-export.js';
import {
  exportVideo as encodeVideo, recordCanvas, recordCanvasFrames, slowdownFor, videoSupport, videoFilename,
} from '../../lib/video-export.js';
import { exportFrameSequence, pickSequenceDir, ffmpegCommand } from '../../lib/frame-sequence.js';

const SKETCH = 'ink-ribbons';
const PARAMS_VERSION = 1;
const STEP = 1 / 30; // seconds per `,` / `.` key press

const P = { ...DEFAULTS };
const info = {
  pixels: '', tiles: '', progress: 'idle', palette: '',
  video: '', vprogress: 'idle',
};

// ----------------------------------------------------------------------------- state
let renderer = null;
let sceneKey = '';
let exporting = false, abortCtl = null;
let dirty = true;
let loupe = { cx: 0.5, cy: 0.5 }; // centre of the 100% view, as fraction of the image
let lastParamsKey = '';
let lastTs = 0, fpsFrames = 0, fpsT0 = 0, fps = 0;
let lastSliderT = 0, lastHashT = 0, lastStatusT = 0;
let drawMs = 0;
let stepAcc = 0;      // frame-exact playback: wall time banked towards the next frame (ms)
let lastSlow = null;  // { k, fps } of the last slow-mo capture, for the output readout
let appliedCss = '';
let lastLoop = P.loopSeconds;
let supportCache = null;
const stageEl = document.getElementById('stage');
const statusEl = document.getElementById('status');

const setStatus = (s) => { statusEl.textContent = s; };
const wrapT = (t) => ((t % P.loopSeconds) + P.loopSeconds) % P.loopSeconds;
const fmtT = (t) => (Math.round(t * 100) / 100).toString();

/** Pixel size of the still export (1080 px wide x stillScale). */
function stillPx() { return formatSize(P.format, 1080 * P.stillScale); }
/** Pixel size of the video. */
function videoPx() { return formatSize(P.format, P.videoWidth); }
/** Pixel size of the output the preview is showing (always the format aspect). */
function outputPx() { return stillPx(); }

function ensureScene() {
  const key = `${P.seed}|${P.shapeIrregularity}`;
  if (key === sceneKey) return;
  sceneKey = key;
  renderer.setScene(buildScene(P.seed, P));
}

// ----------------------------------------------------------------------------- preview
/** Canvas CSS size, internal size and the window of the full image to draw. */
function previewLayout() {
  const out = outputPx();
  const wide = window.innerWidth > 900;
  const availW = window.innerWidth - (wide ? 330 : 0) - 32;
  const availH = window.innerHeight - 32 - 22;
  const aspect = out.width / out.height;
  let cssW = availW, cssH = availW / aspect;
  if (cssH > availH) { cssH = availH; cssW = availH * aspect; }
  cssW = Math.max(64, Math.floor(cssW)); cssH = Math.max(64, Math.floor(cssH));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (P.view === 'fit') {
    const w = Math.max(16, Math.round(cssW * dpr * P.previewScale));
    const h = Math.max(16, Math.round(w / aspect));
    return { cssW, cssH, w, h, fullW: w, fullH: h, x: 0, y: 0, label: `${w}×${h}` };
  }
  const W = out.width, H = out.height;
  const w = Math.min(Math.round(cssW * dpr), W), h = Math.min(Math.round(cssH * dpr), H);
  const x = Math.round(Math.max(0, Math.min(W - w, loupe.cx * W - w / 2)));
  const y = Math.round(Math.max(0, Math.min(H - h, loupe.cy * H - h / 2)));
  return { cssW: w / dpr, cssH: h / dpr, w, h, fullW: W, fullH: H, x, y, label: `100% of ${W}×${H}, x ${x} y ${y}` };
}

function applyCanvasCss(L) {
  const key = `${L.cssW}x${L.cssH}`;
  if (key === appliedCss) return;
  appliedCss = key;
  renderer.canvas.style.width = `${L.cssW}px`;
  renderer.canvas.style.height = `${L.cssH}px`;
}

function drawPreview() {
  const t0 = performance.now();
  ensureScene();
  const L = previewLayout();
  applyCanvasCss(L);
  renderer.draw({ P, t: P.time, w: L.w, h: L.h, fullW: L.fullW, fullH: L.fullH, x: L.x, y: L.y });
  drawMs = performance.now() - t0; // CPU submit time only; the GPU may still be busy
  updateInfo();
  return L;
}

function updateStatus(L) {
  let state = P.playing ? `${fps.toFixed(0)} fps` : 'paused';
  if (P.playing && P.fixedStep) state = `frame-exact · ${fps.toFixed(0)} fps rendered · x${(fps / P.videoFps).toFixed(2)} real-time`;
  setStatus(`seed ${P.seed} · ${P.format} · t ${fmtT(P.time)}/${P.loopSeconds}s · ${L ? L.label : ''} · ${drawMs.toFixed(0)} ms · ${state}   [Space play · R seed · Shift+R params · ←/→ seed · ,/. step · S still · V video · P snapshot · Z 100% · F frame-exact]`);
}

function writeHash() {
  try { history.replaceState(null, '', `#seed=${P.seed}&t=${P.time.toFixed(2)}`); } catch { /* file:// etc */ }
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (!renderer || exporting) { lastTs = ts; return; }
  const dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  if (P.playing) {
    if (P.fixedStep) {
      // frame-exact: one video frame (speed/fps seconds) per drawn frame, never faster than real time
      const frameMs = 1000 / P.videoFps;
      stepAcc = Math.min(stepAcc + dt * 1000, frameMs * 2);
      if (stepAcc >= frameMs - 2) { stepAcc = Math.max(0, stepAcc - frameMs); P.time = wrapT(P.time + P.speed / P.videoFps); dirty = true; }
    } else { stepAcc = 0; P.time = wrapT(P.time + dt * P.speed); dirty = true; }
  }
  if (!dirty) {
    if (ts - lastStatusT > 500) { lastStatusT = ts; updateStatus(null); }
    return;
  }
  dirty = false;
  const L = drawPreview();
  fpsFrames++;
  if (ts - fpsT0 > 500) { fps = (fpsFrames * 1000) / (ts - fpsT0); fpsFrames = 0; fpsT0 = ts; }
  if (P.playing && ts - lastSliderT > 100) { lastSliderT = ts; refreshTime(); }
  if (ts - lastStatusT > 250) { lastStatusT = ts; updateStatus(L); }
  if (ts - lastHashT > 500) { lastHashT = ts; writeHash(); }
}

function requestDraw() { dirty = true; }

// ----------------------------------------------------------------------------- info / support
function updateInfo() {
  const sp = stillPx();
  info.pixels = `${sp.width} × ${sp.height} px (${((sp.width * sp.height) / 1e6).toFixed(1)} MP)`;
  const tile = exportTileSize();
  info.tiles = `${Math.ceil(sp.width / tile) * Math.ceil(sp.height / tile)} tiles of ${tile}px · ${P.stillSS}× SS · 24-bit RGB PNG`;
  const dur = P.videoLoops * P.loopSeconds;
  const frames = Math.round(P.videoFps * dur);
  const mb = (P.videoBitrate * dur) / 8;
  const f = P.videoFormat;
  const vp = videoPx();
  if (f === 'webm') info.video = `${vp.width}×${vp.height} · ${dur} s real-time · ${frames} frames wanted, slow machines drop some · ~${mb.toFixed(0)} MB`;
  else if (f === 'webm-slow') {
    info.video = lastSlow
      ? `x${lastSlow.k} slow-mo · ${frames} frames · speed up: ${slowCmd(lastSlow.k, lastSlow.fps)}`
      : `${vp.width}×${vp.height} · ${frames} frames at a fixed slot (slow-down x measured at export) · ffmpeg speed-up command shown after`;
  } else if (f === 'png-seq') {
    info.video = `${frames} PNGs of ${vp.width}×${vp.height} · ~${((vp.width * vp.height * PNG_BYTES_PER_PX * frames) / 1e9).toFixed(1)} GB · folder (Chrome/Edge) or ZIP · ${ffmpegCommand(P.videoFps)}`;
  } else info.video = `${vp.width}×${vp.height} · ${dur} s · ${frames} frames · ~${mb.toFixed(0)} MB`;
}

const PNG_BYTES_PER_PX = 2; // rough estimate with paper texture
const slowCmd = (k, fpsV) => `ffmpeg -i in.webm -filter:v "setpts=PTS/${k}" -r ${fpsV} out.mp4`;

/** Tile edge for still export: the line layer is tile x supersampling, keep it <= 4096 px. */
function exportTileSize() {
  return Math.max(256, Math.floor(Math.min(2048, 4096 / P.stillSS) / 8) * 8);
}

// ----------------------------------------------------------------------------- still export
async function exportStill(opts = {}) {
  if (exporting || !renderer) return null;
  let blob = null;
  exporting = true;
  abortCtl = new AbortController();
  setBusy(true);
  const wasPlaying = P.playing;
  const t = P.time; // freeze the current time
  P.playing = false;
  refreshPane();
  const pp = stillPx();
  const t0 = performance.now();
  let filename = '';
  try {
    ensureScene();
    const tileSize = exportTileSize();
    filename = `${SKETCH}_seed-${P.seed}_t-${fmtT(t)}_${P.format.replace(':', 'x')}_${pp.width}x${pp.height}.png`;
    blob = await exportPosterPNG({
      width: pp.width, height: pp.height, dpi: 72 * P.stillScale, tileSize,
      bitDepth: 24,
      renderTile: async (x, y, w, h) => ({
        data: renderer.renderRegion({ P, t, fullW: pp.width, fullH: pp.height, x, y, w, h, ss: P.stillSS }),
        channels: 4,
      }),
      text: { Title: `${SKETCH} seed ${P.seed} t ${fmtT(t)}`, Software: 'Generative/007-ink-ribbons', Comment: JSON.stringify(serializeParams()) },
      filename: opts.noDownload ? undefined : filename,
      signal: abortCtl.signal,
      onProgress: ({ done, total, phase }) => {
        info.progress = phase === 'encode' ? 'encoding PNG…' : phase === 'done' ? 'done' : `tile ${done}/${total}`;
        setStatus(`exporting ${filename} · ${info.progress}`);
      },
    });
    info.progress = `saved ${filename} (${((performance.now() - t0) / 1000).toFixed(1)}s)`;
  } catch (e) {
    info.progress = e.name === 'AbortError' ? 'cancelled' : `error: ${e.message}`;
    console.error(e);
  } finally {
    renderer.trim(); // free the big tile FBOs
    exporting = false;
    P.playing = wasPlaying;
    setBusy(false);
    refreshPane();
    requestDraw();
    setStatus(`still: ${info.progress}`);
  }
  return blob;
}

/** Save the current preview canvas as PNG (screen resolution). */
function quickSnapshot(opts = {}) {
  if (exporting || !renderer) return Promise.resolve(null);
  drawPreview(); // draw and toBlob in the same task: the drawing buffer is still valid
  const name = `${SKETCH}_seed-${P.seed}_t-${fmtT(P.time)}_preview.png`;
  return new Promise((resolve) => {
    renderer.canvas.toBlob((blob) => {
      if (blob && !opts.noDownload) downloadBlob(blob, name);
      info.progress = blob ? `snapshot ${name}` : 'snapshot failed';
      refreshPane();
      resolve(blob);
    }, 'image/png');
  });
}

// ----------------------------------------------------------------------------- video export
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Draw frame i of the export, then block until the GPU has finished it (for timing). */
function drawAndSync(i, fpsV, vw, vh) {
  renderer.draw({ P, t: wrapT(i / fpsV), w: vw, h: vh, ss: P.videoSS });
  renderer.sync();
}

/**
 * Export the loop as video / PNG sequence. opts (all optional, mostly for testing): noDownload, format,
 * width, height, fps, frameCount, loops, slowdown (force the slow-mo factor), dirHandle (null forces ZIP).
 * Formats: 'mp4' (offline), 'webm' (real-time), 'webm-slow' (slow-mo capture), 'png-seq' (offline PNGs).
 */
async function exportVideo(opts = {}) {
  if (exporting || !renderer) return null;
  let { width: vw, height: vh } = videoPx();
  if (opts.width) vw = opts.width;
  if (opts.height) vh = opts.height;
  const fpsV = opts.fps || P.videoFps;
  const loops = opts.loops || P.videoLoops;
  const duration = loops * P.loopSeconds;
  const frameCount = opts.frameCount || Math.round(fpsV * duration);
  const seconds = opts.frameCount ? frameCount / fpsV : duration;
  const bitrate = P.videoBitrate * 1e6;
  let format = opts.format || P.videoFormat;

  // The folder picker needs a user gesture, so ask before any other await.
  let dirHandle = null;
  if (format === 'png-seq') {
    if ('dirHandle' in opts) dirHandle = opts.dirHandle;
    else {
      try { dirHandle = await pickSequenceDir(); } catch (e) {
        info.vprogress = e.name === 'AbortError' ? 'cancelled (no folder chosen)' : `error: ${e.message}`;
        setStatus(`video: ${info.vprogress}`);
        return null;
      }
    }
  }

  exporting = true;
  abortCtl = new AbortController();
  setBusy(true);
  const wasPlaying = P.playing;
  P.playing = false;
  refreshPane();
  const t0 = performance.now();
  let blob = null, codecNote = '', savedMsg = '';
  try {
    ensureScene();
    supportCache = supportCache || await videoSupport();
    const sup = supportCache;
    if (format === 'mp4' && !sup.webcodecs) { format = 'webm'; info.vprogress = 'WebCodecs unavailable, using real-time WebM'; }
    if (format === 'mp4' && (vw % 2 || vh % 2) && sup.h264) { vw -= vw % 2; vh -= vh % 2; }
    const ext = format === 'mp4' ? 'mp4' : 'webm';
    let filename = videoFilename({ name: SKETCH, seed: P.seed, width: vw, height: vh, fps: fpsV, seconds, ext });
    const note = () => codecNote ? ` · ${codecNote}` : '';
    const frameProgress = (frame, total, extra = '') => {
      const el = (performance.now() - t0) / 1000;
      const eta = frame > 0 ? (el / frame) * (total - frame) : 0;
      info.vprogress = `frame ${frame}/${total}${note()}${extra} · ${fmtDur(el)} elapsed · ETA ${fmtDur(eta)}`;
      setStatus(`video ${filename} · ${info.vprogress}`);
    };

    if (format === 'mp4') {
      blob = await encodeVideo({
        width: vw, height: vh, fps: fpsV, frameCount,
        renderFrame: async (i) => {
          // frame i at t = i/fps (never t = duration), so the file loops seamlessly
          renderer.draw({ P, t: wrapT(i / fpsV), w: vw, h: vh, ss: P.videoSS });
          return renderer.canvas;
        },
        bitrate, container: 'auto',
        signal: abortCtl.signal,
        onCodec: ({ container, codec }) => { codecNote = `${container} ${codec}`; },
        onProgress: ({ frame, total, phase }) => {
          if (phase === 'render' || phase === 'encode') frameProgress(frame, total);
          else { info.vprogress = `${phase}${note()}`; setStatus(`video ${filename} · ${info.vprogress}`); }
        },
      });
      if (blob && !opts.noDownload) {
        // 'auto' may have fallen back to WebM (no H.264 encoder): name the file after what it really is
        if (/webm/.test(blob.type)) filename = filename.replace(/\.mp4$/, '.webm');
        downloadBlob(blob, filename);
      }
    } else if (format === 'png-seq') {
      const stem = filename.replace(/\.[^.]+$/, '');
      filename = dirHandle ? `${stem}/` : `${stem}.zip`;
      codecNote = dirHandle ? 'PNG → folder' : 'PNG → ZIP (store-only)';
      const res = await exportFrameSequence({
        fps: fpsV, frameCount, name: stem, dirHandle,
        renderFrame: async (i) => {
          renderer.draw({ P, t: wrapT(i / fpsV), w: vw, h: vh, ss: P.videoSS });
          return renderer.canvas; // encoded right after this returns, same task, buffer preserved
        },
        ffmpegOut: `${stem}.mp4`,
        download: !opts.noDownload,
        signal: abortCtl.signal,
        onWarn: (m) => { console.warn(m); savedMsg += ` · WARNING ${m}`; },
        onProgress: ({ frame, total, phase, bytes }) => {
          if (phase === 'render' || phase === 'save') frameProgress(frame, total, ` · ${(bytes / 1e6).toFixed(0)} MB`);
          else { info.vprogress = `${phase === 'zip' ? 'building ZIP' : phase}${note()}`; setStatus(`video ${filename} · ${info.vprogress}`); }
        },
      });
      blob = res.blob;
      savedMsg = (dirHandle ? ` · ${frameCount} PNGs + ffmpeg.txt in ${dirHandle.name}/${stem}/` : ' · ffmpeg.txt inside the ZIP') + savedMsg;
      info.vprogress = `saved ${filename} (${((performance.now() - t0) / 1000).toFixed(1)}s, ${(res.bytes / 1e6).toFixed(1)} MB)${savedMsg}`;
    } else if (format === 'webm-slow') {
      if (!sup.mediaRecorder) throw new Error('MediaRecorder is not available in this browser');
      // measure the real per-frame render time (GPU-synced), then pick an integer slow-down k
      const ms = [];
      for (let i = 0; i < 5; i++) {
        const c0 = performance.now();
        drawAndSync(i, fpsV, vw, vh);
        ms.push(performance.now() - c0);
        await new Promise((r) => setTimeout(r, 0));
      }
      const warm = ms.slice(1).sort((x, y) => x - y);
      const renderMs = warm[Math.floor(warm.length / 2)];
      const k = opts.slowdown || slowdownFor(renderMs, fpsV);
      const slotMs = (1000 * k) / fpsV;
      filename = filename.replace(/\.webm$/, `_slow-x${k}.webm`);
      codecNote = `slow-mo x${k} · ${renderMs.toFixed(0)} ms/frame · slot ${slotMs.toFixed(0)} ms`;
      lastSlow = { k, fps: fpsV };
      blob = await recordCanvasFrames({
        canvas: renderer.canvas, frameCount, slotMs, bitrate,
        mimeType: sup.webmMime || undefined,
        renderFrame: (i) => { renderer.draw({ P, t: wrapT(i / fpsV), w: vw, h: vh, ss: P.videoSS }); },
        filename: opts.noDownload ? undefined : filename,
        signal: abortCtl.signal,
        onProgress: ({ frame, total }) => {
          const el = (performance.now() - t0) / 1000;
          info.vprogress = `capturing ${frame}/${total}${note()} · ETA ${fmtDur((el / Math.max(1, frame)) * (total - frame))}`;
          setStatus(`video ${filename} · ${info.vprogress}`);
        },
      });
      savedMsg = ` · plays x${k} too slow; speed up: ${slowCmd(k, fpsV)}`;
      console.log(`[slow-mo] ${filename}\n${slowCmd(k, fpsV)}`);
    } else {
      // real-time: the canvas is animated here while MediaRecorder captures it
      let stop = false;
      const rtStart = performance.now();
      renderer.draw({ P, t: 0, w: vw, h: vh, ss: P.videoSS });
      const tick = () => {
        if (stop) return;
        renderer.draw({ P, t: wrapT((performance.now() - rtStart) / 1000), w: vw, h: vh, ss: P.videoSS });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      codecNote = 'webm (real-time MediaRecorder)';
      try {
        blob = await recordCanvas({
          canvas: renderer.canvas, fps: fpsV, durationSec: seconds, bitrate,
          mimeType: sup.webmMime || undefined, // force WebM so the file matches the .webm name
          filename: opts.noDownload ? undefined : filename,
          signal: abortCtl.signal,
          onProgress: ({ frame, total }) => {
            info.vprogress = `recording ${(frame / 1000).toFixed(1)}/${(total / 1000).toFixed(1)} s${note()} · ETA ${fmtDur((total - frame) / 1000)}`;
            setStatus(`video ${filename} · ${info.vprogress}`);
          },
        });
      } finally { stop = true; }
    }
    if (format !== 'png-seq') {
      info.vprogress = `saved ${filename} (${((performance.now() - t0) / 1000).toFixed(1)}s, ${(blob.size / 1e6).toFixed(1)} MB)${note()}${savedMsg}`;
    }
  } catch (e) {
    info.vprogress = e.name === 'AbortError' ? 'cancelled' : `error: ${e.message}`;
    console.error(e);
  } finally {
    exporting = false;
    P.playing = wasPlaying;
    appliedCss = ''; // preview size is restored by the next draw; CSS size never changed
    setBusy(false);
    refreshPane();
    requestDraw();
    setStatus(`video: ${info.vprogress}`);
  }
  return blob;
}

// ----------------------------------------------------------------------------- params
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
    P.time = wrapT(P.time);
    lastPalette = P.palette;
    afterParamsChanged();
  } catch (e) {
    setStatus(`could not load params: ${e.message}`);
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const r2 = (v) => +v.toFixed(2);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randomizeParams() {
  const layout = pick(['columns', 'columns', 'meander', 'rows']);
  const palette = pick(Object.keys(PALETTES));
  Object.assign(P, {
    layout,
    ribbonCount: layout === 'meander' ? pick([1, 1, 2, 3]) : rndInt(2, 6),
    ribbonWidth: r2(rnd(0.45, 0.9)),
    sway: r2(rnd(0.1, 0.6)),
    meander: r2(rnd(0.4, 0.8)),
    turns: r2(rnd(1, 2.4)),
    pinches: r2(rnd(layout === 'meander' ? 1.5 : 3, layout === 'meander' ? 3.5 : 7)),
    twistNoise: r2(rnd(0.3, 1.4)),
    cup: r2(rnd(0, 0.7)),
    cupVar: r2(rnd(0.2, 1)),
    tilt: r2(rnd(0, 0.5)),
    widthVar: r2(rnd(0.1, 0.5)),
    lines: rndInt(14, 44),
    spread: r2(rnd(0.8, 1.3)),
    lineWidth: r2(layout === 'meander' ? rnd(1.2, 3) : rnd(0.7, 1.8)),
    lineWidthVar: r2(rnd(0.1, 0.6)),
    edgeWeight: r2(rnd(1, 2.2)),
    pressure: r2(rnd(0, 0.5)),
    dashMix: pick([0, 0, 0, 0.3, 0.5, 1]),
    axisLine: Math.random() < 0.25,
    accentRatio: pick([0, 0, 0.05, 0.12]),
    echoCount: pick([0, 0, 1, 2]),
    border: layout !== 'meander' && Math.random() < 0.7,
    shapes: Math.random() < 0.5,
    shapeStyle: pick(['watercolor', 'watercolor', 'flat']),
    shapeCount: rndInt(3, 14),
    shapeSize: r2(rnd(0.6, 1.4)),
    lineColorMode: pick(['ink', 'ink', 'ink', 'gradient', 'ribbons']),
    palette,
    ...paletteColors(palette),
  });
  afterParamsChanged();
}

function applyPreset(name) {
  const pr = PRESETS[name];
  if (!pr) return;
  Object.assign(P, pr, paletteColors(pr.palette));
  lastPalette = P.palette;
  afterParamsChanged();
}

function resetParams() {
  const keep = {
    format: P.format, stillScale: P.stillScale, stillSS: P.stillSS,
    videoWidth: P.videoWidth, videoFps: P.videoFps, videoLoops: P.videoLoops, videoBitrate: P.videoBitrate,
    videoFormat: P.videoFormat, videoSS: P.videoSS, view: P.view, seed: P.seed, time: 0, playing: P.playing,
  };
  Object.assign(P, DEFAULTS, keep);
  lastPalette = P.palette;
  afterParamsChanged();
}

function afterParamsChanged() {
  syncLoop();
  refreshPane();
  requestDraw();
}

// ----------------------------------------------------------------------------- UI
let suppress = false;
let lastPalette = P.palette;
const pane = new Pane({ title: 'Ink Ribbons', container: document.getElementById('pane') });
// pane.refresh() can write the step-rounded slider value (0.01) back into P.time; keep the exact time
function refreshPane() { const t = P.time; suppress = true; try { pane.refresh(); } finally { suppress = false; P.time = t; } }
function setSeed(s) { P.seed = ((s % 1000000) + 1000000) % 1000000; refreshPane(); requestDraw(); }

const fSeed = pane.addFolder({ title: 'Seed & presets' });
fSeed.addBinding(P, 'seed', { min: 0, max: 999999, step: 1 });
fSeed.addButton({ title: 'Randomize seed (R)' }).on('click', () => setSeed(Math.floor(Math.random() * 1000000)));
fSeed.addButton({ title: 'Randomize params (Shift+R)' }).on('click', randomizeParams);
fSeed.addButton({ title: 'Reset to defaults' }).on('click', resetParams);
for (const name of Object.keys(PRESETS)) fSeed.addButton({ title: `Preset: ${name}` }).on('click', () => applyPreset(name));

const fLayout = pane.addFolder({ title: 'Layout' });
const fmtOpts = {};
for (const [k, v] of Object.entries(FORMATS)) fmtOpts[v.label] = k;
fLayout.addBinding(P, 'format', { options: fmtOpts });
fLayout.addBinding(P, 'layout', { options: { 'vertical columns': 'columns', 'meander (S-curves)': 'meander', 'horizontal rows': 'rows' } });
fLayout.addBinding(P, 'ribbonCount', { label: 'ribbons', min: 1, max: 10, step: 1 });
fLayout.addBinding(P, 'ribbonWidth', { label: 'ribbon width', min: 0.1, max: 1.5, step: 0.01 });
fLayout.addBinding(P, 'margin', { min: 0, max: 0.25, step: 0.005 });
fLayout.addBinding(P, 'sway', { min: 0, max: 1.5, step: 0.01 });
fLayout.addBinding(P, 'swayFreq', { label: 'sway freq', min: 0.2, max: 5, step: 0.01 });
fLayout.addBinding(P, 'meander', { label: 'meander amp', min: 0, max: 1.2, step: 0.01 });
fLayout.addBinding(P, 'turns', { label: 'meander turns', min: 0.3, max: 4, step: 0.01 });

const fTwist = pane.addFolder({ title: 'Twist' });
fTwist.addBinding(P, 'pinches', { min: 0, max: 14, step: 0.1 });
fTwist.addBinding(P, 'pinchJitter', { label: 'pinch jitter', min: 0, max: 1, step: 0.01 });
fTwist.addBinding(P, 'twistNoise', { label: 'twist noise', min: 0, max: 3, step: 0.01 });
fTwist.addBinding(P, 'cup', { label: 'cup (fold)', min: -1, max: 1.5, step: 0.01 });
fTwist.addBinding(P, 'cupVar', { label: 'cup variation', min: 0, max: 2, step: 0.01 });
fTwist.addBinding(P, 'tilt', { min: -1, max: 1.2, step: 0.01 });
fTwist.addBinding(P, 'widthVar', { label: 'width variation', min: 0, max: 1, step: 0.01 });
fTwist.addBinding(P, 'widthFreq', { label: 'width freq', min: 0.2, max: 8, step: 0.01 });

const fLines = pane.addFolder({ title: 'Lines' });
fLines.addBinding(P, 'lines', { label: 'lines / ribbon', min: 2, max: 120, step: 1 });
fLines.addBinding(P, 'spread', { label: 'spread (edge ↔ centre)', min: 0.4, max: 2.5, step: 0.01 });
fLines.addBinding(P, 'lineJitter', { label: 'spacing jitter', min: 0, max: 1, step: 0.01 });
fLines.addBinding(P, 'lineWidth', { label: 'line width px', min: 0.2, max: 8, step: 0.05 });
fLines.addBinding(P, 'lineWidthVar', { label: 'width variation', min: 0, max: 1, step: 0.01 });
fLines.addBinding(P, 'edgeWeight', { label: 'edge weight', min: 0.3, max: 5, step: 0.05 });
fLines.addBinding(P, 'pressure', { label: 'pen pressure', min: 0, max: 1, step: 0.01 });
fLines.addBinding(P, 'depthWidth', { label: 'depth width', min: 0, max: 1.5, step: 0.01 });
fLines.addBinding(P, 'lineOpacity', { label: 'opacity', min: 0.05, max: 1, step: 0.01 });
fLines.addBinding(P, 'dashMix', { label: 'dashed ribbons', min: 0, max: 1, step: 0.01 });
fLines.addBinding(P, 'dashLength', { label: 'dash length px', min: 1, max: 40, step: 0.5 });
fLines.addBinding(P, 'dashGap', { label: 'dash gap px', min: 1, max: 30, step: 0.5 });
fLines.addBinding(P, 'axisLine', { label: 'axis line' });

const fAcc = pane.addFolder({ title: 'Accents & echoes', expanded: false });
fAcc.addBinding(P, 'accentRatio', { label: 'accent strokes', min: 0, max: 1, step: 0.01 });
fAcc.addBinding(P, 'accentLength', { label: 'accent length', min: 0.05, max: 1, step: 0.01 });
fAcc.addBinding(P, 'echoCount', { label: 'echo outlines', min: 0, max: 5, step: 1 });
fAcc.addBinding(P, 'echoGap', { label: 'echo gap', min: 0.02, max: 1, step: 0.01 });
fAcc.addBinding(P, 'echoWobble', { label: 'echo wobble', min: 0, max: 1.5, step: 0.01 });
fAcc.addBinding(P, 'echoWidth', { label: 'echo width px', min: 0.2, max: 5, step: 0.05 });
fAcc.addBinding(P, 'echoOpacity', { label: 'echo opacity', min: 0, max: 1, step: 0.01 });

const fFrame = pane.addFolder({ title: 'Frame', expanded: false });
fFrame.addBinding(P, 'border', { label: 'border' });
fFrame.addBinding(P, 'borderMargin', { label: 'border margin', min: 0, max: 0.2, step: 0.005 });
fFrame.addBinding(P, 'borderWidth', { label: 'border width px', min: 0.3, max: 10, step: 0.1 });
fFrame.addBinding(P, 'clipToFrame', { label: 'clip ribbons to frame' });

const fShapes = pane.addFolder({ title: 'Background shapes' });
fShapes.addBinding(P, 'shapes', { label: 'show shapes' });
fShapes.addBinding(P, 'shapeStyle', { label: 'style', options: { watercolour: 'watercolor', flat: 'flat', outline: 'outline' } });
fShapes.addBinding(P, 'shapeCount', { label: 'count', min: 0, max: 40, step: 1 });
fShapes.addBinding(P, 'shapeSize', { label: 'size', min: 0.2, max: 3, step: 0.01 });
fShapes.addBinding(P, 'shapeOpacity', { label: 'opacity', min: 0, max: 1, step: 0.01 });
fShapes.addBinding(P, 'shapeDrops', { label: 'drops size', min: 0, max: 3, step: 0.01 });
fShapes.addBinding(P, 'shapeRim', { label: 'wash rim', min: 0, max: 1, step: 0.01 });
fShapes.addBinding(P, 'shapeIrregularity', { label: 'irregularity', min: 0, max: 1, step: 0.01 });
fShapes.addBinding(P, 'shapeBlend', { label: 'blend', options: { auto: 'auto', multiply: 'multiply', screen: 'screen', normal: 'normal' } });

const fColour = pane.addFolder({ title: 'Colour' });
const paletteOpts = {};
for (const [k, v] of Object.entries(PALETTES)) paletteOpts[v.label || k] = k;
fColour.addBinding(P, 'palette', { options: paletteOpts });
fColour.addBinding(P, 'ground', { label: 'paper' });
fColour.addBinding(P, 'ink');
fColour.addBinding(P, 'accent');
fColour.addBinding(P, 'echo');
fColour.addBinding(P, 'wash1', { label: 'wash 1' });
fColour.addBinding(P, 'wash2', { label: 'wash 2' });
fColour.addBinding(P, 'wash3', { label: 'wash 3' });
fColour.addBinding(P, 'frameColor', { label: 'frame' });
fColour.addBinding(P, 'lineColorMode', { label: 'line colours', options: { 'ink': 'ink', 'gradient ink → accent': 'gradient', 'per ribbon': 'ribbons' } });
fColour.addBinding(P, 'inkBlend', { label: 'ink blend', options: { auto: 'auto', multiply: 'multiply', screen: 'screen', normal: 'normal' } });
fColour.addBinding(P, 'paperTexture', { label: 'paper texture', min: 0, max: 1, step: 0.01 });

const fMotion = pane.addFolder({ title: 'Motion' });
fMotion.addBinding(P, 'playing');
fMotion.addButton({ title: 'Play / pause (Space)' }).on('click', togglePlay);
let timeBinding = null;
function makeTimeBinding() {
  timeBinding?.dispose();
  timeBinding = fMotion.addBinding(P, 'time', { min: 0, max: P.loopSeconds, step: 0.01, index: 2 });
}
makeTimeBinding();
fMotion.addBinding(P, 'speed', { min: 0, max: 4, step: 0.01 });
fMotion.addBinding(P, 'fixedStep', { label: 'frame-exact (slow-mo)' });
fMotion.addBinding(P, 'loopSeconds', { label: 'loop seconds', min: 4, max: 60, step: 1 });
fMotion.addBinding(P, 'flow', { label: 'twist turns / loop', min: -4, max: 4, step: 1 });
fMotion.addBinding(P, 'flowAlternate', { label: 'alternate direction' });
fMotion.addBinding(P, 'morph', { min: 0, max: 2, step: 0.01 });
fMotion.addBinding(P, 'previewScale', { label: 'preview scale', min: 0.25, max: 1, step: 0.05 });

const fStill = pane.addFolder({ title: 'Still export' });
fStill.addBinding(P, 'stillScale', { label: 'scale', options: { '1× (1080 wide)': 1, '2× (2160)': 2, '3× (3240)': 3, '4× (4320)': 4, '6× (6480)': 6 } });
fStill.addBinding(P, 'stillSS', { label: 'supersampling', options: { '1×': 1, '2×': 2, '4×': 4 } });
fStill.addBinding(info, 'pixels', { readonly: true, label: 'size' });
fStill.addBinding(info, 'tiles', { readonly: true, label: 'output' });
const stillBtn = fStill.addButton({ title: 'Export still at current time (S)' });
stillBtn.on('click', () => exportStill());
fStill.addButton({ title: 'Quick snapshot (screen) (P)' }).on('click', () => quickSnapshot());
const stillCancel = fStill.addButton({ title: 'Cancel export' });
stillCancel.on('click', () => abortCtl?.abort());
fStill.addBinding(info, 'progress', { readonly: true, label: 'status' });
fStill.addButton({ title: 'Save params JSON' }).on('click', () => downloadJSON(serializeParams(), `${SKETCH}_seed-${P.seed}.json`));
fStill.addButton({ title: 'Load params JSON' }).on('click', loadParams);

const fVid = pane.addFolder({ title: 'Video export' });
fVid.addBinding(P, 'videoWidth', { label: 'width', options: { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 } });
fVid.addBinding(P, 'videoFps', { label: 'fps', options: { '24': 24, '30': 30, '60': 60 } });
fVid.addBinding(P, 'videoLoops', { label: 'loops', min: 1, max: 8, step: 1 });
fVid.addBinding(P, 'videoBitrate', { label: 'bitrate Mbps', min: 2, max: 150, step: 1 });
fVid.addBinding(P, 'videoFormat', { label: 'format', options: {
  'MP4 (offline, frame-exact)': 'mp4', 'WebM (real-time, may drop frames)': 'webm',
  'WebM slow-mo (speed up after)': 'webm-slow', 'PNG sequence (frame-exact)': 'png-seq',
} });
fVid.addBinding(P, 'videoSS', { label: 'supersampling', options: { '1×': 1, '2×': 2 } });
fVid.addBinding(info, 'video', { readonly: true, label: 'output', multiline: true, rows: 4 });
const vidBtn = fVid.addButton({ title: 'Export video (V)' });
vidBtn.on('click', () => exportVideo());
const vidCancel = fVid.addButton({ title: 'Cancel export' });
vidCancel.on('click', () => abortCtl?.abort());
fVid.addBinding(info, 'vprogress', { readonly: true, label: 'status' });

const fView = pane.addFolder({ title: 'Preview' });
fView.addBinding(P, 'view', { options: { 'fit (preview scale)': 'fit', '100% (export pixels)': 'actual' } });

function setBusy(b) {
  stillBtn.disabled = b; vidBtn.disabled = b;
  stillCancel.disabled = !b; vidCancel.disabled = !b;
}
setBusy(false);

function refreshTime() {
  const t = P.time;
  suppress = true;
  try { timeBinding.refresh(); } finally { suppress = false; P.time = t; }
}

/** loopSeconds changed: clamp time and rebuild the time slider with the new range. */
function syncLoop() {
  if (P.loopSeconds !== lastLoop) {
    lastLoop = P.loopSeconds;
    makeTimeBinding();
  }
  P.time = wrapT(P.time);
}

function togglePlay() { P.playing = !P.playing; refreshPane(); requestDraw(); }

// Only redraw when a real parameter changed (readonly monitors also emit 'change').
pane.on('change', () => {
  if (suppress) return;
  if (P.palette !== lastPalette) {
    // a new palette loads its colours into the editable colour fields
    lastPalette = P.palette;
    Object.assign(P, paletteColors(P.palette));
    refreshPane();
  }
  syncLoop();
  const k = JSON.stringify(P);
  if (k === lastParamsKey) return;
  lastParamsKey = k;
  requestDraw();
});

// ----------------------------------------------------------------------------- input
function onKey(e) {
  if (!renderer) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // keep Ctrl+R / Ctrl+S etc. for the browser
  const k = e.key;
  if (k === ' ') togglePlay();
  else if (k === 'R') randomizeParams();
  else if (k === 'r') setSeed(Math.floor(Math.random() * 1000000));
  else if (k === 'ArrowLeft') setSeed(P.seed - 1);
  else if (k === 'ArrowRight') setSeed(P.seed + 1);
  else if ((k === ',' || k === '.') && !P.playing && !exporting) { P.time = wrapT(P.time + (k === '.' ? STEP : -STEP)); refreshTime(); requestDraw(); }
  else if (k === 's' || k === 'S') exportStill();
  else if (k === 'v' || k === 'V') exportVideo();
  else if (k === 'p' || k === 'P') quickSnapshot();
  else if (k === 'f' || k === 'F') { P.fixedStep = !P.fixedStep; stepAcc = 0; refreshPane(); requestDraw(); }
  else if (k === 'z' || k === 'Z') { P.view = P.view === 'fit' ? 'actual' : 'fit'; refreshPane(); requestDraw(); }
  else if (k === 'Escape' && P.view !== 'fit') { P.view = 'fit'; refreshPane(); requestDraw(); }
  else return;
  e.preventDefault();
}
window.addEventListener('keydown', onKey);
window.addEventListener('keyup', (e) => { if (e.key === ' ' && document.activeElement?.tagName === 'BUTTON') e.preventDefault(); });
window.addEventListener('resize', () => { requestDraw(); });

// click in fit view -> 100% view centred there; drag in 100% view -> pan
function onCanvasDown(e) {
  if (exporting) return;
  const rect = renderer.canvas.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
  if (P.view === 'fit') {
    loupe = { cx: fx, cy: fy };
    P.view = 'actual';
    refreshPane();
    requestDraw();
    return;
  }
  const out = outputPx();
  const start = { x: e.clientX, y: e.clientY, cx: loupe.cx, cy: loupe.cy };
  const dpr = renderer.canvas.width / rect.width;
  const move = (ev) => {
    const dx = (ev.clientX - start.x) * dpr, dy = (ev.clientY - start.y) * dpr;
    loupe = {
      cx: Math.min(1, Math.max(0, start.cx - dx / out.width)),
      cy: Math.min(1, Math.max(0, start.cy - dy / out.height)),
    };
    requestDraw();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ----------------------------------------------------------------------------- boot
try {
  renderer = new RibbonRenderer();
} catch (e) {
  setStatus(`Canvas 2D unavailable: ${e.message}`);
}
if (renderer) {
  const hs = /seed=(\d+)/.exec(location.hash);
  if (hs) P.seed = +hs[1] % 1000000;
  const ht = /[#&]t=([\d.]+)/.exec(location.hash);
  if (ht) P.time = wrapT(parseFloat(ht[1]) || 0);
  stageEl.appendChild(renderer.canvas);
  renderer.canvas.addEventListener('pointerdown', onCanvasDown);
  lastParamsKey = JSON.stringify(P);
  refreshPane();
  requestAnimationFrame(loop);
}

// Console access, e.g. ribbons.set({ layout: 'meander', seed: 7 }) or ribbons.preset('Twin meanders')
window.ribbons = {
  P,
  set(obj) { Object.assign(P, obj); afterParamsChanged(); },
  exportStill,
  exportVideo,
  snapshot: quickSnapshot,
  randomize: randomizeParams,
  preset: applyPreset,
  reset: resetParams,
  renderer, info,
};
