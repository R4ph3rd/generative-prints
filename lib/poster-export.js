// lib/poster-export.js
// ---------------------------------------------------------------------------
// Reusable poster export helpers for the sketches in this repo (ES module).
//
// The core idea: a sketch provides a `renderTile(x, y, w, h)` function that
// renders any rectangle of the final image (in absolute output pixels). This
// module walks the image in tiles, streams the pixels row-band by row-band into
// a PNG encoder (CompressionStream 'deflate'), and downloads the result.
//
// Why tiles + a streaming encoder instead of one giant canvas?
//   - WebGL MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE are often 8192 or 16384,
//     so a 7200 x 10800 poster can't be rendered in a single GL pass.
//   - A 2D canvas of 78 MP costs ~312 MB of RAM plus a slow toBlob() encode;
//     some browsers cap canvas area well below that (Safari ~16.7 MP).
//   - Streaming means peak memory is about one row-band of tiles.
//
// For tiles to join seamlessly the sketch must make every pixel a pure
// function of its ABSOLUTE output coordinate (position-based hashing, no
// per-tile random state).
//
// Usage:
//   import { exportPosterPNG, paperSizePx, posterFilename } from '../../lib/poster-export.js';
//   const { width, height } = paperSizePx('A2', 'portrait', 300);
//   await exportPosterPNG({
//     width, height, dpi: 300,
//     tileSize: 2048,
//     renderTile: async (x, y, w, h) => ({ data: rgbaUint8Array, channels: 4 }),
//     bitDepth: 1,                         // 1 = 1-bit B/W (threshold 128), 8 = grayscale, 24 = RGB
//     text: { Title: 'my sketch', Comment: JSON.stringify(params) },
//     filename: posterFilename({ name: 'my-sketch', seed: 42, paper: 'A2', dpi: 300 }),
//     onProgress: ({ done, total, phase }) => {},
//     signal: abortController.signal,
//   });
//
// Also exported: setPngDpi(blob, dpi) to stamp a pHYs chunk into any PNG blob
// (e.g. one from canvas.toBlob), crc32(), downloadBlob(), getWebGLLimits().
// ---------------------------------------------------------------------------

/** Paper presets in millimetres (portrait: w < h). */
export const PAPER_PRESETS = {
  A4: { w: 210, h: 297, label: 'A4 (210×297 mm)' },
  A3: { w: 297, h: 420, label: 'A3 (297×420 mm)' },
  A2: { w: 420, h: 594, label: 'A2 (420×594 mm)' },
  A1: { w: 594, h: 841, label: 'A1 (594×841 mm)' },
  '18x24in': { w: 457.2, h: 609.6, label: '18×24 in' },
  '24x36in': { w: 609.6, h: 914.4, label: '24×36 in' },
  '50x70cm': { w: 500, h: 700, label: '50×70 cm' },
  '9x16': { w: 300, h: 533.33, label: '9:16 (300×533 mm)' },
  custom: { w: 400, h: 500, label: 'Custom (mm)' },
};

export const mmToPx = (mm, dpi) => Math.round((mm / 25.4) * dpi);
export const pxToMm = (px, dpi) => (px / dpi) * 25.4;

/**
 * Resolve a paper preset to mm and pixel dimensions.
 * @param {string} preset key of PAPER_PRESETS
 * @param {'portrait'|'landscape'} orientation
 * @param {number} dpi
 * @param {{w:number,h:number}} [custom] mm, used when preset === 'custom'
 */
export function paperSizePx(preset, orientation = 'portrait', dpi = 300, custom) {
  const p = preset === 'custom' && custom ? custom : PAPER_PRESETS[preset] || PAPER_PRESETS.A2;
  let wMM = Math.min(p.w, p.h);
  let hMM = Math.max(p.w, p.h);
  if (preset === 'custom' && custom) { wMM = custom.w; hMM = custom.h; }
  if (orientation === 'landscape' && wMM < hMM) [wMM, hMM] = [hMM, wMM];
  if (orientation === 'portrait' && wMM > hMM) [wMM, hMM] = [hMM, wMM];
  return { widthMM: wMM, heightMM: hMM, width: mmToPx(wMM, dpi), height: mmToPx(hMM, dpi), dpi };
}

/** e.g. stipple-shards_seed-1234_A2_300dpi.png */
export function posterFilename({ name, seed, paper, dpi, orientation, ext = 'png' }) {
  const parts = [name, `seed-${seed}`];
  if (paper) parts.push(String(paper).replace(/[^\w.-]+/g, ''));
  if (orientation === 'landscape') parts.push('landscape');
  if (dpi) parts.push(`${dpi}dpi`);
  return `${parts.join('_')}.${ext}`;
}

/** Query GL limits relevant to tiling (WebGL2 if available, else WebGL1). */
export function getWebGLLimits() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return null;
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const out = {
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewport: [vp[0], vp[1]],
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Yield to the event loop so the UI can repaint (setTimeout keeps running in background tabs, unlike rAF). */
export const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// --------------------------------------------------------------------------- PNG plumbing

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (PNG / zlib polynomial). `crc` lets you continue a running CRC. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Build one PNG chunk: length | type | data | crc(type+data). */
export function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function ihdr(width, height, bitDepth, colorType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = bitDepth;
  d[9] = colorType; // 0 = grayscale, 2 = RGB
  d[10] = 0; d[11] = 0; d[12] = 0; // deflate, adaptive filtering, no interlace
  return pngChunk('IHDR', d);
}

/** pHYs chunk: pixels per metre in both axes, unit = metre. */
export function physChunk(dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const d = new Uint8Array(9);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  d[8] = 1;
  return pngChunk('pHYs', d);
}

/** tEXt chunk (keyword + Latin-1 text; non-Latin-1 chars are replaced by '?'). */
export function textChunk(keyword, text) {
  const s = `${keyword}\0${text}`;
  const d = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); d[i] = c < 256 ? c : 63; }
  return pngChunk('tEXt', d);
}

/**
 * Insert (or replace) a pHYs chunk in an existing PNG blob, e.g. from canvas.toBlob().
 * Returns a new Blob. Print software then reads the intended physical size.
 */
export async function setPngDpi(blob, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('Not a PNG');
  const dv = new DataView(bytes.buffer);
  const parts = [PNG_SIG];
  let off = 8;
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (type !== 'pHYs') parts.push(bytes.subarray(off, end));
    if (type === 'IHDR') parts.push(physChunk(dpi));
    off = end;
  }
  return new Blob(parts, { type: 'image/png' });
}

/**
 * Streaming PNG encoder. Write raw (unfiltered) scanlines with writeRows(), then finish().
 * Each scanline you pass must already be packed for the bit depth (no filter byte).
 */
export class PNGStreamEncoder {
  constructor({ width, height, bitDepth = 8, colorType = 0, dpi, text = {} }) {
    if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream not supported in this browser');
    this.width = width;
    this.height = height;
    const channels = colorType === 2 ? 3 : 1;
    this.rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    this.head = [PNG_SIG, ihdr(width, height, bitDepth, colorType)];
    if (dpi) this.head.push(physChunk(dpi));
    for (const [k, v] of Object.entries(text)) this.head.push(textChunk(k, String(v)));
    this.cs = new CompressionStream('deflate'); // zlib wrapper, exactly what IDAT wants
    this.writer = this.cs.writable.getWriter();
    this.compressed = [];
    this.reading = (async () => {
      const reader = this.cs.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.compressed.push(value);
      }
    })();
    this.rowsWritten = 0;
  }

  /** rows: Uint8Array of n * rowBytes packed scanline bytes. */
  async writeRows(rows, n) {
    const rb = this.rowBytes;
    const buf = new Uint8Array(n * (rb + 1));
    for (let r = 0; r < n; r++) {
      buf[r * (rb + 1)] = 0; // filter type: None
      buf.set(rows.subarray(r * rb, (r + 1) * rb), r * (rb + 1) + 1);
    }
    await this.writer.ready;
    await this.writer.write(buf);
    this.rowsWritten += n;
  }

  async finish() {
    if (this.rowsWritten !== this.height) throw new Error(`PNG: wrote ${this.rowsWritten}/${this.height} rows`);
    await this.writer.close();
    await this.reading;
    const parts = [...this.head];
    // Re-chunk the zlib stream into IDATs of <= 4 MB.
    const MAX = 4 << 20;
    let pending = [];
    let pendingLen = 0;
    const flush = () => {
      if (!pendingLen) return;
      const d = new Uint8Array(pendingLen);
      let o = 0;
      for (const p of pending) { d.set(p, o); o += p.length; }
      parts.push(pngChunk('IDAT', d));
      pending = []; pendingLen = 0;
    };
    for (const c of this.compressed) {
      let off = 0;
      while (off < c.length) {
        const take = Math.min(c.length - off, MAX - pendingLen);
        pending.push(c.subarray(off, off + take));
        pendingLen += take; off += take;
        if (pendingLen >= MAX) flush();
      }
    }
    flush();
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    this.compressed = null;
    return new Blob(parts, { type: 'image/png' });
  }

  abort() {
    try { this.writer.abort(); } catch { /* ignore */ }
    this.compressed = null;
  }
}

/**
 * Render an image tile by tile and encode it as a PNG (streamed, no giant canvas).
 *
 * @param {object} o
 * @param {number} o.width   output width in px
 * @param {number} o.height  output height in px
 * @param {number} [o.dpi]   written into the pHYs chunk
 * @param {number} [o.tileSize=2048]
 * @param {(x:number,y:number,w:number,h:number)=>Promise<{data:Uint8Array|Uint8ClampedArray,channels:1|3|4}>} o.renderTile
 *        Must return top-down rows, tightly packed (w*channels bytes per row).
 * @param {1|8|24} [o.bitDepth=8] 1 = 1-bit black/white, 8 = 8-bit gray, 24 = RGB.
 *        For 1 and 8 the first channel (R) is used.
 * @param {Record<string,string>} [o.text] tEXt chunks (e.g. params JSON for reproducibility)
 * @param {string} [o.filename] if set, the PNG is downloaded
 * @param {(p:{done:number,total:number,phase:string})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Blob>}
 */
export async function exportPosterPNG(o) {
  const { width, height, dpi, renderTile, onProgress, signal, filename } = o;
  const tileSize = Math.max(64, Math.floor(o.tileSize || 2048));
  const bitDepth = o.bitDepth || 8;
  const colorType = bitDepth === 24 ? 2 : 0;
  const pngBits = bitDepth === 24 ? 8 : bitDepth;
  const enc = new PNGStreamEncoder({ width, height, bitDepth: pngBits, colorType, dpi, text: o.text });
  const cols = Math.ceil(width / tileSize);
  const rowsOfTiles = Math.ceil(height / tileSize);
  const total = cols * rowsOfTiles;
  let done = 0;
  const rb = enc.rowBytes;
  try {
    for (let ty = 0; ty < rowsOfTiles; ty++) {
      const y = ty * tileSize;
      const bh = Math.min(tileSize, height - y);
      const band = new Uint8Array(rb * bh); // packed scanlines for this band
      for (let tx = 0; tx < cols; tx++) {
        if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
        const x = tx * tileSize;
        const bw = Math.min(tileSize, width - x);
        onProgress?.({ done, total, phase: 'render' });
        const { data, channels } = await renderTile(x, y, bw, bh);
        packTile(band, rb, data, channels, x, bw, bh, bitDepth);
        done++;
        onProgress?.({ done, total, phase: 'render' });
        await yieldToUI();
      }
      await enc.writeRows(band, bh);
    }
    onProgress?.({ done, total, phase: 'encode' });
    await yieldToUI();
    const blob = await enc.finish();
    if (filename) downloadBlob(blob, filename);
    onProgress?.({ done, total, phase: 'done' });
    return blob;
  } catch (e) {
    enc.abort();
    throw e;
  }
}

function packTile(band, rb, data, ch, x0, w, h, bitDepth) {
  if (bitDepth === 1) {
    for (let r = 0; r < h; r++) {
      const rowOff = r * rb;
      let src = r * w * ch;
      for (let i = 0; i < w; i++, src += ch) {
        if (data[src] >= 128) {
          const x = x0 + i;
          band[rowOff + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
  } else if (bitDepth === 8) {
    for (let r = 0; r < h; r++) {
      const rowOff = r * rb + x0;
      let src = r * w * ch;
      for (let i = 0; i < w; i++, src += ch) band[rowOff + i] = data[src];
    }
  } else {
    for (let r = 0; r < h; r++) {
      const rowOff = r * rb + x0 * 3;
      let src = r * w * ch;
      for (let i = 0; i < w; i++, src += ch) {
        band[rowOff + i * 3] = data[src];
        band[rowOff + i * 3 + 1] = data[src + (ch > 1 ? 1 : 0)];
        band[rowOff + i * 3 + 2] = data[src + (ch > 1 ? 2 : 0)];
      }
    }
  }
}

/** Save a JS object as pretty JSON. */
export function downloadJSON(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), filename);
}

/** Open a file picker and resolve with parsed JSON (or null if cancelled). */
export function pickJSONFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); } catch (e) { reject(e); }
    };
    input.click();
  });
}
