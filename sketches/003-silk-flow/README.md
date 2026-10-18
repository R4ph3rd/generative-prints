# 003 · Silk Flow

Slow, animated fluid silk: wide luminous ribbons sweep across a pale lavender field, fold and twist so the front and back faces show different colours, and drift in a loop that repeats seamlessly. Inspired by field.io's fluid motion work.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/003-silk-flow/. It needs WebGL2.

## How it works

1. **Scene** (`scene.js`): a seed builds a palette LUT (front, back and accent colour ramps, dark to light, in OKLab), per-ribbon shape data, a few thin satellite strands and the shared domain-warp phases. Every time-dependent term uses an integer number of cycles per loop. Only `seed`, `ribbons`, `strands` and `palette` rebuild the scene; all other params are read live at draw time.
2. **Renderer** (`silk-gl.js`, raw WebGL2): one full-screen fragment shader. Per pixel it applies a camera and a fluid domain warp, then for each ribbon (far to near) evaluates a twisted, cupped strip. Where the strip turns edge-on it folds over itself, giving up to two visible layers with a front or back face each. Shading is a gradient-mapped lighting ramp, specular sheen, fresnel, edge rim, fibre striations along the ribbon and a chromatic outer glow. Depth of field is analytic (a per-ribbon blur radius widens edges, fades detail and spreads glow). The result is composited in linear light, encoded to sRGB, with film grain and dither.
   Every pixel is a pure function of normalized position (short side = 1), time, params and seed, so the preview, the 100% view, tiled stills and video frames agree.
3. **Sketch** (`sketch.js`): UI, live loop, still and video export.

`dev.html` is the renderer dev harness (no UI, query-string params, seam and loop checks): `dev.html?t=3.5&palette=glacier&check=1`.

**p5 is not used.** The renderer owns a WebGL2 canvas that is shown directly in the page, so live frames never go through `readPixels`/`putImageData`; a plain `requestAnimationFrame` loop is all that is needed.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, randomize params, reset, resolved palette |
| Composition | ribbons, strands, ribbon width and variance, spread, angle, curvature, twist, curl (cross-section cupping), warp and scale, zoom, pan |
| Look | palette (or random by seed), hue shift, saturation, exposure, background, streaks and scale, sheen, rim, glow, depth of field and focus, softness, grain |
| Motion | play/pause, time slider (0 to loop seconds), speed, loop seconds, preview scale, preview frame (paper or video aspect) |
| Still export | paper, orientation, custom size, DPI, supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | size, fps, loops, bitrate, format, supersampling (1/2), export, cancel, progress |
| Preview | *fit* or *100%* |

`speed` only changes how fast time advances in the page, not the shader frequencies. Exports play at 1× so the loop length is always `loop seconds`.

### Shortcuts

- `Space`: play / pause
- `R`: new random seed, `Shift+R`: randomize params, `←` / `→`: previous / next seed
- `,` / `.`: step one frame (1/30 s) back / forward while paused
- `S`: export still, `V`: export video, `P`: quick snapshot
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back. The 100% view keeps animating.

The URL hash holds the seed and time (`#seed=1234&t=3.25`). Console: `silk.set({ palette: 'glacier', seed: 7 })`, `silk.exportStill()`, `silk.exportVideo()`.

## Still export

Freezes the current time (playback pauses during export and resumes after) and renders the paper size at the chosen DPI in tiles through `lib/poster-export.js`, supersampled by `stillSS`. The file is a 24-bit RGB PNG with the DPI in `pHYs` and all params in the `tEXt` Comment chunk, named like `silk-flow_seed-1234_t-3.25_A2_300dpi.png`. *Quick snapshot* saves the current preview canvas as it is on screen.

## Video export

- **MP4** (default): offline and frame-exact via WebCodecs, H.264 muxed with mp4-muxer (`lib/video-export.js`). Each frame is rendered at `t = i / fps`, however slowly, so a slow machine still yields a smooth file. If the browser has no H.264 encoder it falls back to WebM/VP9; with no WebCodecs at all it records WebM in real time.
- **WebM** (real time): MediaRecorder captures the canvas while it plays from t = 0. A machine that cannot hold the frame rate drops frames.
- **Seamless loops**: duration = loops × loop seconds, frames = round(fps × duration), times `0 … (n-1)/fps`. The frame at `t = duration` would equal frame 0 and is never rendered.
- **Even sizes**: H.264 needs even width and height; all presets are even.
- The progress line shows `frame i/n`, the codec chosen, elapsed time and ETA; the output readout shows duration, frame count and estimated size. Playback pauses during export and the canvas CSS size stays fixed.

## Known limitations

- 4K video at 2× supersampling is slow offline, and big WebGL canvases may hit GPU limits on weak hardware.
- Real-time WebM depends on the GPU keeping up; use MP4 for anything you publish.
- A 4× A2 still at 300 dpi is a long render (about 35 MP, 4 samples each, in 2048 px tiles).
- Preview at low preview scale is softer than the exports; use the 100% view to judge detail.
- Time in the URL hash is only a start offset; playback is not paused on load.
