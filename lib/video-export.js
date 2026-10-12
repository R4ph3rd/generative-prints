// lib/video-export.js
// ---------------------------------------------------------------------------
// Reusable video export helpers for the sketches in this repo (ES module).
// Sibling of lib/poster-export.js: same idea (a sketch hands over a render
// callback, this module does the encoding plumbing), but for animation.
//
// Two paths, because they solve different problems:
//
//  1. exportVideo()  - OFFLINE and FRAME-EXACT.
//     For frame i the sketch renders time i / fps into a canvas (as slowly as it
//     likes: SwiftShader, 4K, supersampled), we snapshot it into a WebCodecs
//     VideoFrame with an explicit timestamp, encode it, and mux the chunks into
//     MP4 (H.264) or WebM (VP9). Wall-clock speed is irrelevant, so a 4K frame
//     that takes 3 s to draw still yields a perfectly smooth 30 fps file.
//     This is the path to use for anything you want to publish.
//
//  2. recordCanvas() - REAL-TIME fallback.
//     MediaRecorder on canvas.captureStream(fps). The caller keeps animating the
//     canvas live; we only record. Frames are timestamped by the wall clock, so
//     a slow renderer drops frames. Use it where WebCodecs is missing (older
//     Firefox / Safari) or as a quick preview capture.
//
// Why mp4-muxer / webm-muxer from a CDN instead of writing a muxer here?
//   WebCodecs only produces encoded chunks; the container is on us. These two
//   small libraries (Vanilagy) are the standard answer. They are loaded LAZILY
//   with dynamic import() so pages that never export video never fetch them.
//   NOTE: both are marked deprecated on npm in favour of `mediabunny`
//   (same author). The pinned 5.x builds still work and are tiny, so we keep
//   them; migrate to mediabunny if they ever break.
//
// Constraints worth knowing:
//   - H.264 needs EVEN width and height (4:2:0 chroma). exportVideo() throws a
//     clear error for odd sizes with H.264. Pass even sizes (all presets do).
//   - Output is whatever the browser's encoder supports; headless / Linux
//     Chromium often has no H.264 encoder, so 'auto' falls back to VP9/WebM.
//   - The whole file is held in memory (fastStart: 'in-memory' puts the moov
//     box up front so the MP4 streams/plays instantly). 4K x 60 s at 16 Mbps
//     is ~120 MB, fine.
//
// Usage:
//   import { exportVideo, recordCanvas, videoSupport, videoFilename } from '../../lib/video-export.js';
//   const fps = 30, seconds = 12;
//   await exportVideo({
//     width: 1080, height: 1350, fps, frameCount: fps * seconds,
//     renderFrame: async (i, t) => { renderer.draw({ P, t, w: 1080, h: 1350 }); return renderer.canvas; },
//     bitrate: 16_000_000,                   // bits per second
//     container: 'auto',                     // 'mp4' | 'webm' | 'auto' (mp4 if H.264 works, else webm)
//     filename: videoFilename({ name: 'silk-flow', seed: 1234, width: 1080, height: 1350, fps, seconds }),
//     onProgress: ({ frame, total, phase }) => {},
//     signal: abortController.signal,
//   });
//
//   // Real-time fallback (keep drawing the canvas yourself while this runs):
//   await recordCanvas({ canvas, fps: 30, durationSec: 12, bitrate: 12_000_000, filename: 'take.webm' });
//
// Loop tip: for a seamless loop render frameCount = fps * loopSeconds frames
// (times 0 .. (N-1)/fps); frame N would equal frame 0 and be a duplicate.
// ---------------------------------------------------------------------------

import { downloadBlob, yieldToUI } from './poster-export.js';

/** Pinned muxer builds (verified to exist on jsDelivr and export ArrayBufferTarget + Muxer). */
export const MUXER_URLS = {
  mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs',
  webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs',
};

const MAX_QUEUE = 4;          // pending encode() calls before we wait
const KEYFRAME_SECONDS = 2;   // a keyframe about every 2 s

// --------------------------------------------------------------------------- codec selection

/** H.264 levels: [level_idc, MaxFS (macroblocks/frame), MaxMBPS (macroblocks/s)]. */
const AVC_LEVELS = [
  [0x1f, 3600, 108000],     // 3.1
  [0x20, 5120, 216000],     // 3.2
  [0x28, 8192, 245760],     // 4.0
  [0x2a, 8704, 522240],     // 4.2
  [0x32, 22080, 589824],    // 5.0
  [0x33, 36864, 983040],    // 5.1
  [0x34, 36864, 2073600],   // 5.2
];

const hex2 = (n) => n.toString(16).padStart(2, '0');

/**
 * Ordered H.264 codec strings to try for this size/rate: High, then Main, then
 * Baseline, each starting at the lowest level that fits width x height x fps and
 * climbing upward (some encoders only accept the higher levels).
 */
export function h264Candidates(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * fps;
  let start = AVC_LEVELS.findIndex(([, fs, rate]) => mbs <= fs && mbps <= rate);
  if (start < 0) start = AVC_LEVELS.length - 1;
  const levels = AVC_LEVELS.slice(start).map(([l]) => l);
  const out = [];
  for (const [profile, constraints] of [[0x64, 0x00], [0x4d, 0x00], [0x42, 0x00]]) {
    for (const l of levels) out.push(`avc1.${hex2(profile)}${hex2(constraints)}${hex2(l)}`);
  }
  return out;
}

/** VP9 candidates (profile 0, 8-bit), levels 4.1 -> 5.1 -> 6.0. */
const VP9_CANDIDATES = ['vp09.00.41.08', 'vp09.00.50.08', 'vp09.00.51.08', 'vp09.00.40.08', 'vp09.00.10.08'];

function baseConfig(codec, o) {
  return {
    codec,
    width: o.width,
    height: o.height,
    bitrate: o.bitrate,
    framerate: o.fps,
    bitrateMode: 'variable',
    latencyMode: 'quality',
  };
}

/** First supported config from a candidate list, or null. */
async function firstSupported(codecs, o, extra = {}) {
  for (const codec of codecs) {
    const cfg = { ...baseConfig(codec, o), ...extra };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r?.supported) return { ...cfg, ...(r.config || {}), codec }; // keep our codec string
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Pick container + encoder config. Returns { container, config } or throws.
 * @param {{width:number,height:number,fps:number,bitrate:number}} o
 * @param {'mp4'|'webm'|'auto'} container
 */
async function pickCodec(o, container) {
  if (container !== 'webm') {
    if (o.width % 2 || o.height % 2) {
      if (container === 'mp4') throw new Error(`H.264/MP4 needs even dimensions, got ${o.width}x${o.height}`);
    } else {
      const config = await firstSupported(h264Candidates(o.width, o.height, o.fps), o, { avc: { format: 'avc' } });
      if (config) return { container: 'mp4', config };
      if (container === 'mp4') throw new Error('No H.264 encoder available in this browser (try container: "webm" or "auto")');
    }
  }
  const config = await firstSupported(VP9_CANDIDATES, o);
  if (config) return { container: 'webm', config };
  throw new Error(`No supported video encoder for ${o.width}x${o.height} @ ${o.fps} fps`);
}

// --------------------------------------------------------------------------- feature detection

/**
 * Cheap capability probe (does not allocate an encoder).
 * h264 / vp9 are tested with a small 1280x720 @ 30 config, so they say "this
 * browser can do it at all"; exportVideo() re-checks the real size.
 * @returns {Promise<{webcodecs:boolean,h264:boolean,vp9:boolean,mediaRecorder:boolean,webmMime:string|null}>}
 */
export async function videoSupport() {
  const webcodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  const mediaRecorder = typeof MediaRecorder !== 'undefined';
  let h264 = false;
  let vp9 = false;
  if (webcodecs) {
    const probe = { width: 1280, height: 720, fps: 30, bitrate: 5_000_000 };
    h264 = !!(await firstSupported(h264Candidates(1280, 720, 30), probe, { avc: { format: 'avc' } }));
    vp9 = !!(await firstSupported(VP9_CANDIDATES, probe));
  }
  const webmMime = mediaRecorder
    ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || null
    : null;
  return { webcodecs, h264, vp9, mediaRecorder, webmMime };
}

/** e.g. silk-flow_seed-1234_1080x1350_30fps_12s.mp4 */
export function videoFilename({ name, seed, width, height, fps, seconds, ext = 'mp4' }) {
  const parts = [name, `seed-${seed}`];
  if (width && height) parts.push(`${width}x${height}`);
  if (fps) parts.push(`${fps}fps`);
  if (seconds) parts.push(`${Math.round(seconds * 100) / 100}s`);
  return `${parts.join('_')}.${ext}`;
}

// --------------------------------------------------------------------------- offline export

const abortError = () => new DOMException('Export aborted', 'AbortError');

/** Resolve once the encoder queue is short again (dequeue event, with a poll as safety net). */
function waitForQueue(encoder, signal) {
  if (encoder.encodeQueueSize <= MAX_QUEUE) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      encoder.removeEventListener('dequeue', check);
      resolve();
    };
    const check = () => {
      if (encoder.encodeQueueSize <= MAX_QUEUE || encoder.state === 'closed' || signal?.aborted) done();
      else timer = setTimeout(check, 4);
    };
    encoder.addEventListener('dequeue', check);
    check();
  });
}

/**
 * Render, encode and mux a video, frame by frame (offline, frame-exact).
 *
 * @param {object} o
 * @param {number} o.width   output width in px (must be even for MP4/H.264)
 * @param {number} o.height  output height in px (must be even for MP4/H.264)
 * @param {number} o.fps
 * @param {number} o.frameCount
 * @param {(index:number, timeSec:number)=>Promise<CanvasImageSource>|CanvasImageSource} o.renderFrame
 *        Must return a canvas (or other VideoFrame source) currently holding frame `index`.
 *        timeSec = index / fps.
 * @param {number} [o.bitrate=16_000_000] bits per second
 * @param {'mp4'|'webm'|'auto'} [o.container='auto']
 * @param {string} [o.filename] if set, the file is downloaded
 * @param {(p:{frame:number,total:number,phase:'render'|'encode'|'mux'|'done'})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {(c:{container:'mp4'|'webm',codec:string})=>void} [o.onCodec] called once the codec is chosen
 * @returns {Promise<Blob>} blob.type is 'video/mp4' or 'video/webm'
 */
export async function exportVideo(o) {
  const { width, height, fps, frameCount, renderFrame, onProgress, signal, filename } = o;
  const bitrate = o.bitrate || 16_000_000;
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs (VideoEncoder) is not supported in this browser; use recordCanvas() instead');
  }
  if (!(width > 0 && height > 0 && fps > 0 && frameCount > 0)) throw new Error('exportVideo: width, height, fps and frameCount must be positive');
  if (signal?.aborted) throw abortError();

  const { container, config } = await pickCodec({ width, height, fps, bitrate }, o.container || 'auto');
  o.onCodec?.({ container, codec: config.codec });

  // Lazy-load only the muxer we need.
  const mod = await import(/* @vite-ignore */ MUXER_URLS[container]);
  const target = new mod.ArrayBufferTarget();
  const muxer = container === 'mp4'
    ? new mod.Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' })
    : new mod.Muxer({ target, video: { codec: 'V_VP9', width, height, frameRate: fps } });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const frameDur = 1e6 / fps;             // µs
  const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
  const check = () => {
    if (signal?.aborted) throw abortError();
    if (encodeError) throw encodeError;
  };

  try {
    for (let i = 0; i < frameCount; i++) {
      check();
      onProgress?.({ frame: i, total: frameCount, phase: 'render' });
      const source = await renderFrame(i, i / fps);
      check();
      // Round from the index (not accumulated) so timestamps never drift.
      const timestamp = Math.round(i * frameDur);
      const duration = Math.round((i + 1) * frameDur) - timestamp;
      const frame = new VideoFrame(source, { timestamp, duration });
      try {
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      } finally {
        frame.close();
      }
      onProgress?.({ frame: i + 1, total: frameCount, phase: 'encode' });
      await waitForQueue(encoder, signal);
      if (i % 4 === 3) await yieldToUI();
    }
    check();
    await encoder.flush();
    check();
    encoder.close();

    onProgress?.({ frame: frameCount, total: frameCount, phase: 'mux' });
    await yieldToUI();
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
    if (filename) downloadBlob(blob, filename);
    onProgress?.({ frame: frameCount, total: frameCount, phase: 'done' });
    return blob;
  } catch (e) {
    if (encoder.state !== 'closed') { try { encoder.close(); } catch { /* ignore */ } }
    throw e;
  }
}

// --------------------------------------------------------------------------- real-time fallback

/** Best MediaRecorder mime: MP4/H.264, else WebM VP9, else VP8. */
function pickRecorderMime() {
  const list = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * Record a canvas in real time with MediaRecorder. The caller must keep drawing
 * to the canvas while this runs (frames are captured as they appear).
 *
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {number} [o.fps=30]
 * @param {number} o.durationSec
 * @param {number} [o.bitrate=12_000_000] bits per second
 * @param {string} [o.mimeType] force a mime; default = best supported
 * @param {string} [o.filename] if set, the file is downloaded
 * @param {(p:{frame:number,total:number,phase:string})=>void} [o.onProgress]
 *        frame/total are elapsed/target milliseconds here.
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Blob>}
 */
export function recordCanvas(o) {
  const { canvas, durationSec, onProgress, signal, filename } = o;
  const fps = o.fps || 30;
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === 'undefined' || !canvas?.captureStream) {
      return reject(new Error('MediaRecorder / canvas.captureStream not supported in this browser'));
    }
    if (signal?.aborted) return reject(abortError());

    const mimeType = o.mimeType || pickRecorderMime();
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: o.bitrate || 12_000_000,
    });
    const chunks = [];
    const totalMs = Math.round(durationSec * 1000);
    const t0 = performance.now();
    let aborted = false;
    let stopTimer;
    let tick;

    const cleanup = () => {
      clearTimeout(stopTimer);
      clearInterval(tick);
      signal?.removeEventListener('abort', onAbort);
      stream.getTracks().forEach((t) => t.stop());
    };
    const onAbort = () => {
      aborted = true;
      if (rec.state !== 'inactive') rec.stop();
    };

    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onerror = (e) => { cleanup(); reject(e.error || new Error('MediaRecorder error')); };
    rec.onstop = () => {
      cleanup();
      if (aborted) return reject(abortError());
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' });
      if (filename) downloadBlob(blob, filename);
      onProgress?.({ frame: totalMs, total: totalMs, phase: 'done' });
      resolve(blob);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    rec.start(1000); // timeslice keeps memory chunked for long takes
    stopTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, totalMs);
    tick = setInterval(() => {
      onProgress?.({ frame: Math.min(totalMs, Math.round(performance.now() - t0)), total: totalMs, phase: 'record' });
    }, 250);
  });
}
