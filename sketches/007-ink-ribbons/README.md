# 007 · Ink Ribbons

Ribbons drawn as bundles of pen lines. They twist, fold and pass over and under each other, and where they fold the lines crowd together into dark shading. All formats are vertical, for Instagram: 4:5, 3:4 and 9:16.

There are two compositions:

- **Full page:** a padding margin around a coloured backdrop (cobalt by default), with paper-white ribbons twisting on top. Other layouts: vertical columns (red-pen sheet), S-curve meanders over watercolour washes, and horizontal rows.
- **Frames mosaic:** the picture is cut into frames of random sizes with gaps and a jagged outline. Each frame is filled with its own flowing lines, and very thin frames become small solid squares.

The twist flows along the ribbons in a seamless loop.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/007-ink-ribbons/. It needs only Canvas 2D (no WebGL).

## How it works

1. **Scene** (`scene.js`): palettes (12; each has paper, ink, accent, echo, 3 washes, frame and backdrop colours), hash and value-noise helpers, and the watercolour shapes. The shapes are built once per seed: polygons deformed by recursive midpoint displacement, with 22 stacked layers each.
2. **Renderer** (`ribbon-2d.js`, Canvas 2D):
   - **Centre path:** either analytic (columns, rows, meander) or a *walk* (tangle, frame cells). A walk integrates a heading with curl noise and a soft pull back to the centre, then is smoothed with Catmull-Rom.
   - **The strip:** around the path sits a strip of lines at offsets `s` in −1…1. Its cross-section is cupped, `d = cup·(1 − s²)`, and twisted by θ(u). Projecting it gives `lateral = s·cos θ − d·sin θ` and `depth = s·sin θ + d·cos θ`.
   - **Shaping:** where cos θ passes 0 the lines pinch. `tilt` slides lines along the path with their depth, which gives curled crossings. `fan` bunches the lines towards a heavy core edge, and `ruffle` frills the outer edge.
   - **Opaque ribbons (depth):** the strip is cut into chunks along the path, and each chunk into runs of lines whose side-to-side order is monotonic. A fold flips that order; chunks that fold are cut into 2-sample slices. Each piece gets a depth (an over/under noise along the path plus the twist depth). All pieces are sorted back to front and painted as a paper fill bounded by its real, bowed cross-sections, then its lines. Ribbons pass over and under each other, and folds hide what lies behind them.
   - **Fold shading:** where the strip turns edge-on the lines crowd; `fold shading` thickens each line by the local crowding, so folds fill in to black like hatching.
   - **Translucent mode:** with *opaque ribbons* off you get the first version's look: each line is a translucent polygon, blended with multiply onto the paper.
   - **Background and texture:** the background (paper, padding, coloured backdrop, washes) and the paper texture are cached and do not move, so videos stay clean.
   - **Loop and size:** the twist moves a whole number of turns per loop, and noise morphs on a circle in time, so the loop is seamless (`dev.html?check=1` measures a loop difference of 0). Sizes are px of a 1080 px wide image and scale with the output.
3. **Params** (`params.js`): defaults, presets and formats. A preset is the defaults plus its own overrides plus its palette's colours, so presets never inherit leftovers from the previous look.
4. **Sketch** (`sketch.js`): UI, live loop, still and video export (same export code as 004–006).

`dev.html` is the renderer dev harness (no UI, query-string params): `dev.html?preset=Mosaic%20frames&seed=7&check=1`, or `tiles=1` to stitch four `renderRegion` calls.

## Controls

| Folder | What |
|---|---|
| Seed & presets | seed, randomize, randomize params, reset, and the presets *Tangle on cobalt*, *Ink knots*, *Fan ribbons*, *Mosaic frames*, *Red pen columns*, *Dashed columns*, *Ink meander + wash*, *Twin meanders* and *Night rows* |
| Composition | format (4:5, 3:4, 9:16), composition (full page or frames mosaic), padding, coloured backdrop, frame line and its width, clip to padding |
| Frames mosaic | number of frames, gap, size irregularity, jagged outline, solid-square threshold, ribbons per frame, ribbon width, line spacing, curl, pinches |
| Layout (full page) | layout (tangle, columns, meander, rows), ribbons, ribbon width, path length, curl, curl freq, over/under, margin, sway, sway freq, meander amp, meander turns |
| Twist & shape | pinches, pinch jitter, twist noise, cup (fold), cup variation, tilt, width variation, width freq, fan, ruffle, ruffle freq |
| Lines | opaque ribbons (depth), ribbon fill, lines per ribbon, spread, spacing jitter, line width, width variation, edge weight, core line weight, fold shading, pen pressure, depth width, opacity, dashed ribbons, dash length, dash gap, axis line |
| Accents & echoes | accent strokes and their length; echo outlines (count, gap, wobble, width, opacity) |
| Background shapes | show shapes, style (watercolour, flat, outline), count, size, opacity, drops size, wash rim, irregularity, blend |
| Colour | palette (12), then editable paper / ribbon fill, backdrop, ink, accent, echo, wash 1–3 and frame colours; line colours (ink, gradient, per ribbon), ink blend, paper texture |
| Motion | play/pause, time, speed, frame-exact (slow-mo), loop seconds, twist turns per loop, alternate direction, morph, preview scale |
| Still export | scale (1× = 1080 px wide up to 6× = 6480), supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | width (720, 1080, 1440 or 2160; height follows the format), fps, loops, bitrate, format (MP4, WebM, WebM slow-mo, PNG sequence), supersampling |

Keys: Space play/pause · R new seed · Shift+R randomize params · ←/→ seed · ,/. step one frame · S still · V video · P snapshot · Z 100% view · F frame-exact.

Console: `ribbons.preset('Ink meander + wash')`, `ribbons.set({ layout: 'rows', pinches: 8 })`.

## Notes

- **Speed:** opaque ribbons cost more than translucent lines. Headless software rendering measured about 300 ms per frame at 1080×1350 for the default tangle, and less on a real GPU. If the preview is slow, lower the preview scale, the ribbons or the lines per ribbon. Use frame-exact (F) to watch the motion at true speed, and exports are frame-exact anyway.
- **Stills:** large stills are rendered in tiles of at most 2048 px and streamed to a PNG.
- **Video:** the paper and backdrop do not move, so line art compresses well: 30 Mbps is clean at 1080 wide. For the best quality, export a PNG sequence and use the ffmpeg command saved with it.
- **Colour fields:** choosing a palette loads its colours into the colour fields. Edit them freely after that; they are saved in the params JSON.
