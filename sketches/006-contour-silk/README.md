# 006 · Contour Silk

Hundreds of hairline contour lines on deep indigo, sweeping through the field in curves and closed loops. Where the lines bunch up they brighten into white and then peach and orange, like the creases of folded silk, and a few empty flat ribbons meander through the picture. It loops seamlessly and ships with 9 palettes.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/006-contour-silk/. It needs WebGL2.

## How it works

1. **Scene** (`scene.js`): a seed picks a palette (9 built-in, or random by seed) and builds the 32 seeded phases for the noise offsets and directions. The ground, ribbon, line and density-ramp colours are converted to linear RGB. Only `seed` and `palette` rebuild the scene; all other params are read live at draw time.
2. **Renderer** (`contour-gl.js`, raw WebGL2): one full-screen fragment shader, no extra passes. A height field is built the same way as in 004: the sample point is advected in small steps along a smooth noise velocity field (`warp`, `warpIterations`), with an optional stretch and angle. Lines are the level sets of that field, so the spacing is set by how fast the field changes. Line count is given in short-side units, so a poster and a screen show the same picture. Where the lines are denser than a pixel, the line pattern is averaged to its coverage instead of aliasing, which keeps the tone right at any size. Dense bundles brighten through the density ramp (cool, white, then warm) and a soft glow follows a lower density threshold. Ribbons are flat fills with a hairline crease along their edge.
   The seamless loop comes from periodic noise circles, so the field returns to itself after `loop seconds`. Every pixel is a pure function of normalized position (short side = 1), time, params and seed, so the preview, the 100% view, tiled stills and video frames agree. Measured: `check=1` in `dev.html` gives zero seam and zero loop difference.
3. **Sketch** (`sketch.js`): UI, live loop, still and video export.

`dev.html` is the renderer dev harness (no UI, query-string params, seam and loop checks, and the line-density distribution): `dev.html?t=3.5&palette=mint&check=1`.

**p5 is not used.** The renderer owns a WebGL2 canvas that is shown directly in the page, so live frames never go through `readPixels`/`putImageData`; a plain `requestAnimationFrame` loop is all that is needed.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, randomize params, reset, resolved palette |
| Field | scale, warp, warp passes, stretch, angle, zoom, pan x / y |
| Lines | line count, line width, line opacity, line jitter, line families (1 or 2) |
| Density | density gain, warmth, glow |
| Ribbons | ribbons, ribbon width, ribbon edge |
| Colour | palette (or random by seed), hue shift, saturation, contrast, exposure, grain |
| Motion | play/pause, time slider (0 to loop seconds), speed, frame-exact (slow-mo), loop seconds, flow, preview scale, preview frame (paper or video aspect) |
| Still export | paper, orientation, custom size, DPI, supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | size, fps, loops, bitrate, format, supersampling (1/2), export, cancel, progress |
| Preview | *fit* or *100%* |

`speed` only changes how fast time advances in the page, not the field frequencies. **Frame-exact (slow-mo)** advances time by exactly `speed / video fps` per drawn frame instead of by the wall clock, so a GPU that cannot hold the frame rate shows every frame and just plays slower (never faster than real time). The status line shows the rendered fps and the real-time ratio, e.g. `frame-exact · 8 fps rendered · x0.27 real-time`. `flow` sets how far the noise circles travel. Exports play at 1× so the loop length is always `loop seconds`. Randomize params draws from ranges tuned for this look, so random results stay in the silk style. Line count is in short-side units, so changing the export size does not change the look.

### Shortcuts

- `Space`: play / pause
- `R`: new random seed, `Shift+R`: randomize params, `←` / `→`: previous / next seed
- `,` / `.`: step one frame (1/30 s) back / forward while paused
- `F`: toggle frame-exact playback
- `S`: export still, `V`: export video, `P`: quick snapshot
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back. The 100% view keeps animating.

The URL hash holds the seed and time (`#seed=1234&t=3.25`). Console: `contour.set({ palette: 'sunset', seed: 7 })`, `contour.exportStill()`, `contour.exportVideo()`, `contour.snapshot()`, `contour.randomize()`, `contour.reset()`. `contour.P` holds the live params.

## Still export

Freezes the current time (playback pauses during export and resumes after) and renders the paper size at the chosen DPI in tiles through `lib/poster-export.js`, supersampled by `stillSS`. The file is a 24-bit RGB PNG with the DPI in `pHYs` and all params in the `tEXt` Comment chunk, named like `contour-silk_seed-1234_t-3.25_A2_300dpi.png`. *Quick snapshot* saves the current preview canvas as it is on screen.

## Video export

- **MP4** (default): offline and frame-exact via WebCodecs, H.264 muxed with mp4-muxer (`lib/video-export.js`). Each frame is rendered at `t = i / fps`, however slowly, so a slow machine still yields a smooth file. If the browser has no H.264 encoder it falls back to WebM/VP9; with no WebCodecs at all it records WebM in real time.
- **WebM (real-time)**: MediaRecorder captures the canvas while it plays from t = 0. A machine that cannot hold the frame rate drops frames.
- **WebM slow-mo (speed up after)**: for a GPU that is too slow for real time but where you want a WebM without WebCodecs. Frame i is rendered at `t = i / fps` and pushed to MediaRecorder on a fixed wall-clock slot (`captureStream(0)` + `requestFrame()`, or `captureStream(fps/k)` where that is missing). The export times 5 frames first and picks an integer slow-down `k` (render time × 1.5 + 20 ms per slot). The file is `k` times too slow and named `…_slow-xK.webm`; the output readout and status show the exact fix: `ffmpeg -i in.webm -filter:v "setpts=PTS/K" -r 30 out.mp4`. Capture takes `k` × the video length in real time.
- **PNG sequence (frame-exact)**: offline like MP4 (frame i at `t = i / fps`, video size, `videoSS`), each frame PNG-encoded as `frame_00000.png`, … plus `ffmpeg.txt` with `ffmpeg -framerate 30 -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 16 out.mp4`. In Chrome/Edge it asks once for a folder and streams the files into a sub-folder named like the video file (low memory). Elsewhere it builds a store-only ZIP in memory (`lib/frame-sequence.js`) and downloads it; above 2 GB it warns, and ZIP64 is not supported (4 GiB / 65535 files max). Expect about 1.5 bytes per pixel per frame on the smooth line art, more with grain.
- **Seamless loops**: duration = loops × loop seconds, frames = round(fps × duration), times `0 … (n-1)/fps`. The frame at `t = duration` would equal frame 0 and is never rendered.
- **Video names**: `contour-silk_seed-1234_1920x1080_30fps_20s.mp4` (the size, fps and length are in the name).
- **Even sizes**: H.264 needs even width and height; all presets are even.
- The progress line shows `frame i/n`, the codec chosen, elapsed time and ETA; the output readout shows duration, frame count and estimated size. Playback pauses during export and the canvas CSS size stays fixed.

## Known limitations

- Broad compression zones, where the field squeezes many lines into a small area, can give large soft white areas. Lower `glow`, `densityGain` or `warp` to tame them.
- The ribbon edge crease is subtle at the default `ribbonEdge` (0.6). Raise it if the ribbons should read more clearly.
- The default line density (`lineCount` 160 per short side) can be high on small screens. Lower it for a calmer picture; the look scales with print size either way.
- 4K video at 2× supersampling is slow offline, and big WebGL canvases may hit GPU limits on weak hardware.
- Real-time WebM depends on the GPU keeping up; use MP4, WebM slow-mo or a PNG sequence for anything you publish. Slow-mo timing assumes the VP9 encoder keeps up with the slot; if frames still drop, lower the size or supersampling (console: `contour.exportVideo({ format: "webm-slow", slowdown: 20 })` forces the factor).
- The renderer accepts dev-only tuning knobs through `dev.html` query params (`dbgRamp`, `dbgAmp`, `dbgCliff`, `dbgStairs`, `dbgSwirl`, `dbgDensRef`, `dbgWarpK` and others). They are not in the sketch UI.
- Preview at low preview scale is softer than the exports; use the 100% view to judge the hairlines.
- Time in the URL hash is only a start offset; playback is not paused on load.
