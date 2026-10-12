// composition.js
// Seeded generation of the composition (resolution independent) and drawing of
// the two "source" layers that the stipple shader consumes:
//
//   tone layer  (RGBA canvas):  R = luminance 0..1 (before tone curve)
//                               B = 255 where halo/background may add light, 0 inside black bands
//   grain layer (RGBA canvas):  R = grain code. 0 = hard black mask (bands),
//                               otherwise dot scale = 2^((code-128)/32), each shape a unique code
//                               so neighbouring shards get independent dot grids (crisp edges).
//
// Coordinates: "units" where the SHORT side of the image = 1, origin at image
// centre, y down. Same seed + params + aspect => same geometry at any resolution.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const r = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  for (let i = 0; i < 8; i++) r();
  const rng = {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => Math.floor(a + (b - a + 1) * r()),
    chance: (p) => r() < p,
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    gauss: () => {
      let u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}

const GRAIN_CENTER = 128;
const GRAIN_STEP = 32; // codes per octave
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Map an octave offset (log2 of dot scale) to a grain code; `jitter` makes codes unique-ish. */
function grainCode(octave, rng) {
  return clamp(Math.round(GRAIN_CENTER + octave * GRAIN_STEP + rng.range(-3, 3)), 16, 250);
}

/**
 * Build a composition.
 * @param {number} seed
 * @param {object} P params (see sketch.js DEFAULTS)
 * @param {number} aspect width / height
 */
export function generateComposition(seed, P, aspect) {
  const rng = makeRng(seed);
  const halfW = aspect >= 1 ? 0.5 * aspect : 0.5;
  const halfH = aspect >= 1 ? 0.5 : 0.5 / aspect;
  const comp = { halfW, halfH, layers: [], bgCode: grainCode(Math.log2(P.bgGrain), { range: () => 0 }) };

  // Grain palette: discrete octave offsets so regions read as "fine" vs "coarse".
  const v = P.grainVariation;
  const grainPalette = [-0.6 * v, 0, 0, 0.35 * v, 0.8 * v, 1.4 * v];
  const pickGrain = () => grainCode(rng.pick(grainPalette), rng);
  const lineCode = grainCode(-1.3, rng); // bright edge lines use fine dots so they stay crisp

  if (P.mode === 'shards') {
    comp.layers.push(buildShards(rng, P, halfW, halfH, pickGrain, lineCode, P.frame));
  } else if (P.mode === 'slabs') {
    comp.layers.push(buildSlabs(rng, P, halfW, halfH, pickGrain, lineCode, P.frame));
  } else {
    // mixed: dim unframed shard fans behind, slabs in front
    const back = buildShards(rng, { ...P, shapeCount: Math.round(P.shapeCount * 0.6), bandCount: Math.min(P.bandCount, 2) },
      halfW, halfH, pickGrain, lineCode, P.frame, 0.45);
    comp.layers.push(back);
    comp.layers.push(buildSlabs(rng, P, halfW, halfH, pickGrain, lineCode, P.frame));
  }
  return comp;
}

function frameQuad(rng, P, halfW, halfH) {
  const m = P.frameMargin;
  const j = () => rng.range(-0.006, 0.006);
  const x0 = -halfW + m, x1 = halfW - m, y0 = -halfH + m, y1 = halfH - m;
  return [[x0 + j(), y0 + j()], [x1 + j(), y0 + j()], [x1 + j(), y1 + j()], [x0 + j(), y1 + j()]];
}

// ----------------------------------------------------------------------------- Shards (ref B)
function buildShards(rng, P, halfW, halfH, pickGrain, lineCode, framed, toneScale = 1) {
  const items = [];
  const clip = framed ? frameQuad(rng, P, halfW, halfH) : null;
  const fx0 = framed ? -halfW + P.frameMargin : -halfW;
  const fx1 = -fx0;
  const fy0 = framed ? -halfH + P.frameMargin : -halfH;
  const fy1 = -fy0;
  const span = Math.hypot(fx1 - fx0, fy1 - fy0);

  // base: a dark gradient so gaps between shards aren't dead flat
  items.push({
    type: 'poly',
    pts: [[fx0 - 1, fy0 - 1], [fx1 + 1, fy0 - 1], [fx1 + 1, fy1 + 1], [fx0 - 1, fy1 + 1]],
    g0: [fx0, fy0], g1: [fx1, fy1],
    stops: [[0, 0.3 * toneScale], [0.5, 0.15 * toneScale], [1, 0.05 * toneScale]],
    grain: pickGrain(),
  });

  const nF = Math.max(1, P.focalCount);
  const foci = [];
  for (let i = 0; i < nF; i++) {
    foci.push([rng.range(fx0, fx1) * 0.85, rng.range(fy0, fy1) * 0.85]);
  }
  const perFan = Math.max(3, Math.round(P.shapeCount / nF));
  const lines = [];

  foci.forEach((f, fi) => {
    const first = fi === 0;
    const sweep = first ? Math.PI * 2 : rng.range(Math.PI * 0.6, Math.PI * 1.7);
    const a0 = rng.range(0, Math.PI * 2);
    // random angular partition
    const w = Array.from({ length: perFan }, () => Math.pow(rng.range(0.2, 1), 1.5));
    const wsum = w.reduce((s, x) => s + x, 0);
    const angles = [a0];
    for (let i = 0; i < perFan; i++) angles.push(angles[i] + (w[i] / wsum) * sweep);
    const rayLen = angles.map(() => (first ? span * 1.2 : span * rng.range(0.25, 1.1)));
    const lightDir = rng.range(0, Math.PI * 2);
    const fanGrain = pickGrain();
    const fanBright = rng.range(0.55, 1);

    for (let i = 0; i < perFan; i++) {
      if (!first && rng.chance(0.22)) continue; // gaps show the layers below
      const aA = angles[i], aB = angles[i + 1];
      const pA = [f[0] + Math.cos(aA) * rayLen[i], f[1] + Math.sin(aA) * rayLen[i]];
      const pB = [f[0] + Math.cos(aB) * rayLen[i + 1], f[1] + Math.sin(aB) * rayLen[i + 1]];
      let pts = [f, pA, pB];
      // sometimes cut the shard across, keeping the far piece (a broken quad)
      if (rng.chance(0.3)) {
        const t1 = rng.range(0.1, 0.55), t2 = rng.range(0.1, 0.55);
        pts = [lerp2(f, pA, t1), pA, pB, lerp2(f, pB, t2)];
      }
      // tone: flat-ish level with a linear gradient
      const hi = clamp(fanBright * Math.pow(rng.next(), 0.7) * 1.05 * (rng.chance(0.12) ? 0.2 : 1), 0.02, 1) * toneScale;
      const lo = hi * rng.range(0.05, 0.75);
      const ga = lightDir + rng.gauss() * 0.6;
      const c = centroid(pts);
      const rad = Math.max(dist(f, pA), dist(f, pB)) * 0.5;
      const g0 = [c[0] - Math.cos(ga) * rad, c[1] - Math.sin(ga) * rad];
      const g1 = [c[0] + Math.cos(ga) * rad, c[1] + Math.sin(ga) * rad];
      items.push({
        type: 'poly', pts, g0, g1,
        stops: [[0, hi], [0.55, mix(hi, lo, 0.7)], [1, lo]],
        grain: rng.chance(0.35) ? pickGrain() : fanGrain + rng.int(-2, 2),
      });
      if (rng.chance(0.09 * P.edgeFreq * 2)) {
        const pa = pts[pts.length === 3 ? 0 : 0], pb = pts[1];
        lines.push({ type: 'line', a: pa, b: pb, width: rng.range(0.0008, 0.0022), intensity: rng.range(0.5, 1), fade: true });
      }
    }
  });

  // a few loose shards anywhere
  const loose = Math.round(P.shapeCount * 0.12);
  for (let i = 0; i < loose; i++) {
    const c = [rng.range(fx0, fx1), rng.range(fy0, fy1)];
    const r = rng.range(0.04, 0.22);
    const a = rng.range(0, Math.PI * 2);
    const pts = [0, 1, 2].map((k) => {
      const ang = a + k * 2.1 + rng.range(-0.5, 0.5);
      const rr = r * rng.range(0.4, 1.3);
      return [c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr];
    });
    const hi = rng.range(0.1, 1) * toneScale;
    items.push({ type: 'poly', pts, g0: pts[0], g1: lerp2(pts[1], pts[2], 0.5), stops: [[0, hi], [1, hi * rng.range(0.1, 0.6)]], grain: pickGrain() });
  }

  items.push(...lines);

  // black bands (lead came / shadows)
  const baseAng = rng.range(0, Math.PI);
  for (let i = 0; i < P.bandCount; i++) {
    let a, b;
    if (rng.chance(0.45) && foci.length) {
      // along a ray from a focal point
      const f = rng.pick(foci);
      const ang = rng.range(0, Math.PI * 2);
      a = [f[0] + Math.cos(ang) * rng.range(0, 0.05), f[1] + Math.sin(ang) * rng.range(0, 0.05)];
      b = [f[0] + Math.cos(ang) * span * 1.2, f[1] + Math.sin(ang) * span * 1.2];
    } else {
      const ang = baseAng + rng.gauss() * 0.35;
      const c = [rng.range(fx0, fx1), rng.range(fy0, fy1)];
      a = [c[0] - Math.cos(ang) * span, c[1] - Math.sin(ang) * span];
      b = [c[0] + Math.cos(ang) * span, c[1] + Math.sin(ang) * span];
    }
    const wA = P.bandWidth * rng.range(0.3, 1.6);
    const wB = P.bandWidth * rng.range(0.3, 1.6);
    items.push({ type: 'band', pts: taperedQuad(a, b, wA, wB) });
    // light catching the edge of the band
    if (rng.chance(0.35 * P.edgeFreq)) {
      const q = taperedQuad(a, b, wA, wB);
      const side = rng.chance(0.5) ? [q[0], q[1]] : [q[3], q[2]];
      items.push({ type: 'line', a: side[0], b: side[1], width: rng.range(0.0008, 0.0016), intensity: rng.range(0.4, 0.9), fade: true });
    }
  }

  return { clip, items, lineCode };
}

// ----------------------------------------------------------------------------- Slabs (ref A)
function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; }
function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; }
function rotZ(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; }

function buildSlabs(rng, P, halfW, halfH, pickGrain, lineCode, framed) {
  const items = [];
  const n = Math.max(1, P.slabCount);
  const rot = P.perspective;
  const yaw = rng.range(-1, 1) * rot * 1.1;
  const tilt = (rng.chance(0.5) ? 1 : -1) * rng.range(0.4, 0.8); // how much the sheets face the camera
  const pitch = rng.range(-1, 1) * rot * 0.35;
  const roll = rng.range(-Math.PI, Math.PI);
  const W = rng.range(0.9, 1.3);
  const H = rng.range(0.28, 0.48);
  const spacing = rng.range(0.22, 0.36);
  const flip = rng.chance(0.5) ? Math.PI : 0; // which side the sheets extend to from their lit edge
  const camD = mix(6, 1.8, rot);
  const f = camD * 0.9;

  // slabs in 3D: planes stacked along the local y axis (like the bars of an "E").
  // Each plane is built from its lit edge (local z = 0) and extends away from it; it either
  // follows the shared direction or is turned 90 degrees in-plane, and is either a full
  // sheet of light or only its bright edge.
  const slabs = [];
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * spacing * rng.range(0.85, 1.15);
    const w = W * rng.range(0.6, 1.0);
    const len = H * rng.range(0.7, 1.15) * Math.pow(2, rng.range(-0.6, 1.4)); // some sheets extend much further
    const sx = rng.range(-0.12, 0.12);
    const sz = rng.range(-0.12, 0.12);
    const cross = rng.next() < P.slabCross;
    const edgeOnly = rng.next() < P.slabEdgeOnly;
    const spin = flip + (cross ? Math.PI / 2 : 0) + rng.range(-0.04, 0.04);
    // corners: p0-p1 = lit edge, p3-p2 = far (dark) edge
    const corners = [[-w / 2, 0, 0], [w / 2, 0, 0], [w / 2, 0, len], [-w / 2, 0, len]]
      .map((p) => { const q = rotY(p, spin); return [q[0] + sx, q[1] + off, q[2] + sz]; });
    const xf = corners.map((p) => {
      let q = rotY(rotX(p, pitch + tilt), yaw);
      q = rotZ(q, roll);
      return [q[0], q[1], q[2] + camD];
    });
    slabs.push({ xf, edgeOnly, intensity: rng.range(0.55, 1), fall: rng.range(1.8, 4.5), grain: pickGrain() });
  }
  if (P.slabEdgeOnly < 1 && slabs.every((s) => s.edgeOnly)) slabs[0].edgeOnly = false; // keep at least one sheet
  // project
  for (const s of slabs) {
    s.p = s.xf.map((q) => [(q[0] * f) / q[2], (q[1] * f) / q[2]]);
    s.z = s.xf.reduce((a, q) => a + q[2], 0) / 4;
  }
  // fit bbox into a random region of the canvas
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const s of slabs) for (const p of s.p) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }
  const fill = rng.range(0.6, 0.85);
  const availW = (halfW - (framed ? P.frameMargin : 0)) * 2;
  const availH = (halfH - (framed ? P.frameMargin : 0)) * 2;
  const sc = Math.min((availW * fill) / (bx1 - bx0), (availH * fill) / (by1 - by0));
  const cx = rng.range(-1, 1) * (availW - (bx1 - bx0) * sc) * 0.4;
  const cy = rng.range(-1, 1) * (availH - (by1 - by0) * sc) * 0.4;
  const mx = (bx0 + bx1) / 2, my = (by0 + by1) / 2;
  for (const s of slabs) s.p = s.p.map((p) => [(p[0] - mx) * sc + cx, (p[1] - my) * sc + cy]);

  slabs.sort((a, b) => b.z - a.z); // far first

  for (const s of slabs) {
    const [p0, p1, p2, p3] = s.p;
    const eA = [p0, p1], dark = [p3, p2]; // lit edge, far edge
    const stops = [0, 0.06, 0.15, 0.3, 0.5, 0.75, 1].map((t) => [t, s.intensity * Math.exp(-s.fall * t) * 0.97 + 0.015]);
    if (!s.edgeOnly) items.push({ type: 'poly', pts: s.p, g0: lerp2(p0, p1, 0.5), g1: lerp2(p3, p2, 0.5), stops, grain: s.grain });
    // very bright line on the lit edge, slightly overshooting
    const ext = rng.range(0, 0.12);
    items.push({ type: 'line', a: lerp2(eA[0], eA[1], -ext), b: lerp2(eA[0], eA[1], 1 + ext * rng.next()),
      width: rng.range(0.0012, 0.003), intensity: Math.min(1, s.intensity + 0.2), fade: false });
    // side edges catch light near the bright end and fade out
    if (rng.chance(0.6 * P.edgeFreq + 0.2)) {
      for (const k of [0, 1]) {
        if (rng.chance(0.3) || s.edgeOnly) continue;
        items.push({ type: 'line', a: eA[k], b: dark[k], width: rng.range(0.0008, 0.0018), intensity: s.intensity * 0.8, fade: true });
      }
    }
  }
  return { clip: framed ? frameQuad(rng, P, halfW, halfH) : null, items, lineCode };
}

// ----------------------------------------------------------------------------- drawing

/**
 * Draw one layer of the composition into a 2D context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} comp
 * @param {'tone'|'grain'} kind
 * @param {number} fullW full output width (px) the composition is laid out for
 * @param {number} fullH
 * @param {number} ox,oy absolute output px of the canvas's top-left
 * @param {number} cw,ch canvas size to clear
 * @param {number} edgeIntensity multiplier for line brightness
 */
export function drawLayer(ctx, comp, kind, fullW, fullH, ox, oy, cw, ch, edgeIntensity = 1) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = kind === 'tone' ? 'rgb(0,0,255)' : gray(comp.bgCode);
  ctx.fillRect(0, 0, cw, ch);
  const u = Math.min(fullW, fullH);
  ctx.setTransform(u, 0, 0, u, fullW / 2 - ox, fullH / 2 - oy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const layer of comp.layers) {
    ctx.save();
    if (layer.clip) { path(ctx, layer.clip); ctx.clip(); }
    for (const it of layer.items) {
      if (it.type === 'poly') {
        if (kind === 'tone') {
          const g = ctx.createLinearGradient(it.g0[0], it.g0[1], it.g1[0], it.g1[1]);
          for (const [t, v] of it.stops) g.addColorStop(t, `rgb(${tone8(v)},0,255)`);
          ctx.fillStyle = g;
        } else ctx.fillStyle = gray(it.grain);
        path(ctx, it.pts); ctx.fill();
      } else if (it.type === 'band') {
        ctx.fillStyle = 'rgb(0,0,0)';
        path(ctx, it.pts); ctx.fill();
      } else if (it.type === 'line') {
        if (kind === 'tone') {
          if (edgeIntensity <= 0) continue;
          ctx.globalCompositeOperation = 'lighter';
          const I = Math.min(1, it.intensity * edgeIntensity);
          // glow stack: wide & faint -> thin & bright
          const passes = [[10, 0.035], [5, 0.07], [2.5, 0.18], [1, 1]];
          for (const [wm, al] of passes) {
            const a = al * I;
            if (it.fade) {
              const g = ctx.createLinearGradient(it.a[0], it.a[1], it.b[0], it.b[1]);
              g.addColorStop(0, `rgba(255,255,255,${a})`);
              g.addColorStop(1, 'rgba(255,255,255,0)');
              ctx.strokeStyle = g;
            } else ctx.strokeStyle = `rgba(255,255,255,${a})`;
            ctx.lineWidth = it.width * wm;
            ctx.beginPath(); ctx.moveTo(it.a[0], it.a[1]); ctx.lineTo(it.b[0], it.b[1]); ctx.stroke();
          }
          ctx.globalCompositeOperation = 'source-over';
        } else {
          ctx.strokeStyle = gray(layer.lineCode);
          ctx.lineWidth = it.width * 2.5;
          ctx.beginPath(); ctx.moveTo(it.a[0], it.a[1]); ctx.lineTo(it.b[0], it.b[1]); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ----------------------------------------------------------------------------- halo field

/**
 * Low-resolution float halo field: the tone layer rendered small, then blurred
 * at two radii (near glow + long spray tail). Its grid size is fixed (independent
 * of output resolution) so preview and export see the same halo.
 * @returns {{data: Float32Array, w: number, h: number}}
 */
export function computeHalo(comp, aspect, spread) {
  const LONG = 640;
  const w = aspect >= 1 ? LONG : Math.round(LONG * aspect);
  const h = aspect >= 1 ? Math.round(LONG / aspect) : LONG;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  drawLayer(ctx, comp, 'tone', w, h, 0, 0, w, h, 1);
  const img = ctx.getImageData(0, 0, w, h).data;
  const src = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) src[i] = img[i * 4] / 255;
  cv.width = cv.height = 0;
  const short = Math.min(w, h);
  const r1 = Math.max(1, spread * short);
  const near = gaussBlur(src, w, h, r1);
  const far = gaussBlur(src, w, h, r1 * 3.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = near[i] * 0.75 + far[i] * 0.45;
  return { data: out, w, h };
}

/** 3 x box blur ~ gaussian with sigma; zero outside the image. */
function gaussBlur(src, w, h, sigma) {
  const boxes = boxesForGauss(sigma, 3);
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  for (const bs of boxes) {
    const r = (bs - 1) / 2;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}
function boxH(s, d, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) acc += s[o + x];
    for (let x = 0; x < w; x++) {
      d[o + x] = acc * inv;
      const xa = x + r + 1, xr = x - r;
      if (xa < w) acc += s[o + xa];
      if (xr >= 0) acc -= s[o + xr];
    }
  }
}
function boxV(s, d, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) acc += s[y * w + x];
    for (let y = 0; y < h; y++) {
      d[y * w + x] = acc * inv;
      const ya = y + r + 1, yr = y - r;
      if (ya < h) acc += s[ya * w + x];
      if (yr >= 0) acc -= s[yr * w + x];
    }
  }
}

// ----------------------------------------------------------------------------- utils
function path(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
const gray = (c) => `rgb(${c},${c},${c})`;
const tone8 = (v) => Math.round(clamp(v, 0, 1) * 255);
const mix = (a, b, t) => a + (b - a) * t;
const lerp2 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
function taperedQuad(a, b, wA, wB) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  return [
    [a[0] + nx * wA / 2, a[1] + ny * wA / 2], [b[0] + nx * wB / 2, b[1] + ny * wB / 2],
    [b[0] - nx * wB / 2, b[1] - ny * wB / 2], [a[0] - nx * wA / 2, a[1] - ny * wA / 2],
  ];
}
