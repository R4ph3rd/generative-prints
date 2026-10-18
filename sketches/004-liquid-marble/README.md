# 004 · Liquid Marble

Psychedelic liquid marbling: bold flat bands of colour fold and swirl like poured paint, edged with thin bright lines and chromatic pink/cyan fringes, under heavy risograph grain. It loops seamlessly and ships with 13 palettes.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/004-liquid-marble/. It needs WebGL2.

## How it works

1. **Scene** (`scene.js`): a seed picks a palette (13 built-in, or random by seed) and optionally shuffles the band order, then builds 32 seeded phases for the noise offsets and directions. The palette colours are converted to linear RGB. Only `seed`, `palette` and `colorOrder` rebuild the scene; all other params are read live at draw time.
2. **Renderer** (`marble-gl.js`, raw WebGL2): one full-screen fragment shader. The fluid is built by advection, not nested fbm warping. Each warp pass moves the sample point in 4 small steps along a smooth 3D simplex velocity field, and swirl rotates that field. The bands therefore stretch into filaments without folding over. Every noise call returns an exact analytic gradient, so band anti-aliasing and line/fringe widths are resolution-independent: they are the same across tiles, crops and supersampling, with no `fwidth`. The seamless loop comes from sampling noise along circles with an integer number of turns per loop. A tanh curve evens out how much area each colour band gets. Each band boundary gets a bright line, pink/cyan fringes offset to either side (an RGB misregistration look) and a glow. The grain is hashed riso-like speckle on an absolute grid sized in short-side units, so it scales with print size. It can re-randomize 24 times per loop second.
   Every pixel is a pure function of normalized position (short side = 1), time, params and seed, so the preview, the 100% view, tiled stills and video frames agree. Measured: `check=1` in `dev.html` gives zero seam and zero loop difference.
3. **Sketch** (`sketch.js`): UI, live loop, still and video export.

`dev.html` is the renderer dev harness (no UI, query-string params, seam and loop checks): `dev.html?t=3.5&palette=lagoon&check=1`.

**p5 is not used.** The renderer owns a WebGL2 canvas that is shown directly in the page, so live frames never go through `readPixels`/`putImageData`; a plain `requestAnimationFrame` loop is all that is needed.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, randomize params, reset, resolved palette |
| Fluid | scale, warp, warp passes, detail, roughness, stretch, angle, swirl, zoom, pan x / y |
| Colour | palette (or random by seed), colour order (palette or shuffle), bands, band sharpness, colour offset, hue shift, saturation, contrast, exposure |
| Lines | lines, line width, fringe, fringe width, glow |
| Texture | grain, grain size, grain colour, animate grain, vignette |
| Motion | play/pause, time slider (0 to loop seconds), speed, loop seconds, flow, preview scale, preview frame (paper or video aspect) |
| Still export | paper, orientation, custom size, DPI, supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | size, fps, loops, bitrate, format, supersampling (1/2), export, cancel, progress |
| Preview | *fit* or *100%* |

`speed` only changes how fast time advances in the page, not the shader frequencies. `flow` sets how far the noise circles travel. Exports play at 1× so the loop length is always `loop seconds`. Randomize params draws from ranges tuned for this look, so random results stay in the marbled style.

### Shortcuts

- `Space`: play / pause
- `R`: new random seed, `Shift+R`: randomize params, `←` / `→`: previous / next seed
- `,` / `.`: step one frame (1/30 s) back / forward while paused
- `S`: export still, `V`: export video, `P`: quick snapshot
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back. The 100% view keeps animating.

The URL hash holds the seed and time (`#seed=1234&t=3.25`). Console: `marble.set({ palette: 'sunset', seed: 7 })`, `marble.exportStill()`, `marble.exportVideo()`, `marble.snapshot()`, `marble.randomize()`, `marble.reset()`.

## Still export

Freezes the current time (playback pauses during export and resumes after) and renders the paper size at the chosen DPI in tiles through `lib/poster-export.js`, supersampled by `stillSS`. The file is a 24-bit RGB PNG with the DPI in `pHYs` and all params in the `tEXt` Comment chunk, named like `liquid-marble_seed-1234_t-3.25_A2_300dpi.png`. *Quick snapshot* saves the current preview canvas as it is on screen.

## Video export

- **MP4** (default): offline and frame-exact via WebCodecs, H.264 muxed with mp4-muxer (`lib/video-export.js`). Each frame is rendered at `t = i / fps`, however slowly, so a slow machine still yields a smooth file. If the browser has no H.264 encoder it falls back to WebM/VP9; with no WebCodecs at all it records WebM in real time.
- **WebM** (real time): MediaRecorder captures the canvas while it plays from t = 0. A machine that cannot hold the frame rate drops frames.
- **Seamless loops**: duration = loops × loop seconds, frames = round(fps × duration), times `0 … (n-1)/fps`. The frame at `t = duration` would equal frame 0 and is never rendered.
- **Even sizes**: H.264 needs even width and height; all presets are even.
- The progress line shows `frame i/n`, the codec chosen, elapsed time and ETA; the output readout shows duration, frame count and estimated size. Playback pauses during export and the canvas CSS size stays fixed.

## Known limitations

- The shader does about 1.3× the work per pixel of 003 (about 21 noise evaluations per sample), so 4K video at 2× supersampling is slow offline, and big WebGL canvases may hit GPU limits on weak hardware.
- Real-time WebM depends on the GPU keeping up; use MP4 for anything you publish.
- A 4× A2 still at 300 dpi is a long render (about 35 MP, 4 samples each, in 2048 px tiles).
- Preview at low preview scale is softer than the exports; use the 100% view to judge the fine lines and fringes.
- Time in the URL hash is only a start offset; playback is not paused on load.
