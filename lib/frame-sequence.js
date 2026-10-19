// lib/frame-sequence.js
// ---------------------------------------------------------------------------
// Frame-by-frame image sequence export for the sketches in this repo (ES module).
// Sibling of lib/video-export.js: the sketch renders frame i (at t = i / fps, as
// slowly as it likes) and hands back a canvas; this module PNG-encodes it and
// stores `frame_00000.png`, `frame_00001.png`, ... plus an `ffmpeg.txt` with the
// command that turns them into an MP4. Use it when the machine is too slow for
// real-time capture, or when you want lossless frames for an editor.
//
// Two storage paths:
//   1. Folder (Chrome / Edge, File System Access API): pickSequenceDir() asks once
//      for a folder, a sub-folder named after the video file is created in it, and
//      every PNG is streamed straight to disk. Memory stays at about one frame.
//   2. ZIP fallback (Firefox / Safari): the PNGs are collected as Blobs and wrapped
//      in a STORE-ONLY ZIP (no compression; PNG is already deflated) that is
//      downloaded at the end. All frames live in memory, so very long / large
//      sequences can exhaust RAM. No ZIP64: the writer refuses > 4 GiB or > 65535
//      files and warns (onWarn) above 2 GiB; use the folder path for those.
//
// Usage:
//   import { exportFrameSequence, pickSequenceDir, ffmpegCommand } from '../../lib/frame-sequence.js';
//   const dir = await pickSequenceDir();           // call from a click handler; null if unsupported
//   await exportFrameSequence({
//     width: 1080, height: 1350, fps: 30, frameCount: 360,
//     renderFrame: async (i, t) => { renderer.draw({ P, t, w: 1080, h: 1350 }); return renderer.canvas; },
//     name: 'liquid-marble_seed-1234_1080x1350_30fps_12s',   // folder / zip stem
//     dirHandle: dir,                                         // null/undefined -> ZIP download
//     onProgress: ({ frame, total, phase }) => {}, signal: abortController.signal,
//   });
// ---------------------------------------------------------------------------

import { crc32, downloadBlob, yieldToUI } from './poster-export.js';

const ZIP_WARN_BYTES = 2 * 1024 ** 3;
const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024; // keep clear of the 32-bit offset limit
const abortError = () => new DOMException('Export aborted', 'AbortError');

/** The ffmpeg command that assembles `frame_%05d.png` into an H.264 MP4. */
export function ffmpegCommand(fps, out = 'out.mp4') {
  return `ffmpeg -framerate ${fps} -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 16 ${out}`;
}

/** frame_00000.png, zero-padded to 5 digits (more if the sequence needs it). */
export const frameName = (i, prefix = 'frame_') => `${prefix}${String(i).padStart(5, '0')}.png`;

// --------------------------------------------------------------------------- store-only ZIP

/** Little-endian DOS date/time for a JS Date. */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Minimal ZIP writer, method 0 (stored). Entries are added one by one; file data
 * stays as Blob/Uint8Array parts, so nothing is copied until finish().
 */
export class StoreZip {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.encoder = new TextEncoder();
    this.stamp = dosDateTime(new Date());
  }

  /** Total bytes of file data + headers added so far (approximate size of the ZIP). */
  get size() { return this.offset; }

  /**
   * @param {string} name   path inside the zip (UTF-8, forward slashes)
   * @param {Uint8Array|Blob} data
   */
  async add(name, data) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    if (this.entries.length >= 0xffff) throw new Error('ZIP: more than 65535 files needs ZIP64 (use the folder export)');
    const nameBytes = this.encoder.encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;
    const head = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);       // local file header signature
    dv.setUint16(4, 20, true);               // version needed
    dv.setUint16(6, 0x0800, true);           // flags: UTF-8 names
    dv.setUint16(8, 0, true);                // method: stored
    dv.setUint16(10, this.stamp.time, true);
    dv.setUint16(12, this.stamp.date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);            // compressed size
    dv.setUint32(22, size, true);            // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);               // extra length
    head.set(nameBytes, 30);
    if (this.offset + head.length + size > ZIP_MAX_BYTES) throw new Error('ZIP: archive would exceed 4 GiB (no ZIP64); use the folder export');
    this.entries.push({ nameBytes, crc, size, offset: this.offset });
    this.parts.push(head, bytes);
    this.offset += head.length + size;
  }

  /** Append the central directory and end record; returns the ZIP as a Blob. */
  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    const cd = [];
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);     // central directory signature
      dv.setUint16(4, 20, true);             // version made by
      dv.setUint16(6, 20, true);             // version needed
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, this.stamp.time, true);
      dv.setUint16(14, this.stamp.date, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      // 30 extra len, 32 comment len, 34 disk start, 36 internal attrs, 38 external attrs: all 0
      dv.setUint32(42, e.offset, true);      // local header offset
      rec.set(e.nameBytes, 46);
      cd.push(rec);
      cdSize += rec.length;
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);       // end of central directory
    dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, cdSize, true);
    dv.setUint32(16, cdStart, true);
    return new Blob([...this.parts, ...cd, end], { type: 'application/zip' });
  }
}

// --------------------------------------------------------------------------- folder access

/**
 * Ask for an output folder (Chrome / Edge). Returns a FileSystemDirectoryHandle,
 * or null when the API is missing. Rejects with AbortError if the user cancels.
 * Call it directly from a user gesture (before long awaits).
 */
export async function pickSequenceDir() {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return null;
  return window.showDirectoryPicker({ mode: 'readwrite', id: 'frame-sequence' });
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try { await w.write(data); } finally { await w.close(); }
}

function canvasToPNG(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed (toBlob returned null)'))), 'image/png');
  });
}

// --------------------------------------------------------------------------- export

/**
 * Render and store a PNG sequence, offline and frame-exact.
 *
 * @param {object} o
 * @param {number} o.fps
 * @param {number} o.frameCount
 * @param {(index:number, timeSec:number)=>Promise<HTMLCanvasElement|OffscreenCanvas>|HTMLCanvasElement|OffscreenCanvas} o.renderFrame
 *        Must return a canvas currently holding frame `index`. It is PNG-encoded
 *        synchronously after this resolves, so a WebGL canvas needs no preserveDrawingBuffer.
 * @param {string} o.name  folder name / zip stem (e.g. the video file name without extension)
 * @param {FileSystemDirectoryHandle|null} [o.dirHandle] from pickSequenceDir(); null -> ZIP
 * @param {string} [o.ffmpegOut='out.mp4'] output name used in ffmpeg.txt
 * @param {boolean} [o.download=true] ZIP path only: false returns the blob without downloading
 * @param {(p:{frame:number,total:number,phase:'render'|'save'|'zip'|'done',bytes:number})=>void} [o.onProgress]
 * @param {(msg:string)=>void} [o.onWarn]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{mode:'folder'|'zip', frames:number, bytes:number, name:string, blob:Blob|null}>}
 */
export async function exportFrameSequence(o) {
  const { fps, frameCount, renderFrame, name, dirHandle, signal, onProgress, onWarn } = o;
  if (!(fps > 0 && frameCount > 0)) throw new Error('exportFrameSequence: fps and frameCount must be positive');
  if (signal?.aborted) throw abortError();
  const check = () => { if (signal?.aborted) throw abortError(); };
  const ffmpegTxt = new TextEncoder().encode(`${ffmpegCommand(fps, o.ffmpegOut || 'out.mp4')}\n`);

  let dir = null, zip = null, warned = false, bytes = 0;
  if (dirHandle) dir = await dirHandle.getDirectoryHandle(name, { create: true });
  else zip = new StoreZip();
  const mode = dir ? 'folder' : 'zip';

  for (let i = 0; i < frameCount; i++) {
    check();
    onProgress?.({ frame: i, total: frameCount, phase: 'render', bytes });
    const canvas = await renderFrame(i, i / fps);
    check();
    const png = await canvasToPNG(canvas);
    const fname = frameName(i);
    if (dir) await writeFile(dir, fname, png);
    else {
      await zip.add(`${name}/${fname}`, png);
      if (!warned && zip.size > ZIP_WARN_BYTES) {
        warned = true;
        onWarn?.(`ZIP is over 2 GB (${(zip.size / 1e9).toFixed(1)} GB) and held in memory; ZIP fails at 4 GiB. Prefer Chrome/Edge folder export or fewer/smaller frames.`);
      }
    }
    bytes += png.size;
    onProgress?.({ frame: i + 1, total: frameCount, phase: 'save', bytes });
    if (i % 2 === 1) await yieldToUI();
  }
  check();

  let blob = null;
  if (dir) {
    await writeFile(dir, 'ffmpeg.txt', ffmpegTxt);
  } else {
    onProgress?.({ frame: frameCount, total: frameCount, phase: 'zip', bytes });
    await zip.add(`${name}/ffmpeg.txt`, ffmpegTxt);
    blob = zip.finish();
    if (o.download !== false) downloadBlob(blob, `${name}.zip`);
  }
  onProgress?.({ frame: frameCount, total: frameCount, phase: 'done', bytes });
  return { mode, frames: frameCount, bytes, name, blob };
}
