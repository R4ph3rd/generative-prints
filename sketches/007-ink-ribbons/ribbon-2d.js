// ribbon-2d.js
// Canvas 2D renderer for 007-ink-ribbons.
//
// A ribbon is a strip of n pen lines around a centre path. The strip twists around
// the path: a line at strip offset s (-1..1) with a cupped cross-section
// d = cup * (1 - s^2) is rotated by the twist angle theta(u) and projected:
//     lateral = s cos(theta) - d sin(theta)        (along the path normal)
//     depth   = s sin(theta) + d cos(theta)        (towards the viewer)
// When cos(theta) passes 0 the lines bunch together: the pinches. Extra shaping:
// fan (lines bunched towards one "core" edge), ruffle (the outer edge frills),
// tilt (lines slide along the path with depth: curled crossings).
//
// Centre paths: analytic (columns / rows / meander) or a "walk" (tangle, frame
// cells): a heading integrated along the path with curl noise and a soft pull back
// to the area centre, interpolated with Catmull-Rom.
//
// Two ways to paint:
//   - lines: every line is a filled polygon (varying width), translucent, blended
//     (multiply / screen) onto the background.
//   - surface (opaque ribbons): the ribbon is cut into chunks along the path, each
//     chunk into runs of lines whose lateral order is monotonic (a fold splits it).
//     Every piece gets a depth (path z noise + twist depth), all pieces are sorted
//     back to front and painted as a paper-coloured fill plus its lines, so ribbons
//     pass over and under each other and folds hide what is behind them.
// Shading: where the strip turns edge-on the lines crowd; "shade" thickens lines
// with the local crowding so folds fill in to dark, like hatching.
//
// Background (paper, coloured backdrop inside the padding, watercolour shapes) and
// the paper texture are cached; only the ink layer is redrawn per frame. The twist
// moves a whole number of turns per loop and noise morphs on a circle in time, so
// the loop is seamless. Sizes are px of a 1080 px wide image, scaled with the output.

import { hash4, noise3, mulberry32, hexToRgb, rgbCss, mixRgb, luminance, WASH_LAYERS } from './scene.js';

const TAU = Math.PI * 2;
const REF = 1080;
const STEP_PX = 3.5;      // path sample spacing in render pixels
const MAX_SAMPLES = 6000;
const CHUNK = 12;         // samples per depth-sorted chunk (surface mode)
const WALK_STEPS = 720;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function makeCanvas(w = 1, h = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Content area (unit coords) inside the padding. */
export function contentArea(P, A) {
  const m = clamp(num(P.borderMargin, 0.06), 0, 0.45);
  return { x0: m, y0: m, x1: 1 - m, y1: A - m };
}

/**
 * Random frame mosaic in an area: recursive splits of the largest cells, gaps,
 * jagged outer edges; very thin cells become small solid squares.
 */
export function frameCells(P, area, seed) {
  const r = mulberry32((seed ^ 0x51ed27) >>> 0);
  const count = Math.max(1, Math.round(num(P.cellCount, 14)));
  const irregular = num(P.cellIrregular, 0.35);
  let rects = [{ ...area }];
  while (rects.length < count) {
    // pick a big cell (area-weighted)
    let tot = 0;
    const wts = rects.map((c) => { const a = Math.pow((c.x1 - c.x0) * (c.y1 - c.y0), 1.4); tot += a; return a; });
    let pickV = r() * tot, idx = 0;
    while (idx < rects.length - 1 && pickV > wts[idx]) { pickV -= wts[idx]; idx++; }
    const c = rects[idx];
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    const vertical = w / h > 1.5 ? true : h / w > 1.5 ? false : r() < 0.5;
    const t = r() < irregular ? (r() < 0.5 ? 0.1 + r() * 0.15 : 0.75 + r() * 0.15) : 0.3 + r() * 0.4;
    rects.splice(idx, 1);
    if (vertical) { const xm = c.x0 + w * t; rects.push({ ...c, x1: xm }, { ...c, x0: xm }); }
    else { const ym = c.y0 + h * t; rects.push({ ...c, y1: ym }, { ...c, y0: ym }); }
  }
  const gap = num(P.cellGap, 0.018), jag = num(P.cellJag, 0.4);
  const eps = 1e-6;
  return rects.map((c, i) => {
    let { x0, y0, x1, y1 } = c;
    const w = x1 - x0, h = y1 - y0;
    // cells on the outer edge get pulled in a little (jagged silhouette)
    if (Math.abs(x0 - area.x0) < eps && r() < jag) x0 += r() * 0.12 * w;
    if (Math.abs(x1 - area.x1) < eps && r() < jag) x1 -= r() * 0.12 * w;
    if (Math.abs(y0 - area.y0) < eps && r() < jag) y0 += r() * 0.12 * h;
    if (Math.abs(y1 - area.y1) < eps && r() < jag) y1 -= r() * 0.12 * h;
    x0 += gap / 2; y0 += gap / 2; x1 -= gap / 2; y1 -= gap / 2;
    const tiny = Math.min(x1 - x0, y1 - y0) < num(P.tinyCell, 0.05);
    if (tiny) {
      // a small solid square in the middle of the sliver
      const s = Math.max(0.006, Math.min(x1 - x0, y1 - y0));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      return { i, x0: cx - s / 2, y0: cy - s / 2, x1: cx + s / 2, y1: cy + s / 2, tiny };
    }
    return { i, x0, y0, x1, y1, tiny };
  }).filter((c) => c.x1 > c.x0 && c.y1 > c.y0);
}

export class RibbonRenderer {
  constructor() {
    this.canvas = makeCanvas(2, 2);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas 2D unavailable');
    this.layer = makeCanvas();
    this.lctx = this.layer.getContext('2d');
    this.bg = { key: '', canvas: null };
    this.tex = { key: '', canvas: null };
    this.scene = null;
    this.stats = { lines: 0, points: 0, pieces: 0 };
  }

  setScene(scene) { this.scene = scene; this.bg.key = ''; }
  maxTile() { return 2048; }
  /** Free the big buffers after an export. */
  trim() {
    this.layer.width = 1; this.layer.height = 1;
    this.bg = { key: '', canvas: null };
    this.tex = { key: '', canvas: null };
  }

  /** Draw a (window of a) full image into this.canvas. */
  draw({ P, t = 0, w, h, fullW = w, fullH = h, x = 0, y = 0, ss = 1 }) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this._render(P, t, w, h, fullW, fullH, x, y, Math.max(1, Math.round(ss || 1)));
  }

  /** Render a window and return its RGBA pixels (top-down rows). */
  renderRegion({ P, t, fullW, fullH, x, y, w, h, ss = 1 }) {
    this.draw({ P, t, w, h, fullW, fullH, x, y, ss });
    return this.ctx.getImageData(0, 0, w, h).data;
  }

  /** Block until the canvas is drawn (for timing). */
  sync() { this.ctx.getImageData(0, 0, 1, 1); }

  // --------------------------------------------------------------------------- frame
  _render(P, t, w, h, fullW, fullH, x, y, ss) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this._background(P, w, h, fullW, fullH, x, y), 0, 0);

    const L = this.layer, lw = w * ss, lh = h * ss;
    if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; }
    const lctx = this.lctx;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, lw, lh);
    this._drawInk(lctx, P, t, fullW, fullH, x, y, ss, lw, lh);

    ctx.globalCompositeOperation = P.surface ? 'source-over' : blendFor(P, 'inkBlend');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L, 0, 0, lw, lh, 0, 0, w, h);

    const tex = num(P.paperTexture, 0);
    if (tex > 0) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.min(1, tex);
      ctx.drawImage(this._texture(P, w, h, fullW, fullH, x, y), 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // --------------------------------------------------------------------------- background
  _background(P, w, h, fullW, fullH, x, y) {
    const keyObj = [w, h, fullW, fullH, x, y, this.scene?.seed, P.ground, P.wash1, P.wash2, P.wash3,
      P.shapes, P.shapeStyle, P.shapeCount, P.shapeSize, P.shapeOpacity, P.shapeDrops, P.shapeRim, P.shapeBlend,
      P.shapeIrregularity, P.composition, P.backdrop, P.backdropColor, P.borderMargin, P.clipToFrame];
    const key = JSON.stringify(keyObj);
    if (this.bg.key === key && this.bg.canvas) return this.bg.canvas;
    const c = this.bg.canvas && this.bg.canvas.width === w && this.bg.canvas.height === h ? this.bg.canvas : makeCanvas(w, h);
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = P.ground;
    g.fillRect(0, 0, w, h);
    const k = fullW, A = fullH / fullW, ar = contentArea(P, A);
    const rx = ar.x0 * k - x, ry = ar.y0 * k - y, rw = (ar.x1 - ar.x0) * k, rh = (ar.y1 - ar.y0) * k;
    const full = P.composition !== 'frames';
    if (full && P.backdrop) { g.fillStyle = P.backdropColor; g.fillRect(rx, ry, rw, rh); }
    if (P.shapes && this.scene) {
      const clip = full && P.clipToFrame && num(P.borderMargin, 0) > 0;
      if (clip) { g.save(); g.beginPath(); g.rect(rx, ry, rw, rh); g.clip(); }
      this._drawShapes(g, P, fullW, fullH, x, y);
      if (clip) g.restore();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    this.bg = { key, canvas: c };
    return c;
  }

  _drawShapes(g, P, fullW, fullH, ox, oy) {
    const k = fullW; // unit -> px
    const A = fullH / fullW;
    const wash = [P.wash1, P.wash2, P.wash3];
    const style = P.shapeStyle;
    const op = Math.min(0.98, Math.max(0, num(P.shapeOpacity, 0.6)));
    const count = Math.min(this.scene.shapes.length, Math.round(num(P.shapeCount, 8)));
    const drops = num(P.shapeDrops, 1);
    g.globalCompositeOperation = blendFor(P, 'shapeBlend');
    const layerAlpha = 1 - Math.pow(1 - op, 1 / WASH_LAYERS) * 1.0;
    let drawn = 0;
    for (const s of this.scene.shapes) {
      if (drawn >= count) break;
      if (s.drop && drops <= 0) continue;
      drawn++;
      const rad = (s.drop ? s.size * drops : s.size) * num(P.shapeSize, 1) * 0.12 * k;
      const cx = s.x * k - ox;
      const cy = (-0.05 + s.y * 1.1) * A * k - oy;
      if (cx + rad * 1.6 < 0 || cy + rad * 1.6 < 0 || cx - rad * 1.6 > g.canvas.width || cy - rad * 1.6 > g.canvas.height) continue;
      const col = wash[s.color] || wash[0];
      const path = (pts) => {
        g.beginPath();
        g.moveTo(cx + pts[0] * rad, cy + pts[1] * rad);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(cx + pts[i] * rad, cy + pts[i + 1] * rad);
        g.closePath();
      };
      if (style === 'flat') {
        g.globalAlpha = op; g.fillStyle = col; path(s.base); g.fill();
      } else if (style === 'outline') {
        g.globalAlpha = op; g.strokeStyle = col; g.lineWidth = Math.max(0.5, 2 * k / REF);
        path(s.base); g.stroke();
      } else {
        // watercolour: stacked translucent deformed layers + a darker rim
        g.fillStyle = col;
        g.globalAlpha = layerAlpha;
        for (const lp of s.layers) { path(lp); g.fill(); }
        const rim = num(P.shapeRim, 0.5);
        if (rim > 0) {
          g.globalAlpha = Math.min(1, op * 0.5 * rim);
          g.strokeStyle = col;
          g.lineWidth = Math.max(0.6, 1.6 * k / REF);
          path(s.layers[0]); g.stroke();
        }
      }
    }
  }

  // --------------------------------------------------------------------------- paper texture
  _texture(P, w, h, fullW, fullH, x, y) {
    const seed = this.scene?.seed ?? 1;
    const key = `${w}|${h}|${fullW}|${fullH}|${x}|${y}|${seed}`;
    if (this.tex.key === key && this.tex.canvas) return this.tex.canvas;
    const c = this.tex.canvas && this.tex.canvas.width === w && this.tex.canvas.height === h ? this.tex.canvas : makeCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    const inv = 1 / fullW;
    const s = (seed ^ 0x5bd1e995) | 0;
    // value noise on an integer lattice, bilinear, frequency in cells per image width
    const vn = (fx, fy, salt) => {
      const xi = Math.floor(fx), yi = Math.floor(fy);
      const tx = fx - xi, ty = fy - yi;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = hash4(s, xi, yi, salt), b = hash4(s, xi + 1, yi, salt);
      const c2 = hash4(s, xi, yi + 1, salt), e = hash4(s, xi + 1, yi + 1, salt);
      const top = a + (b - a) * sx, bot = c2 + (e - c2) * sx;
      return top + (bot - top) * sy - 0.5;
    };
    for (let j = 0; j < h; j++) {
      const uy = (y + j + 0.5) * inv;
      for (let i = 0; i < w; i++) {
        const ux = (x + i + 0.5) * inv;
        const v = 0.30 * vn(ux * 620, uy * 620, 1)
          + 0.16 * vn(ux * 140, uy * 140, 2)
          + 0.12 * vn(ux * 18, uy * 18, 3)
          + 0.10 * vn(ux * 380, uy * 45, 4)
          + 0.08 * vn(ux * 50, uy * 330, 5);
        const g8 = Math.max(0, Math.min(255, 128 + v * 255));
        const o = (j * w + i) * 4;
        d[o] = d[o + 1] = d[o + 2] = g8; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.tex = { key, canvas: c };
    return c;
  }

  // --------------------------------------------------------------------------- ink
  _drawInk(g, P, t, fullW, fullH, ox, oy, ss, cw, ch) {
    const k = fullW * ss;
    const sc = (fullW / REF) * ss;
    const A = fullH / fullW;
    const seed = (this.scene?.seed ?? 1) | 0;
    const loopS = Math.max(1e-3, num(P.loopSeconds, 12));
    const ph = (TAU * t) / loopS;
    const morph = num(P.morph, 0.5);
    const ctxv = {
      P, g, k, sc, A, seed, ph, cw, ch,
      mc: Math.cos(ph) * morph, ms: Math.sin(ph) * morph,
      toX: (u) => u * k - ox * ss, toY: (u) => u * k - oy * ss,
      ink: hexToRgb(P.ink), accent: hexToRgb(P.accent), echo: hexToRgb(P.echo), fill: hexToRgb(P.ground),
    };
    this.stats = { lines: 0, points: 0, pieces: 0 };
    const area = contentArea(P, A);
    const rectPath = (c) => { g.beginPath(); g.rect(ctxv.toX(c.x0), ctxv.toY(c.y0), (c.x1 - c.x0) * k, (c.y1 - c.y0) * k); };
    const bw = Math.max(0.5, num(P.borderWidth, 2) * sc);

    if (P.composition === 'frames') {
      const cells = frameCells(P, area, seed);
      for (const c of cells) {
        const x0 = ctxv.toX(c.x0), y0 = ctxv.toY(c.y0), x1 = ctxv.toX(c.x1), y1 = ctxv.toY(c.y1);
        if (x1 < 0 || y1 < 0 || x0 > cw || y0 > ch) continue;
        g.globalAlpha = 1;
        if (c.tiny) { g.fillStyle = P.ink; rectPath(c); g.fill(); continue; }
        g.save(); rectPath(c); g.clip();
        const ribs = [];
        const nr = Math.max(1, Math.round(num(P.cellRibbons, 2)));
        for (let r = 0; r < nr; r++) ribs.push(this._ribbon(ctxv, { kind: 'cell', r, salt: 5000 + c.i * 16 + r, area: c }));
        this._paint(ctxv, ribs);
        g.restore();
        if (P.border) { g.globalAlpha = 1; g.strokeStyle = P.frameColor; g.lineWidth = bw; rectPath(c); g.stroke(); }
      }
      return;
    }

    const clip = P.clipToFrame && num(P.borderMargin, 0) > 0;
    if (clip) { g.save(); rectPath(area); g.clip(); }
    const n = Math.max(1, Math.round(num(P.ribbonCount, 4)));
    const ribs = [];
    for (let r = 0; r < n; r++) ribs.push(this._ribbon(ctxv, { kind: P.layout, r, n, salt: r, area }));
    this._paint(ctxv, ribs);
    if (clip) g.restore();
    if (P.border) { g.globalAlpha = 1; g.strokeStyle = P.frameColor; g.lineWidth = bw; rectPath(area); g.stroke(); }
  }

  _paint(cx, ribs) {
    const { P, g } = cx;
    const live = ribs.filter((rb) => rb && rb.visible);
    if (num(P.echoCount, 0) > 0) for (const rb of live) this._drawEcho(cx, rb);
    if (P.surface) this._paintSurface(cx, live);
    else for (const rb of live) this._paintLines(cx, rb);
    if (P.axisLine) for (const rb of live) this._drawAxis(cx, rb);
    g.globalAlpha = 1;
  }

  // --------------------------------------------------------------------------- geometry
  /** Unit-space centre path of a walk (tangle / cell): returns pathAt(u). */
  _walk(cx, salt, area, o) {
    const { seed, mc, ms } = cx;
    const R = (j) => hash4(seed, salt, j, 23);
    const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
    const ccx = (area.x0 + area.x1) / 2, ccy = (area.y0 + area.y1) / 2;
    const D = Math.hypot(aw, ah);
    const a = o.startAngle ?? R(1) * TAU;
    let x = ccx - Math.cos(a) * D * 0.55, y = ccy - Math.sin(a) * D * 0.55;
    const tx = ccx + (R(2) - 0.5) * aw * o.spreadTarget, ty = ccy + (R(3) - 0.5) * ah * o.spreadTarget;
    let h = Math.atan2(ty - y, tx - x);
    const M = WALK_STEPS, Lp = o.length * D, ds = Lp / M;
    const pts = new Float32Array((M + 1) * 2);
    const nseed = seed + salt * 13 + 5;
    for (let i = 0; i <= M; i++) {
      pts[2 * i] = x; pts[2 * i + 1] = y;
      const u = i / M;
      h += (ds / D) * o.curl * 14 * noise3(nseed, u * o.curlFreq * o.length, mc, ms);
      // soft pull back towards the centre when the walk drifts out
      const dx = ccx - x, dy = ccy - y;
      const e = Math.max(Math.abs(dx) / (aw / 2), Math.abs(dy) / (ah / 2));
      const f = smooth(0.6, 1.15, e) * o.steer;
      if (f > 0 && u > 0.08 && u < 0.92) {
        let diff = Math.atan2(dy, dx) - h;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        h += diff * f * (ds / D) * 12;
      }
      x += Math.cos(h) * ds; y += Math.sin(h) * ds;
    }
    return (u) => {
      const f = clamp(u, 0, 1) * M, i = Math.min(M - 1, Math.floor(f)), t = f - i;
      const i0 = Math.max(0, i - 1), i2 = i + 1, i3 = Math.min(M, i + 2);
      const t2 = t * t, t3 = t2 * t;
      const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      return [cr(pts[2 * i0], pts[2 * i], pts[2 * i2], pts[2 * i3]), cr(pts[2 * i0 + 1], pts[2 * i + 1], pts[2 * i2 + 1], pts[2 * i3 + 1])];
    };
  }

  /** Centre path, frame, twist and all line points of one ribbon. */
  _ribbon(cx, spec) {
    const { P, k, sc, seed, mc, ms, ph, toX, toY, cw, ch } = cx;
    const { kind, r, salt, area } = spec;
    const n = spec.n || 1;
    const R = (j) => hash4(seed, salt, j, 7);
    const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
    const clipped = (P.clipToFrame && num(P.borderMargin, 0) > 0) || kind === 'cell';
    const ext = (clipped ? 0.02 : 0.08) + 0.12 * num(P.tilt, 0.3) * num(P.ribbonWidth, 0.6);
    const sway = num(P.sway, 0.3), swayFreq = num(P.swayFreq, 1.5);
    const nz = (j, u, f) => noise3(seed + 101 * salt + 17 * j, u * f, mc, ms);
    let hw, pathAt, lines = Math.max(2, Math.round(num(P.lines, 30)));
    if (kind === 'cell') {
      const big = Math.max(aw, ah);
      hw = 0.5 * num(P.cellFill, 1.1) * big * (0.8 + 0.4 * R(11));
      const axis = (R(12) < 0.5 ? 0 : Math.PI / 2) + (R(13) - 0.5) * 0.8 + (R(14) < 0.5 ? Math.PI : 0);
      pathAt = this._walk(cx, salt, area, { length: 1.25, curl: num(P.cellCurl, 0.6), curlFreq: 1.5, steer: 0.6, spreadTarget: 0.6, startAngle: axis });
      lines = clamp(Math.round((2 * hw * REF) / Math.max(1, num(P.cellSpacing, 7))), 4, 220);
    } else if (kind === 'tangle') {
      hw = num(P.ribbonWidth, 0.6) * 0.12 * aw * (0.7 + 0.6 * R(11));
      pathAt = this._walk(cx, salt, area, {
        length: num(P.pathLength, 1.6) * (0.75 + 0.5 * R(12)), curl: num(P.curl, 0.8), curlFreq: num(P.curlFreq, 1.2),
        steer: 1, spreadTarget: 0.7,
      });
    } else if (kind === 'meander') {
      hw = num(P.ribbonWidth, 0.6) * aw * 0.5 / (n + 1);
      const amp = num(P.meander, 0.6) * Math.max(0, aw * 0.5 - hw * 0.4) * (n > 1 ? 0.6 : 1);
      const turns = num(P.turns, 1.6) * (1 + (R(2) - 0.5) * 0.3);
      const phi = R(3) * TAU;
      const mx = area.x0 + aw * (n === 1 ? 0.5 : 0.2 + 0.6 * (r / (n - 1)));
      const y0 = area.y0 - ext, y1 = area.y1 + ext;
      pathAt = (u) => [mx + amp * Math.sin(TAU * turns * u + phi) + sway * aw * 0.12 * nz(1, u, swayFreq),
        y0 + u * (y1 - y0) + sway * 0.04 * nz(2, u, swayFreq)];
    } else if (kind === 'rows') {
      const pad = num(P.margin, 0.05) * ah;
      const rowH = (ah - 2 * pad) / n;
      const yc = area.y0 + pad + (r + 0.5) * rowH + (R(1) - 0.5) * rowH * 0.2;
      hw = 0.5 * rowH * num(P.ribbonWidth, 0.6);
      const x0 = area.x0 - ext, x1 = area.x1 + ext;
      pathAt = (u) => [x0 + u * (x1 - x0), yc + sway * rowH * 0.5 * nz(1, u, swayFreq)];
    } else { // columns
      const pad = num(P.margin, 0.05) * aw;
      const colW = (aw - 2 * pad) / n;
      const xc = area.x0 + pad + (r + 0.5) * colW + (R(1) - 0.5) * colW * 0.2;
      hw = 0.5 * colW * num(P.ribbonWidth, 0.6);
      const y0 = area.y0 - ext, y1 = area.y1 + ext;
      pathAt = (u) => [xc + sway * colW * 0.5 * nz(1, u, swayFreq), y0 + u * (y1 - y0)];
    }

    // path length -> sample count
    let len = 0, [px, py] = pathAt(0);
    for (let i = 1; i <= 96; i++) { const [qx, qy] = pathAt(i / 96); len += Math.hypot(qx - px, qy - py); px = qx; py = qy; }
    const N = Math.max(64, Math.min(MAX_SAMPLES, Math.ceil((len * k) / STEP_PX)));
    const lenScale = Math.max(0.3, len / Math.max(aw, ah)); // per area height, not per path length

    const X = new Float32Array(N), Y = new Float32Array(N), NX = new Float32Array(N), NY = new Float32Array(N);
    const TX = new Float32Array(N), TY = new Float32Array(N), W = new Float32Array(N);
    const CT = new Float32Array(N), ST = new Float32Array(N), CUP = new Float32Array(N);
    const RA = new Float32Array(N), RB = new Float32Array(N), Z = new Float32Array(N);
    const pinchMul = kind === 'cell' ? num(P.cellPinches, 1.5) / Math.max(0.01, num(P.pinches, 5)) : 1;
    const pinches = num(P.pinches, 6) * pinchMul * (1 + (R(4) - 0.5) * num(P.pinchJitter, 0.3));
    const phi0 = R(5) * TAU;
    const flow = Math.round(num(P.flow, 1)) * (R(6) < 0.5 && P.flowAlternate ? -1 : 1);
    const twistNoise = num(P.twistNoise, 0.5), widthVar = num(P.widthVar, 0.35), widthFreq = num(P.widthFreq, 2);
    const cup = num(P.cup, 0.25), cupVar = num(P.cupVar, 0.6);
    const ruffle = num(P.ruffle, 0), ruffleFreq = num(P.ruffleFreq, 8);
    const zBase = R(8) * 2, zAmp = num(P.weave, 1);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const [ux, uy] = pathAt(u);
      X[i] = toX(ux); Y[i] = toY(uy);
      W[i] = hw * Math.max(0.08, 1 + widthVar * nz(3, u, widthFreq * lenScale)) * k;
      const th = Math.PI * pinches * lenScale * u + phi0 + twistNoise * Math.PI * 0.5 * nz(4, u, 2.2 * lenScale) - flow * ph;
      CT[i] = Math.cos(th); ST[i] = Math.sin(th);
      CUP[i] = cup * (1 + cupVar * 1.5 * nz(5, u, 1.7 * lenScale));
      if (ruffle > 0) { RA[i] = nz(6, u, ruffleFreq * lenScale); RB[i] = nz(7, u, ruffleFreq * lenScale * 1.3); }
      Z[i] = zBase + zAmp * 1.5 * nz(8, u, 1.6 * lenScale);
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, maxW = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      let tx = X[b] - X[a], ty = Y[b] - Y[a];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      TX[i] = tx; TY[i] = ty; NX[i] = -ty; NY[i] = tx;
      if (X[i] < bx0) bx0 = X[i]; if (X[i] > bx1) bx1 = X[i];
      if (Y[i] < by0) by0 = Y[i]; if (Y[i] > by1) by1 = Y[i];
      if (W[i] > maxW) maxW = W[i];
    }
    const pad = maxW * (1.6 + ruffle) + 40 * sc;
    const visible = !(bx1 + pad < 0 || by1 + pad < 0 || bx0 - pad > cw || by0 - pad > ch);
    const rib = { salt, r, N, X, Y, NX, NY, TX, TY, W, CT, ST, CUP, RA, RB, Z, visible, n: lines };
    if (visible) this._buildLines(cx, rib);
    return rib;
  }

  /** Line positions, half widths, depth, colours, dashes and accents of a ribbon. */
  _buildLines(cx, rib) {
    const { P, sc, seed } = cx;
    const { N, n, X, Y, NX, NY, TX, TY, W, CT, ST, CUP, RA, RB, salt, r } = rib;
    const spread = num(P.spread, 1), jitter = num(P.lineJitter, 0.2), fan = num(P.fan, 1);
    const tilt = num(P.tilt, 0.3), depthWidth = num(P.depthWidth, 0.4);
    const lw = num(P.lineWidth, 1.2) * sc, lwVar = num(P.lineWidthVar, 0.4), edge = num(P.edgeWeight, 1.8);
    const core = num(P.coreWeight, 1), pressure = num(P.pressure, 0.3), shade = num(P.shade, 0);
    const ruffle = num(P.ruffle, 0);
    const S = new Float32Array(n), LW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lr = (j) => hash4(seed, salt * 4096 + i, j, 11);
      let tt = i / (n - 1);
      tt = Math.pow(tt, fan);
      let s = -1 + 2 * tt;
      s = Math.sign(s) * Math.pow(Math.abs(s), spread);
      if (i > 0 && i < n - 1) s += jitter * (lr(1) - 0.5) * (2 / (n - 1)) * (fan > 1 ? tt * 1.5 : 1);
      S[i] = s;
      let w = lw * Math.max(0.15, 1 + lwVar * (lr(2) * 2 - 1));
      if (i === 0 || i === n - 1) w *= edge;
      if (i === 0) w *= core;
      LW[i] = w;
    }
    const LX = new Float32Array(n * N), LY = new Float32Array(n * N), HW = new Float32Array(n * N), DEP = new Float32Array(n * N);
    // opaque ribbons: the along-path slide (tilt) must never run backwards, or the
    // surface folds over itself along the path and the depth sort chops the lines
    const noFold = !!P.surface;
    for (let i = 0; i < n; i++) {
      const s = S[i], d0 = 1 - s * s, q = (s + 1) / 2, rq = ruffle * Math.pow(q, 1.5);
      const o = i * N;
      let prevA = -Infinity, arc = 0;
      for (let j = 0; j < N; j++) {
        const d = CUP[j] * d0;
        const lat = s * CT[j] - d * ST[j] + (rq ? rq * (RA[j] * (1 - q) + RB[j] * q) : 0);
        const dep = s * ST[j] + d * CT[j];
        const w = W[j];
        let along = w * tilt * dep;
        if (noFold) {
          const step = j ? Math.hypot(X[j] - X[j - 1], Y[j] - Y[j - 1]) : 0;
          arc += step;
          if (arc + along < prevA + step * 0.35) along = prevA + step * 0.35 - arc;
          prevA = arc + along;
        }
        LX[o + j] = X[j] + NX[j] * w * lat + TX[j] * along;
        LY[o + j] = Y[j] + NY[j] * w * lat + TY[j] * along;
        DEP[o + j] = dep;
      }
    }
    // half widths: pen pressure, depth, and crowding shade
    for (let i = 0; i < n; i++) {
      const lr = (j) => hash4(seed, salt * 4096 + i, j, 11);
      const f1 = 3 + lr(3) * 6, f2 = 9 + lr(4) * 14, p1 = lr(5) * TAU, p2 = lr(6) * TAU;
      const ia = Math.max(0, i - 1), ib = Math.min(n - 1, i + 1);
      const ds = Math.max(1e-4, S[ib] - S[ia]);
      const o = i * N, oa = ia * N, ob = ib * N;
      for (let j = 0; j < N; j++) {
        const u = j / (N - 1);
        const pr = 1 + pressure * 0.5 * (Math.sin(TAU * f1 * u + p1) + 0.6 * Math.sin(TAU * f2 * u + p2));
        let m = Math.max(0.2, pr) * Math.max(0.3, 1 + depthWidth * DEP[o + j] * 0.6);
        if (shade > 0) {
          const c = Math.hypot(LX[ob + j] - LX[oa + j], LY[ob + j] - LY[oa + j]) / (W[j] * ds + 1e-6);
          const e = 1 - Math.min(1, c);
          m *= 1 + shade * 2.2 * e * e;
        }
        HW[o + j] = 0.5 * LW[i] * m;
      }
    }
    // colours
    const ink = cx.ink, accent = cx.accent, echo = cx.echo;
    let base = ink;
    if (P.lineColorMode === 'ribbons') base = [ink, accent, echo][r % 3];
    const surface = !!P.surface;
    const op = clamp(num(P.lineOpacity, 0.9), 0, 1);
    const toCss = (c) => rgbCss(surface ? mixRgb(cx.fill, c, op) : c); // surface: premixed, drawn opaque
    const COL = new Array(n);
    for (let i = 0; i < n; i++) {
      let c = base;
      if (P.lineColorMode === 'gradient') c = mixRgb(ink, accent, Math.round((i / (n - 1)) * 6) / 6);
      COL[i] = toCss(c);
    }
    const accentCss = toCss(accent);
    // dashes: per-line on/off masks by arc length
    let MASK = null;
    if (hash4(seed, salt, 9, 7) < num(P.dashMix, 0)) {
      MASK = new Uint8Array(n * N);
      const dashOn = num(P.dashLength, 10) * sc, dashOff = num(P.dashGap, 6) * sc;
      for (let i = 0; i < n; i++) {
        const o = i * N;
        let acc = -hash4(seed, salt * 4096 + i, 7, 11) * (dashOn + dashOff), on = false;
        let segOn = dashOn * (0.6 + 0.8 * hash4(seed, salt * 4096 + i, 8, 11));
        for (let j = 1; j < N; j++) {
          acc += Math.hypot(LX[o + j] - LX[o + j - 1], LY[o + j] - LY[o + j - 1]);
          if (!on && acc >= 0) { on = true; acc = 0; }
          else if (on && acc >= segOn) {
            on = false; acc = -dashOff * (0.6 + 0.8 * hash4(seed, i, j, 13));
            segOn = dashOn * (0.6 + 0.8 * hash4(seed, i, j, 17));
          }
          if (on) { MASK[o + j] = 1; MASK[o + j - 1] = 1; }
        }
      }
    }
    // accents: one partial over-stroke range per chosen line
    const ACC = new Int32Array(n * 2).fill(-1);
    const accentRatio = num(P.accentRatio, 0), accentLen = num(P.accentLength, 0.35);
    for (let i = 0; i < n; i++) {
      const lr = (j) => hash4(seed, salt * 4096 + i, j, 11);
      if (lr(9) >= accentRatio) continue;
      const a0 = lr(10) * (1 - accentLen * 0.5) - accentLen * 0.25;
      const j0 = Math.max(0, Math.floor(a0 * (N - 1))), j1 = Math.min(N - 1, Math.floor((a0 + accentLen) * (N - 1)));
      if (j1 > j0 + 1) { ACC[2 * i] = j0; ACC[2 * i + 1] = j1; }
    }
    Object.assign(rib, { S, LX, LY, HW, DEP, COL, accentCss, MASK, ACC });
    this.stats.lines += n; this.stats.points += n * N;
  }

  // --------------------------------------------------------------------------- painting
  /** Append line i over samples a..b (respecting dashes) to the current path. */
  _lineRange(g, rib, i, a, b, scale = 1, taper = false) {
    const { N, LX, LY, HW, MASK } = rib;
    const o = i * N;
    const xs = LX.subarray(o, o + N), ys = LY.subarray(o, o + N);
    let hws = HW.subarray(o, o + N);
    if (scale !== 1) hws = hws.map((v) => v * scale);
    if (!MASK) { strokeRange(g, xs, ys, hws, a, b, taper); return; }
    let j = a;
    while (j <= b) {
      while (j <= b && !MASK[o + j]) j++;
      const s = j;
      while (j <= b && MASK[o + j]) j++;
      if (j - 1 > s) strokeRange(g, xs, ys, hws, s, j - 1, taper);
    }
  }

  /** Translucent lines (no occlusion). */
  _paintLines(cx, rib) {
    const { P, g } = cx;
    const { n, N, COL, ACC, accentCss } = rib;
    g.globalAlpha = clamp(num(P.lineOpacity, 0.9), 0, 1);
    for (let i = 0; i < n; i++) {
      g.fillStyle = COL[i];
      g.beginPath(); this._lineRange(g, rib, i, 0, N - 1); g.fill();
      if (ACC[2 * i] >= 0) {
        g.fillStyle = accentCss;
        g.beginPath(); this._lineRange(g, rib, i, ACC[2 * i], ACC[2 * i + 1], 1.15, true); g.fill();
      }
    }
  }

  /** Opaque ribbons: depth-sorted chunk pieces, each a paper fill plus its lines. */
  _paintSurface(cx, ribs) {
    const { P, g, cw, ch } = cx;
    const pieces = [];
    for (const rib of ribs) {
      const { N, n, X, Y, NX, NY, LX, LY, DEP, Z, W } = rib;
      const lat = new Float32Array(n);
      // runs of lines whose lateral order is monotonic at sample jm (a fold flips it)
      const runsAt = (jm) => {
        for (let i = 0; i < n; i++) lat[i] = (LX[i * N + jm] - X[jm]) * NX[jm] + (LY[i * N + jm] - Y[jm]) * NY[jm];
        const eps = W[jm] * 0.004, runs = [];
        let a = 0, dir = 0;
        for (let i = 1; i < n; i++) {
          const d = lat[i] - lat[i - 1];
          const sdir = d > eps ? 1 : d < -eps ? -1 : 0;
          if (sdir === 0) continue;
          if (dir === 0) dir = sdir;
          else if (sdir !== dir) { runs.push([a, i - 1]); a = i - 1; dir = sdir; }
        }
        runs.push([a, n - 1]);
        return runs;
      };
      const addPieces = (j0, j1, jm, runs) => {
        for (const [a, b] of runs) {
          let dsum = 0;
          for (let i = a; i <= b; i++) dsum += DEP[i * N + jm];
          pieces.push({ rib, a, b, j0: Math.max(0, j0 - 1), j1, z: Z[jm] + 0.12 * (dsum / (b - a + 1)) });
        }
      };
      for (let j0 = 0; j0 < N - 1; j0 += CHUNK) {
        const j1 = Math.min(N - 1, j0 + CHUNK);
        const jm = (j0 + j1) >> 1;
        const reach = W[jm] * 2.5 + CHUNK * STEP_PX * 2;
        if (X[jm] < -reach || Y[jm] < -reach || X[jm] > cw + reach || Y[jm] > ch + reach) continue;
        const runs = runsAt(jm);
        const folded = runs.length > 1 || runsAt(j0).length > 1 || runsAt(j1).length > 1;
        if (!folded) { addPieces(j0, j1, jm, runs); continue; }
        // a fold moves fast along the path: cut this chunk into 2-sample slices
        for (let k0 = j0; k0 < j1; k0 += 2) {
          const k1 = Math.min(j1, k0 + 2), km = (k0 + k1) >> 1;
          addPieces(k0, k1, km, runsAt(km));
        }
      }
    }
    pieces.sort((p, q) => p.z - q.z);
    const fillCss = rgbCss(cx.fill);
    const fillOp = clamp(num(P.fillOpacity, 1), 0, 1);
    for (const p of pieces) {
      const { rib, a, b, j0, j1 } = p;
      const { N, LX, LY, HW, COL, ACC, accentCss } = rib;
      if (b > a && fillOp > 0) {
        g.globalAlpha = fillOp;
        g.fillStyle = fillCss;
        g.beginPath();
        const oa = a * N, ob = b * N;
        // fill out to the outer edge of the boundary lines
        const ea = edgeOffset(LX, LY, HW, oa, ob, j0, j1, N);
        // close along the real cross-sections at j1 and j0 (tilt bows them along the path)
        const m = j1 - j0 + 1;
        g.moveTo(ea.x[0], ea.y[0]);
        for (let q = 1; q < m; q++) g.lineTo(ea.x[q], ea.y[q]);
        for (let i = a + 1; i < b; i++) g.lineTo(LX[i * N + j1], LY[i * N + j1]);
        for (let q = m; q < 2 * m; q++) g.lineTo(ea.x[q], ea.y[q]);
        for (let i = b - 1; i > a; i--) g.lineTo(LX[i * N + j0], LY[i * N + j0]);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
      // lines grouped by colour
      let cur = null;
      for (let i = a; i <= b; i++) {
        if (COL[i] !== cur) {
          if (cur) g.fill();
          cur = COL[i]; g.fillStyle = cur; g.beginPath();
        }
        this._lineRange(g, rib, i, j0, j1);
      }
      if (cur) g.fill();
      let acc = false;
      for (let i = a; i <= b; i++) {
        const s0 = Math.max(j0, ACC[2 * i]), s1 = Math.min(j1, ACC[2 * i + 1]);
        if (ACC[2 * i] < 0 || s1 <= s0) continue;
        if (!acc) { acc = true; g.fillStyle = accentCss; g.beginPath(); }
        this._lineRange(g, rib, i, s0, s1, 1.15, false);
      }
      if (acc) g.fill();
    }
    this.stats.pieces += pieces.length;
  }

  /** Loose offset outlines that follow the ribbon silhouette. */
  _drawEcho(cx, rib) {
    const { P, g, sc, seed, mc, ms } = cx;
    const { N, n, X, Y, NX, NY, W, LX, LY, salt } = rib;
    const count = Math.round(num(P.echoCount, 1));
    const gap = num(P.echoGap, 0.35), wob = num(P.echoWobble, 0.4);
    const ew = num(P.echoWidth, 0.8) * sc;
    const xs = new Float32Array(N), ys = new Float32Array(N), hws = new Float32Array(N).fill(ew * 0.5);
    g.globalAlpha = Math.min(1, num(P.echoOpacity, 0.8));
    g.fillStyle = rgbCss(cx.echo);
    const lo = new Float32Array(N), hi = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const l = (LX[i * N + j] - X[j]) * NX[j] + (LY[i * N + j] - Y[j]) * NY[j];
        if (l < mn) mn = l; if (l > mx) mx = l;
      }
      lo[j] = mn; hi[j] = mx;
    }
    for (let e = 1; e <= count; e++) {
      for (const side of [-1, 1]) {
        const ss = salt * 64 + e * 2 + (side > 0 ? 1 : 0);
        g.beginPath();
        for (let j = 0; j < N; j++) {
          const u = j / (N - 1);
          const wobble = 1 + wob * noise3(seed + 999 + ss, u * 7, mc, ms);
          const off = (side > 0 ? hi[j] : lo[j]) + side * W[j] * gap * e * Math.max(0.1, wobble);
          xs[j] = X[j] + NX[j] * off; ys[j] = Y[j] + NY[j] * off;
        }
        strokeRange(g, xs, ys, hws, 0, N - 1);
        g.fill();
      }
    }
  }

  _drawAxis(cx, rib) {
    const { P, g, sc } = cx;
    const { N, X, Y, COL } = rib;
    g.globalAlpha = Math.min(1, num(P.lineOpacity, 0.9));
    g.strokeStyle = COL[0];
    g.lineWidth = Math.max(0.3, num(P.lineWidth, 1.2) * sc);
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(X[0], Y[0]);
    for (let j = 1; j < N; j++) g.lineTo(X[j], Y[j]);
    g.stroke();
  }
}

/** Polygon of the strip between line rows oa and ob over samples j0..j1, pushed out by the line half widths. */
function edgeOffset(LX, LY, HW, oa, ob, j0, j1) {
  const xs = [], ys = [];
  const side = (o, sign, j) => {
    // outward = away from the other boundary line
    const oo = o === oa ? ob : oa;
    let dx = LX[o + j] - LX[oo + j], dy = LY[o + j] - LY[oo + j];
    const l = Math.hypot(dx, dy) || 1;
    const h = HW[o + j] * 0.9;
    return [LX[o + j] + (dx / l) * h, LY[o + j] + (dy / l) * h];
  };
  for (let j = j0; j <= j1; j++) { const [x, y] = side(oa, 1, j); xs.push(x); ys.push(y); }
  for (let j = j1; j >= j0; j--) { const [x, y] = side(ob, -1, j); xs.push(x); ys.push(y); }
  return { x: xs, y: ys };
}

/** Append a filled-stroke polygon for samples a..b (variable half width hws) to the current path. */
const _ox = [], _oy = [];
function strokeRange(g, xs, ys, hws, a, b, taper = false) {
  if (b <= a) return;
  const span = Math.max(1, (b - a) * 0.15);
  for (let j = a; j <= b; j++) {
    const p = j > a ? j - 1 : a, q = j < b ? j + 1 : b;
    const dx = xs[q] - xs[p], dy = ys[q] - ys[p];
    let h = hws[j];
    if (taper) h *= Math.min(1, Math.min(j - a, b - j) / span);
    const l = h / (Math.hypot(dx, dy) || 1);
    _ox[j - a] = -dy * l; _oy[j - a] = dx * l;
  }
  g.moveTo(xs[a] + _ox[0], ys[a] + _oy[0]);
  for (let j = a + 1; j <= b; j++) g.lineTo(xs[j] + _ox[j - a], ys[j] + _oy[j - a]);
  for (let j = b; j >= a; j--) g.lineTo(xs[j] - _ox[j - a], ys[j] - _oy[j - a]);
  g.closePath();
}

function blendFor(P, key) {
  const m = P[key];
  if (m === 'normal') return 'source-over';
  if (m === 'multiply' || m === 'screen') return m;
  return luminance(P.ground) > 0.45 ? 'multiply' : 'screen'; // auto
}
