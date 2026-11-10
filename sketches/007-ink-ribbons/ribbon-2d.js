// ribbon-2d.js
// Canvas 2D renderer for 007-ink-ribbons.
//
// A ribbon is a strip of N parallel pen lines around a centre path. The strip twists
// around the path: a line at strip offset s (-1..1) with a cupped cross-section
// d = cup * (1 - s^2) is rotated by the twist angle theta(u) and projected:
//     lateral = s cos(theta) - d sin(theta)        (along the path normal)
//     depth   = s sin(theta) + d cos(theta)        (towards the viewer)
// When cos(theta) passes 0 the lines bunch together: the pinches. The twist flows
// along the path with time (an integer number of turns per loop, so the loop is
// seamless); slow noise "morph" is sampled on a circle in time for the same reason.
//
// Every line is filled as a polygon (offset left / right by a varying half width),
// so pen pressure and depth can thicken it. Lines are drawn into a transparent
// layer at ss x resolution, scaled down onto the background (ground + watercolour
// shapes, cached) with a multiply / screen blend, and a cached paper texture is
// laid over everything with soft-light.
//
// Sizes are given in px of a 1080 px wide image and scale with the output width,
// so a 4320 px export looks like the 1080 px preview, only sharper.

import { hash4, noise3, hexToRgb, rgbCss, mixRgb, luminance, WASH_LAYERS } from './scene.js';

const TAU = Math.PI * 2;
const REF = 1080;
const STEP_PX = 2.5; // path sample spacing in render pixels
const MAX_SAMPLES = 6000;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function makeCanvas(w = 1, h = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
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
    this.stats = { lines: 0, points: 0 };
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

    // lines layer at ss x
    const L = this.layer, lw = w * ss, lh = h * ss;
    if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; }
    const lctx = this.lctx;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, lw, lh);
    this._drawInk(lctx, P, t, fullW, fullH, x, y, ss, lw, lh);

    ctx.globalCompositeOperation = blendFor(P, 'inkBlend');
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
      P.shapeIrregularity];
    const key = JSON.stringify(keyObj);
    if (this.bg.key === key && this.bg.canvas) return this.bg.canvas;
    const c = this.bg.canvas && this.bg.canvas.width === w && this.bg.canvas.height === h ? this.bg.canvas : makeCanvas(w, h);
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = P.ground;
    g.fillRect(0, 0, w, h);
    if (P.shapes && this.scene) this._drawShapes(g, P, fullW, fullH, x, y);
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
    const k = fullW * ss;               // unit -> layer px
    const sc = (fullW / REF) * ss;      // REF px -> layer px
    const A = fullH / fullW;
    const seed = (this.scene?.seed ?? 1) | 0;
    const loopS = Math.max(1e-3, num(P.loopSeconds, 12));
    const ph = (TAU * t) / loopS;
    const morph = num(P.morph, 0.5);
    const mc = Math.cos(ph) * morph, ms = Math.sin(ph) * morph;
    const toX = (u) => u * k - ox * ss, toY = (u) => u * k - oy * ss;

    // content area (unit coords)
    const bm = P.border ? num(P.borderMargin, 0.06) : 0;
    const area = { x0: bm, y0: bm, x1: 1 - bm, y1: A - bm };
    const clip = P.border && P.clipToFrame;
    if (clip) {
      g.save();
      g.beginPath();
      g.rect(toX(area.x0), toY(area.y0), (area.x1 - area.x0) * k, (area.y1 - area.y0) * k);
      g.clip();
    }

    const ink = hexToRgb(P.ink), accent = hexToRgb(P.accent), echo = hexToRgb(P.echo);
    const n = Math.max(1, Math.round(num(P.ribbonCount, 4)));
    this.stats = { lines: 0, points: 0 };
    for (let r = 0; r < n; r++) {
      const rib = this._ribbon(P, r, n, area, A, seed, mc, ms, ph, k, toX, toY);
      if (!rib) continue;
      // cull a ribbon whose bbox misses the layer
      const pad = rib.maxW * k + 40 * sc;
      if (rib.bx1 + pad < 0 || rib.by1 + pad < 0 || rib.bx0 - pad > cw || rib.by0 - pad > ch) continue;
      let base = ink;
      if (P.lineColorMode === 'ribbons') base = [ink, accent, echo][r % 3];
      this._drawRibbonLines(g, P, rib, r, seed, sc, base, ink, accent, cw, ch);
      if (num(P.echoCount, 0) > 0) this._drawEcho(g, P, rib, r, seed, sc, echo, mc, ms, cw, ch);
      if (P.axisLine) this._drawAxis(g, P, rib, sc, base);
    }
    if (clip) g.restore();

    if (P.border) {
      g.globalAlpha = 1;
      g.strokeStyle = P.frameColor;
      g.lineWidth = Math.max(0.5, num(P.borderWidth, 2) * sc);
      g.strokeRect(toX(area.x0), toY(area.y0), (area.x1 - area.x0) * k, (area.y1 - area.y0) * k);
    }
  }

  /** Sample the centre path, normals, half width, twist and cup of ribbon r. */
  _ribbon(P, r, n, area, A, seed, mc, ms, ph, k, toX, toY) {
    const R = (j) => hash4(seed, r, j, 7);
    const layout = P.layout;
    const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
    // extend the path past the visible area: tilt shifts line ends along the path
    const ext = (P.border && P.clipToFrame ? 0.02 : 0.08) + 0.12 * num(P.tilt, 0.3) * num(P.ribbonWidth, 0.6);
    const sway = num(P.sway, 0.3), swayFreq = num(P.swayFreq, 1.5);
    const nz = (j, u, f) => noise3(seed + 101 * r + 17 * j, u * f, mc, ms);
    let hw, pathAt;
    if (layout === 'meander') {
      hw = num(P.ribbonWidth, 0.6) * aw * 0.5 / (n + 1);
      const amp = num(P.meander, 0.6) * Math.max(0, aw * 0.5 - hw * 0.4) * (n > 1 ? 0.6 : 1);
      const turns = num(P.turns, 1.6) * (1 + (R(2) - 0.5) * 0.3);
      const phi = R(3) * TAU;
      const cx = area.x0 + aw * (n === 1 ? 0.5 : 0.2 + 0.6 * (r / (n - 1)));
      const y0 = area.y0 - ext, y1 = area.y1 + ext;
      pathAt = (u) => {
        const yy = y0 + u * (y1 - y0);
        const xx = cx + amp * Math.sin(TAU * turns * u + phi) + sway * aw * 0.12 * nz(1, u, swayFreq);
        return [xx, yy + sway * 0.04 * nz(2, u, swayFreq)];
      };
    } else if (layout === 'rows') {
      const pad = num(P.margin, 0.05) * ah;
      const rowH = (ah - 2 * pad) / n;
      const y0c = area.y0 + pad + (r + 0.5) * rowH + (R(1) - 0.5) * rowH * 0.2;
      hw = 0.5 * rowH * num(P.ribbonWidth, 0.6);
      const x0 = area.x0 - ext, x1 = area.x1 + ext;
      pathAt = (u) => [x0 + u * (x1 - x0), y0c + sway * rowH * 0.5 * nz(1, u, swayFreq)];
    } else { // columns
      const pad = num(P.margin, 0.05) * aw;
      const colW = (aw - 2 * pad) / n;
      const x0c = area.x0 + pad + (r + 0.5) * colW + (R(1) - 0.5) * colW * 0.2;
      hw = 0.5 * colW * num(P.ribbonWidth, 0.6);
      const y0 = area.y0 - ext, y1 = area.y1 + ext;
      pathAt = (u) => [x0c + sway * colW * 0.5 * nz(1, u, swayFreq), y0 + u * (y1 - y0)];
    }

    // path length estimate -> sample count
    let len = 0, [px, py] = pathAt(0);
    for (let i = 1; i <= 64; i++) { const [qx, qy] = pathAt(i / 64); len += Math.hypot(qx - px, qy - py); px = qx; py = qy; }
    const N = Math.max(64, Math.min(MAX_SAMPLES, Math.ceil((len * k) / STEP_PX)));

    const X = new Float32Array(N), Y = new Float32Array(N), NX = new Float32Array(N), NY = new Float32Array(N);
    const TX = new Float32Array(N), TY = new Float32Array(N);
    const W = new Float32Array(N), CT = new Float32Array(N), ST = new Float32Array(N), CUP = new Float32Array(N);
    const pinches = num(P.pinches, 6) * (1 + (R(4) - 0.5) * num(P.pinchJitter, 0.3));
    const phi0 = R(5) * TAU;
    const flow = Math.round(num(P.flow, 1)) * (R(6) < 0.5 && P.flowAlternate ? -1 : 1);
    const twistNoise = num(P.twistNoise, 0.5), widthVar = num(P.widthVar, 0.35), widthFreq = num(P.widthFreq, 2);
    const cup = num(P.cup, 0.25), cupVar = num(P.cupVar, 0.6);
    const lenScale = Math.max(0.3, len / Math.max(aw, ah)); // pinches per image height, not per path length
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, maxW = 0;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const [ux, uy] = pathAt(u);
      X[i] = toX(ux); Y[i] = toY(uy);
      const wf = Math.max(0.1, 1 + widthVar * nz(3, u, widthFreq * lenScale));
      W[i] = hw * wf * k;
      if (hw * wf > maxW) maxW = hw * wf;
      const th = Math.PI * pinches * lenScale * u + phi0 + twistNoise * Math.PI * 0.5 * nz(4, u, 2.2 * lenScale) - flow * ph;
      CT[i] = Math.cos(th); ST[i] = Math.sin(th);
      CUP[i] = cup * (1 + cupVar * 1.5 * nz(5, u, 1.7 * lenScale));
      if (X[i] < bx0) bx0 = X[i]; if (X[i] > bx1) bx1 = X[i];
      if (Y[i] < by0) by0 = Y[i]; if (Y[i] > by1) by1 = Y[i];
    }
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      let tx = X[b] - X[a], ty = Y[b] - Y[a];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      TX[i] = tx; TY[i] = ty; NX[i] = -ty; NY[i] = tx;
    }
    return { N, X, Y, NX, NY, TX, TY, W, CT, ST, CUP, bx0, by0, bx1, by1, maxW, hw };
  }

  _drawRibbonLines(g, P, rib, r, seed, sc, base, ink, accent, cw, ch) {
    const { N, X, Y, NX, NY, TX, TY, W, CT, ST, CUP } = rib;
    const n = Math.max(2, Math.round(num(P.lines, 30)));
    const spread = num(P.spread, 1), jitter = num(P.lineJitter, 0.2);
    const tilt = num(P.tilt, 0.3), depthWidth = num(P.depthWidth, 0.4);
    const lw = num(P.lineWidth, 1.2) * sc, lwVar = num(P.lineWidthVar, 0.4), edge = num(P.edgeWeight, 1.8);
    const pressure = num(P.pressure, 0.3);
    const accentRatio = num(P.accentRatio, 0), accentLen = num(P.accentLength, 0.35);
    const dashed = hash4(seed, r, 9, 7) < num(P.dashMix, 0);
    const dashOn = num(P.dashLength, 10) * sc, dashOff = num(P.dashGap, 6) * sc;
    const xs = new Float32Array(N), ys = new Float32Array(N), hws = new Float32Array(N);
    g.globalAlpha = Math.min(1, Math.max(0, num(P.lineOpacity, 0.9)));
    for (let i = 0; i < n; i++) {
      const lr = (j) => hash4(seed, r * 4096 + i, j, 11);
      let s = -1 + (2 * i) / (n - 1);
      s = Math.sign(s) * Math.pow(Math.abs(s), spread);
      if (i > 0 && i < n - 1) s += jitter * (lr(1) - 0.5) * (2 / (n - 1));
      const d0 = 1 - s * s;
      let lwi = lw * Math.max(0.15, 1 + lwVar * (lr(2) * 2 - 1));
      if (i === 0 || i === n - 1) lwi *= edge;
      // pen pressure: two slow sines per line
      const f1 = 3 + lr(3) * 6, f2 = 9 + lr(4) * 14, p1 = lr(5) * TAU, p2 = lr(6) * TAU;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let j = 0; j < N; j++) {
        const u = j / (N - 1);
        const d = CUP[j] * d0;
        const lat = s * CT[j] - d * ST[j];
        const dep = s * ST[j] + d * CT[j];
        const w = W[j];
        const px = X[j] + NX[j] * w * lat + TX[j] * w * tilt * dep;
        const py = Y[j] + NY[j] * w * lat + TY[j] * w * tilt * dep;
        xs[j] = px; ys[j] = py;
        const pr = 1 + pressure * 0.5 * (Math.sin(TAU * f1 * u + p1) + 0.6 * Math.sin(TAU * f2 * u + p2));
        hws[j] = 0.5 * lwi * Math.max(0.2, pr) * Math.max(0.3, 1 + depthWidth * dep * 0.6);
        if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
        if (py < by0) by0 = py; if (py > by1) by1 = py;
      }
      const m = lwi * 3;
      if (bx1 + m < 0 || by1 + m < 0 || bx0 - m > cw || by0 - m > ch) continue;
      let col = base;
      if (P.lineColorMode === 'gradient') col = mixRgb(ink, accent, (i / (n - 1)));
      g.fillStyle = rgbCss(col);
      g.beginPath();
      if (dashed) {
        // dashes by arc length, random phase per line
        let acc = -lr(7) * (dashOn + dashOff), on = false, start = 0;
        let segOn = dashOn * (0.6 + 0.8 * lr(8));
        for (let j = 1; j < N; j++) {
          acc += Math.hypot(xs[j] - xs[j - 1], ys[j] - ys[j - 1]);
          if (!on && acc >= 0) { on = true; start = j - 1; acc = 0; }
          else if (on && acc >= segOn) {
            strokeRange(g, xs, ys, hws, start, j);
            on = false; acc = -dashOff * (0.6 + 0.8 * hash4(seed, i, j, 13));
            segOn = dashOn * (0.6 + 0.8 * hash4(seed, i, j, 17));
          }
        }
        if (on) strokeRange(g, xs, ys, hws, start, N - 1);
      } else {
        strokeRange(g, xs, ys, hws, 0, N - 1);
      }
      g.fill();
      // accent: a partial overstroke in the accent colour
      if (lr(9) < accentRatio) {
        const a0 = lr(10) * (1 - accentLen * 0.5) - accentLen * 0.25;
        const j0 = Math.max(0, Math.floor(a0 * (N - 1))), j1 = Math.min(N - 1, Math.floor((a0 + accentLen) * (N - 1)));
        if (j1 > j0 + 1) {
          for (let j = j0; j <= j1; j++) hws[j] *= 1.15;
          g.fillStyle = rgbCss(accent);
          g.beginPath();
          strokeRange(g, xs, ys, hws, j0, j1, true);
          g.fill();
        }
      }
      this.stats.lines++; this.stats.points += N;
    }
  }

  /** Loose offset outlines that follow the ribbon silhouette. */
  _drawEcho(g, P, rib, r, seed, sc, echo, mc, ms, cw, ch) {
    const { N, X, Y, NX, NY, W, CT, ST, CUP } = rib;
    const count = Math.round(num(P.echoCount, 1));
    const gap = num(P.echoGap, 0.35), wob = num(P.echoWobble, 0.4);
    const ew = num(P.echoWidth, 0.8) * sc;
    const xs = new Float32Array(N), ys = new Float32Array(N), hws = new Float32Array(N).fill(ew * 0.5);
    g.globalAlpha = Math.min(1, num(P.echoOpacity, 0.8));
    g.fillStyle = rgbCss(echo);
    // silhouette per sample: min / max lateral over the strip
    const lo = new Float32Array(N), hi = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      let mn = Infinity, mx = -Infinity;
      for (let q = 0; q <= 8; q++) {
        const s = -1 + q / 4;
        const lat = s * CT[j] - CUP[j] * (1 - s * s) * ST[j];
        if (lat < mn) mn = lat; if (lat > mx) mx = lat;
      }
      lo[j] = mn; hi[j] = mx;
    }
    for (let e = 1; e <= count; e++) {
      for (const side of [-1, 1]) {
        const salt = r * 64 + e * 2 + (side > 0 ? 1 : 0);
        g.beginPath();
        for (let j = 0; j < N; j++) {
          const u = j / (N - 1);
          const lat = side > 0 ? hi[j] : lo[j];
          const wobble = 1 + wob * noise3(seed + 999 + salt, u * 7, mc, ms);
          const off = W[j] * lat + side * W[j] * gap * e * Math.max(0.1, wobble);
          xs[j] = X[j] + NX[j] * off; ys[j] = Y[j] + NY[j] * off;
        }
        strokeRange(g, xs, ys, hws, 0, N - 1);
        g.fill();
      }
    }
  }

  _drawAxis(g, P, rib, sc, col) {
    const { N, X, Y } = rib;
    g.globalAlpha = Math.min(1, num(P.lineOpacity, 0.9));
    g.strokeStyle = rgbCss(col);
    g.lineWidth = Math.max(0.3, num(P.lineWidth, 1.2) * sc);
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(X[0], Y[0]);
    for (let j = 1; j < N; j++) g.lineTo(X[j], Y[j]);
    g.stroke();
  }
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
