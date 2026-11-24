# 008 · Oil Film

An iridescent thin-film / oil-slick fluid. A smooth "film thickness" field is domain-warped into flowing silk-like folds with occasional sharp creases, and runs through a continuous cyclic colour ramp: deep navy plateaus, then saturated blue, cyan / green, lavender, orange and dark red-brown, then back to dark. Bands pack tightly where the film is steep and open into wide dark plateaus where it is flat. The folds ripple and wobble in place while the whole film slowly slides down towards the bottom-right, like liquid sliding down a surface. It loops seamlessly, defaults to a 9:16 portrait frame, and ships with 7 palettes (every colour editable) and 5 looks.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/008-oil-film/. It needs WebGL2.

## How it works

1. **Params** (`params.js`): `DEFAULTS`, the one-click `PRESETS` and `paletteColors()`, shared by `sketch.js` and `dev.html`.
2. **Scene** (`scene.js`): the palette presets (cyclic ramps, colour 0 is the plateau colour) and the 32 seeded phases for the noise offsets and loop-circle directions. Only `seed` rebuilds the scene. Colours are params (`colorCount`, `c0`…`c7`), so editing a slot is live.
3. **Renderer** (`oil-gl.js`, raw WebGL2): one full-screen fragment shader, no extra passes.
   - **Field**: iq's nested fbm warp, `h = fbm(x + k·w)`, `w = fbm2(x + k·fbm2(x + …))` with 1–3 levels (`warpIterations`). The innermost warp is folded with a softened `|·|` (`creaseSoft`). The fold blends a symmetric ridge `2(|w| − c)` with a one-sided drape fold `|w| + w − c` (`creaseAsym`). The one-sided fold is flat on one side and steep on the other, so at a crease the bands bunch up on one side and grade smoothly on the other. A gentle linear slope across the warped field (`sweep`) leaves the thickness with few closed extrema, so the bands run as long S-folds instead of rings. A camera matrix handles scale, anisotropic stretch along `angle`, zoom and pan.
   - **Exact gradients**: every simplex-noise call returns its analytic gradient, and the warp Jacobians are chained, so `|∇h|` per short side is exact. There is no `dFdx`, so the result is identical across tiles, crops and supersampling. A second Jacobian chain ignores the fold's sign flip and gives a "steepness" that stays smooth across creases.
   - **Colour**: `s = h · rampFreq + rampPhase`. In each cycle the first `plateau` fraction holds colour 0, and the rest runs through a closed Catmull-Rom spline over the colour slots, interpolated in sRGB so dark-to-bright falls off evenly. There are no hard bands and no flat steps at the slots. Flat film is pulled towards colour 0 (`gradInfluence`), so flat areas read as dark plateaus and steep areas as packed bands. Bands thinner than a pixel fade to the mean ramp colour (the analytic band frequency) instead of aliasing. `gloss` adds a Blinn-Phong highlight from a fake normal built from `∇h`.
   - **Drift (seamless)**: each noise octave of each field is made periodic along the drift axis by wrapping that axis onto a cylinder in the 3D noise volume: `n = snoise(R cos(u/R − φ), R sin(u/R − φ), v)`, where `R = period / 2π`, `u` runs along the drift and `v` across it. Arc length equals `u`, so the scale stays isotropic. Each layer slides a whole number `k` of its periods per loop (`φ` advances `k` full turns), so `t = 0` and `t = loopSeconds` are bit-identical. The renderer derives the periods from `drift × loopSeconds`, using the largest `k` that keeps the thickness field's periods at least 1.2× the frame's extent along the drift, so no repetition shows inside the frame. The warp fields only displace the thickness, and a repeat in a displacement does not show, so they may use 0.6×. That lets them drift slower, at about 0.55–0.65 of the thickness field's speed with ±5% per field: the surface slides while the folds lag behind. Each finer octave runs `detailSpeed` times faster than the one before (default 1.1, nearly uniform). Gradients stay exact by the chain rule (`d/du = (r/R)(−g.x sin + g.y cos)`, `d/dv = g.z`).
   - **Churn** (`flow`, default 1.0): the pre-drift wobble and the dominant local motion. Per octave there is a loop-periodic circle with integer cycles per loop. In the plane it shifts (`u`, `v`) along a seeded direction; a shift in `u` keeps the period. Out of the plane it moves the cylinder radius, i.e. off the noise sheet, which stands in for the old z offset. It has the same radii and phases as before the drift was added. `churn 0` gives pure drift.
   - **Elongation**: the camera squashes the frequency along the drift direction, so forms stretch along the flow (default 0.2, subtle). `stretch` and `angle` remain as an extra, free anisotropy.
   - **Too-short loops**: if `drift × loopSeconds` is shorter than one minimal period, a layer cannot travel a whole period at the requested speed. It then travels one minimal period per loop, which is faster than asked. The **drift** readout in Motion says so and suggests a loop length. The video plan note does the same when the export loop is resized.
   - Every pixel is a pure function of normalized position (short side = 1), time, params and seed, so the preview, the 100% view, tiled stills and video frames agree. Measured with `check=1` in `dev.html`: zero seam difference, zero loop difference, and draw and renderRegion match.
4. **Sketch** (`sketch.js`): UI, live loop, still and video export (same code paths as 006).

`dev.html` is the renderer dev harness (no UI, query-string params, seam and loop checks, `|∇h|` distribution, timing). Debug views: `debug=1` thickness, `debug=2` steepness, `debug=3` crease mask, `debug=4` one ramp cycle. Example: `dev.html?preset=Silk%20folds&t=3.5&check=1`, or `dev.html?palette=ember&seed=7&ss=2`. Colour slots can be set without `#`, e.g. `c1=0a3cff`.

**p5 is not used.** The renderer owns a WebGL2 canvas that is shown directly in the page, and a plain `requestAnimationFrame` loop drives it.

## Controls

| Folder | What |
|---|---|
| Seed & presets | seed, randomize, randomize params, reset, presets (Oil slick, Silk folds, Soft holo, Ember crease, Aurora drift) |
| Field | scale, warp (k), warp nesting (1–3), octaves, crease (fold), crease softness, crease one-sided, sweep, elongation (along the drift), stretch, angle, zoom, pan x / y |
| Film & colour | ramp frequency, ramp offset, gradient influence, dark plateau, gloss / sheen, hue shift, saturation, contrast, exposure, grain, vignette |
| Palette | palette (Oil slick, Holo pastel, Ember, Aurora, Pearl, Mono chrome, Petrol, or random by seed), resolved name, colour count (2–8), colour pickers c0…c7 (c0 = plateau colour) |
| Motion | play/pause, time slider, speed, frame-exact (slow-mo), loop seconds (default 30), drift angle (default 55°: clockwise from screen +x, so towards the bottom-right), drift (default 0.085 short sides per second of sketch time), detail speed-up (default 1.1 per octave), churn (= `flow`, default 1.0), drift readout, preview scale, preview frame (paper or video aspect; default video, 9:16) |
| Still export | paper (default 9:16 portrait), orientation, custom size, DPI, supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | size (1080×1920 default, 1080×1350, 1080×1080, 2160×3840, 2160×2700, 1920×1080, 4K), fps, length (s), fit, loops (readout), bitrate, format (MP4 / WebM real-time / WebM slow-mo / PNG sequence), supersampling (1/2), export, cancel, progress |
| Preview | *fit* or *100%* |

Choosing a palette loads its colours into the slots. Edit any slot afterwards for a custom ramp; your edits stay until you pick another palette. With *Random (by seed)* the slots reload whenever the seed changes. The ramp is cyclic, so order the slots as a loop that starts and ends near the plateau colour.

`speed` sets how fast time advances, both in the page and in video exports, so videos move like the preview. Speed 0 exports the current frame held still for the chosen length. **Frame-exact (slow-mo)** advances time by exactly `speed / video fps` per drawn frame, previewing the export frame by frame. Randomize params draws from ranges tuned for this look.

### Shortcuts

- `Space`: play / pause
- `R`: new random seed, `Shift+R`: randomize params, `←` / `→`: previous / next seed
- `,` / `.`: step one frame (1/30 s) back / forward while paused
- `F`: toggle frame-exact playback
- `S`: export still, `V`: export video, `P`: quick snapshot
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back.

The URL hash holds the seed and time (`#seed=12&t=3.25`). Console: `oil.set({ palette: 'ember', seed: 7 })`, `oil.preset('Silk folds')`, `oil.exportStill()`, `oil.exportVideo()`, `oil.snapshot()`, `oil.randomize()`, `oil.reset()`. `oil.P` holds the live params.

## Still export

This works as in 006. The export freezes the current time and renders the paper size at the chosen DPI in tiles through `lib/poster-export.js`, supersampled by `stillSS`. The output is a 24-bit RGB PNG with the DPI and all params embedded, named like `oil-film_seed-12_t-3.25_9x16_300dpi.png`.

## Video export

This works as in 006: MP4 (offline, frame-exact, WebCodecs + mp4-muxer, with a WebM fallback), real-time WebM, WebM slow-mo (with the ffmpeg speed-up command shown afterwards), or a PNG sequence (a folder in Chrome/Edge, otherwise a ZIP, plus `ffmpeg.txt`). **Length.** Set `length s` to the video length you want, at any speed. A video is always a whole number of loops, so it loops seamlessly. One loop lasts `loop seconds / speed` of video. `fit` decides how the length is reached:

| fit | length | motion speed | how |
|---|---|---|---|
| exact length, keep speed (default) | exact | as in the preview | The export uses its own loop period `L' = length × speed / n` (n = the whole loop count nearest to `length × speed / loop seconds`, at least 1) and scales the churn (`flow`) by `L' / loop seconds`. Drift is a velocity, so it keeps its speed by itself. Only the layer periods are re-derived for `L'`, so frames differ slightly from the preview. If `L'` is too short for the drift, the big folds speed up and the plan note shows the factor, e.g. `drift x1.27 (loop 20.0 s too short)`. |
| keep speed + loop | approximate (nearest whole loops, at least 1) | as in the preview | Frames match the preview exactly. A slow speed with a short length can overshoot a lot (speed 0.3, 20 s loop: one loop is 67 s). |
| exact length, keep loop | exact | nudged to `n × loop seconds / length` | Frames match the preview's path; only the pace changes. |

The `loops` readout under it shows the plan, e.g. `1 loop · loop 30 → 4.50 s, churn ×0.15`. With N = round(fps × length) frames, frame i is rendered at loop phase `(i × n mod N) / N`, so frame N would land exactly on frame 0. Names look like `oil-film_seed-12_1080x1920_30fps_20s.mp4`.

## Known limitations

- It is not a fluid simulation. The folds come from a warped noise field that drifts layer by layer, so the motion is not true advection (nothing is conserved), and the creases are folds in the warp, not physically overlapping sheets.
- Short loops with drift: with the defaults (drift 0.085, 9:16), one minimal period of the thickness field needs about 29.6 s of loop; the default is 30 s. Shorter loops, or exports whose `L'` is shorter, make the big folds drift faster than asked (×1.14 at 26 s, ×6.6 at 4.5 s); the readouts say so. Raise the loop length or the drift.
- The periods depend on the image aspect, which is part of the frame extent. A preview at paper aspect and an export at another aspect can therefore drift with slightly different periods.
- Closed rings or eyes (extremes of the thickness) show up on some seeds. The default seed 12 has none across the loop, but changing the seed or a look can bring them back; lower `warp` or `elongation` to reduce them.
- How much of each colour shows depends on the seed's thickness range. Some seeds come out darker or warmer than others; nudge `ramp offset` or `ramp frequency`.
- High `warp` (above ~1.5) with 3 nesting levels turns turbulent. Bands then go sub-pixel and fade to the mean ramp colour, a greyish mush. Lower warp or nesting for silk.
- At `crease` near 1 with low softness, a few creases show thin dark hairlines where the ramp passes through its plateau.
- The cost is about 11 simplex evaluations per sample at the defaults (2 warp levels), more with 4+ octaves. 4K at 2× supersampling is slow offline.
- The renderer also accepts dev-only knobs through `dev.html` (`dbgWOct` warp octaves, `dbgGain` fbm gain). They are not in the UI.
