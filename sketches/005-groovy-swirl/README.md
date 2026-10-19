# 005 · Groovy Swirl

Retro 70s flat-vector fluid: big flowing streams of flat colour with rounded droplets drifting inside them, a tight spiral vortex and constant-width thin dark outlines on every boundary. No gradients, no texture by default. It loops seamlessly and ships with 11 palettes.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/005-groovy-swirl/. It needs WebGL2.

## How it works

1. **Scene** (`scene.js`): a seed picks a palette (11 built-in, or random by seed) and optionally shuffles the colour order, then places up to 4 vortex centres (the first one biased to the lower right) and 32 seeded phases for the noise offsets and directions. Region and blob colours are converted to linear RGB. Only `seed`, `palette` and `colorOrder` rebuild the scene; all other params are read live at draw time.
2. **Renderer** (`groovy-gl.js`, raw WebGL2): one full-screen fragment shader. Each sample first passes through the vortices, which twist the domain around their centres with a log-spiral angle. That map cannot fold, so the streams wind in without crossing over. The domain is then advected in small steps along a smooth noise velocity field (the same advection idea as 004). Region colour comes from a tanh-shaped band index over a 2-octave fbm, plus spiral waves that carry several colours into the centre as the vortex turns. Droplets are Worley-style cells stretched along the flow, drawn as discs with noise lobes that never overlap and never touch region edges. Every boundary distance is the field value divided by its exact gradient, so the outline has a constant width (in short-side units) and the same anti-aliasing at every resolution, tile and supersampling level. The seamless loop comes from periodic noise circles, a whole number of droplet drift periods per loop and a vortex spin that is periodic in the loop phase.
   Every pixel is a pure function of normalized position (short side = 1), time, params and seed, so the preview, the 100% view, tiled stills and video frames agree. Measured: `check=1` in `dev.html` gives zero seam and zero loop difference.
3. **Sketch** (`sketch.js`): UI, live loop, still and video export.

`dev.html` is the renderer dev harness (no UI, query-string params, seam and loop checks): `dev.html?t=3.5&palette=ocean&check=1`.

**p5 is not used.** The renderer owns a WebGL2 canvas that is shown directly in the page, so live frames never go through `readPixels`/`putImageData`; a plain `requestAnimationFrame` loop is all that is needed.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, randomize params, reset, resolved palette |
| Flow | scale, flow warp, warp passes, stretch, angle, vortices, vortex strength, vortex size, zoom, pan x / y |
| Regions & blobs | region bands, colour offset, blobs, blob scale, blob stretch, blob roundness |
| Colour | palette (or random by seed), colour order (palette or shuffle), hue shift, saturation, contrast, exposure |
| Outline & texture | outline, outline width, grain, paper tint |
| Motion | play/pause, time slider (0 to loop seconds), speed, frame-exact (slow-mo), loop seconds, flow, vortex spin (turns per loop), preview scale, preview frame (paper or video aspect) |
| Still export | paper, orientation, custom size, DPI, supersampling (1/2/4), export, quick snapshot, cancel, save/load params JSON |
| Video export | size, fps, loops, bitrate, format, supersampling (1/2), export, cancel, progress |
| Preview | *fit* or *100%* |

`speed` only changes how fast time advances in the page, not the shader frequencies. **Frame-exact (slow-mo)** advances time by exactly `speed / video fps` per drawn frame instead of by the wall clock, so a GPU that cannot hold the frame rate shows every frame and just plays slower (never faster than real time). The status line shows the rendered fps and the real-time ratio, e.g. `frame-exact · 8 fps rendered · x0.27 real-time`. `flow` sets how far the noise circles travel, and `vortex spin` sets how many turns the spiral arms make per loop. Exports play at 1× so the loop length is always `loop seconds`. Randomize params draws from ranges tuned for this look, so random results stay in the retro style.

### Shortcuts

- `Space`: play / pause
- `R`: new random seed, `Shift+R`: randomize params, `←` / `→`: previous / next seed
- `,` / `.`: step one frame (1/30 s) back / forward while paused
- `F`: toggle frame-exact playback
- `S`: export still, `V`: export video, `P`: quick snapshot
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back. The 100% view keeps animating.

The URL hash holds the seed and time (`#seed=1234&t=3.25`). Console: `groovy.set({ palette: 'ocean', seed: 7 })`, `groovy.exportStill()`, `groovy.exportVideo()`, `groovy.snapshot()`, `groovy.randomize()`, `groovy.reset()`. `groovy.P` holds the live params.

## Still export

Freezes the current time (playback pauses during export and resumes after) and renders the paper size at the chosen DPI in tiles through `lib/poster-export.js`, supersampled by `stillSS`. The file is a 24-bit RGB PNG with the DPI in `pHYs` and all params in the `tEXt` Comment chunk, named like `groovy-swirl_seed-1234_t-3.25_A2_300dpi.png`. *Quick snapshot* saves the current preview canvas as it is on screen.

## Video export

- **MP4** (default): offline and frame-exact via WebCodecs, H.264 muxed with mp4-muxer (`lib/video-export.js`). Each frame is rendered at `t = i / fps`, however slowly, so a slow machine still yields a smooth file. If the browser has no H.264 encoder it falls back to WebM/VP9; with no WebCodecs at all it records WebM in real time.
- **WebM (real-time)**: MediaRecorder captures the canvas while it plays from t = 0. A machine that cannot hold the frame rate drops frames.
- **WebM slow-mo (speed up after)**: for a GPU that is too slow for real time but where you want a WebM without WebCodecs. Frame i is rendered at `t = i / fps` and pushed to MediaRecorder on a fixed wall-clock slot (`captureStream(0)` + `requestFrame()`, or `captureStream(fps/k)` where that is missing). The export times 5 frames first and picks an integer slow-down `k` (render time × 1.5 + 20 ms per slot). The file is `k` times too slow and named `…_slow-xK.webm`; the output readout and status show the exact fix: `ffmpeg -i in.webm -filter:v "setpts=PTS/K" -r 30 out.mp4`. Capture takes `k` × the video length in real time.
- **PNG sequence (frame-exact)**: offline like MP4 (frame i at `t = i / fps`, video size, `videoSS`), each frame PNG-encoded as `frame_00000.png`, … plus `ffmpeg.txt` with `ffmpeg -framerate 30 -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 16 out.mp4`. In Chrome/Edge it asks once for a folder and streams the files into a sub-folder named like the video file (low memory). Elsewhere it builds a store-only ZIP in memory (`lib/frame-sequence.js`) and downloads it; above 2 GB it warns, and ZIP64 is not supported (4 GiB / 65535 files max). Expect about 2.8 bytes per pixel per frame on the flat look, more with grain.
- **Seamless loops**: duration = loops × loop seconds, frames = round(fps × duration), times `0 … (n-1)/fps`. The frame at `t = duration` would equal frame 0 and is never rendered.
- **Video names**: `groovy-swirl_seed-1234_1080x1920_30fps_20s.mp4` (the size, fps and length are in the name).
- **Even sizes**: H.264 needs even width and height; all presets are even.
- The progress line shows `frame i/n`, the codec chosen, elapsed time and ETA; the output readout shows duration, frame count and estimated size. Playback pauses during export and the canvas CSS size stays fixed.

## Known limitations

- Droplets are sparser than in dense reference illustrations at the default `blobs` (0.55). Raise `blobs` (up to 1) for a busier droplet field.
- The vortex centre fades to an average colour where the bands get thinner than a pixel. Judge the core in the 100% view or in a larger still.
- The shader does about 19 noise evaluations and a 3×3 cell search per sample, so 4K video at 2× supersampling is slow offline, and big WebGL canvases may hit GPU limits on weak hardware.
- Real-time WebM depends on the GPU keeping up; use MP4, WebM slow-mo or a PNG sequence for anything you publish. Slow-mo timing assumes the VP9 encoder keeps up with the slot; if frames still drop, lower the size or supersampling (console: `groovy.exportVideo({ format: "webm-slow", slowdown: 20 })` forces the factor).
- A 4× A2 still at 300 dpi is a long render, in 2048 px tiles.
- Preview at low preview scale is softer than the exports; use the 100% view to judge the fine outlines.
- The renderer accepts some dev-only tuning knobs through `dev.html` query params (`tk`, `bf`, `wk`, `bfq`, `vk`, `wr`, `wa`, `vc`, `rk`). They are not in the sketch UI, and their defaults are the look described here.
- Time in the URL hash is only a start offset; playback is not paused on load.
