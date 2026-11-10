# 007 · Ink Ribbons

Bundles of pen lines twisted into ribbons. The lines pinch together, fan out into cupped petals and fold over, like a hand-drawn ribbon study. You can lay them out as vertical columns inside a drawn frame (a red-pen sheet), as one or more S-shaped meanders over watercolour washes (sumi ink with coral blobs), or as horizontal rows. Every format is vertical, for Instagram: 4:5, 3:4 and 9:16. The twist flows along the ribbons in a seamless loop.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/007-ink-ribbons/. It needs only Canvas 2D (no WebGL).

## How it works

1. **Scene** (`scene.js`): holds the palettes, the hash and value-noise helpers, and the background shapes. Each shape is a watercolour blob: a 10-vertex polygon is deformed by recursive midpoint displacement, then 22 more-deformed, slightly shrinking layers are stacked on it. These are built once per seed in unit space, so the size, count and opacity sliders never reshuffle them.
2. **Renderer** (`ribbon-2d.js`, Canvas 2D):
   - **Ribbon geometry:** each ribbon is a centre path (column, row or meander, with noise sway) plus a strip of lines at offsets `s` in −1…1. The strip has a cupped cross-section `d = cup·(1 − s²)` and twists by an angle θ(u) along the path. Projecting it gives the line positions: `lateral = s·cos θ − d·sin θ`, `depth = s·sin θ + d·cos θ`.
   - **What each part does:** where cos θ passes 0 the lines pinch together. `cup` turns the pinches into folded petals. `tilt` shifts the lines along the path by their depth, which gives the curled, fabric-like crossings. `depth width` makes the near lines thicker.
   - **Line drawing:** every line is filled as a polygon whose width varies (pen pressure, depth, heavier edge lines), so overlaps darken like real ink.
   - **Compositing:** the lines are drawn into a transparent layer at the supersampling factor, then blended down onto the cached background (paper colour plus washes) with multiply (screen on dark paper). A cached paper texture is laid over everything with soft-light. Paper and washes do not move, so videos stay clean.
   - **Seamless loop:** the twist moves a whole number of turns per loop, and the shape morph samples noise on a circle in time. `dev.html?check=1` measures a loop difference of 0.
   - **Size independence:** sizes are given in px of a 1080 px wide image and scale with the output, so a 4320 px export looks like the 1080 px preview, only sharper. Tiled exports render the same geometry through a window.
3. **Params** (`params.js`): defaults, the 5 presets and the formats, shared by `sketch.js` and `dev.html`.
4. **Sketch** (`sketch.js`): UI, live loop, still and video export. The export code is the same as in 004–006.

`dev.html` is the renderer dev harness (no UI, query-string params): `dev.html?preset=Twin%20meanders&seed=7&check=1`, or `tiles=1` to stitch four `renderRegion` calls.

## Controls

| Folder | What |
|---|---|
| Seed & presets | seed, randomize, randomize params, reset, and the presets *Red pen columns*, *Dashed columns*, *Ink meander + wash*, *Twin meanders* and *Night rows* |
| Layout | format (4:5, 3:4, 9:16), layout (columns, meander, rows), ribbons, ribbon width, margin, sway, sway freq, meander amp, meander turns |
| Twist | pinches, pinch jitter, twist noise, cup (fold), cup variation, tilt, width variation, width freq |
| Lines | lines per ribbon, spread (lines bunched at the edges or the centre), spacing jitter, line width, width variation, edge weight, pen pressure, depth width, opacity, dashed ribbons (fraction), dash length, dash gap, axis line |
| Accents & echoes | accent strokes (partial over-strokes in the accent colour) and their length; echo outlines (loose outlines around the ribbon silhouette): count, gap, wobble, width, opacity |
| Frame | border, margin, width, clip ribbons to frame |
| Background shapes | show shapes on/off, style (watercolour, flat, outline), count, size, opacity, drops size, wash rim, irregularity, blend |
| Colour | palette (10), then editable paper, ink, accent, echo, wash 1–3 and frame colours; line colours (ink, gradient ink → accent, per ribbon), ink blend, paper texture |
| Motion | play/pause, time, speed, frame-exact (slow-mo), loop seconds, twist turns per loop, alternate direction, morph, preview scale |
| Still export | scale (1× = 1080 px wide up to 6× = 6480), supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | width (720, 1080, 1440 or 2160; height follows the format), fps, loops, bitrate, format (MP4, WebM, WebM slow-mo, PNG sequence), supersampling |

Choosing a palette loads its colours into the colour fields. Edit them freely after that; they are saved in the params JSON.

Keys: Space play/pause · R new seed · Shift+R randomize params · ←/→ seed · ,/. step one frame · S still · V video · P snapshot · Z 100% view · F frame-exact.

Console: `ribbons.preset('Ink meander + wash')`, `ribbons.set({ layout: 'rows', pinches: 8 })`.

## Notes

- **Speed:** preview takes about 25–55 ms per frame at 1080×1350 in software rendering. A real GPU is faster. Lower the preview scale or the lines per ribbon if it gets slow.
- **Stills:** stills at 4× or 6× with 2× supersampling are rendered in tiles of at most 2048 px and streamed to a PNG.
- **Video:** line art compresses well. 30 Mbps is clean at 1080 wide, and the paper texture does not move, so it costs almost nothing in the video. For the best quality, export a PNG sequence and use the ffmpeg command saved with it.
