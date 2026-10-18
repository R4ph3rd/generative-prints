# 001 · Stipple Shards

Strictly 1-bit stippled compositions, in the spirit of Matt DesLauriers' stipple prints:

- **Slabs**: a few large planar sheets of light in perspective (an "E"-like stack), lit from one edge and fading into black. Thin, very bright lines run along the lit edges, a diffuse halo of grain spreads around the sheets, and a sparse starfield fills the black.
- **Shards**: a dense portrait frame of shattered-glass polygons fanning out from a few focal points. Each shard has its own grey level, linear gradient and dot size. Thick black bands (lead came / shadows) cross between the shards, and sparse dots of varied size scatter outside the frame.
- **Mixed**: dim shard fans behind, light slabs in front.

Every pixel of the output is pure black or pure white. Tone comes only from the density and size of round dots.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/001-stipple-shards/. It needs WebGL2, so use any current Chrome, Edge, Firefox or Safari.

## How it works

1. **Composition** (`composition.js`): a single integer `seed` drives a mulberry32 PRNG. Geometry is built in resolution-independent units (short side = 1, origin at the centre), so a given seed and set of params gives the same picture at any size.
2. **Source layers**: for each tile, Canvas 2D draws two layers:
   - a *tone* layer: polygons with linear gradients, black bands, and additive glowing edge lines;
   - a *grain* layer: a per-shape code that sets the dot scale. Code 0 is a hard black mask for the bands. Every shard gets a unique code, so neighbouring shards get independent dot grids and their edges stay crisp.

   A low-resolution float **halo field** is the tone layer blurred at two radii (near glow plus a long spray tail). It has a fixed grid size, so the preview and the export get the same halo.
3. **Stipple pass** (`stipple-gl.js`, raw WebGL2 fragment shader): the plane is split into jittered cells, measured in **paper millimetres**. Each cell owns one candidate dot, and a PCG hash of (cell, grain code, seed) gives its position, existence threshold and size jitter. The tone at the dot's centre sets the target coverage `v`, using a Poisson coverage model (`λ = −ln(1−v)`):
   - In dark areas, dots of fixed size appear with probability `p`.
   - In light areas, every cell gets a dot and the dots grow, which leaves black specks in white.

   A second, sparse grid adds "star" dots with a heavy-tailed size distribution. Because everything is hashed from absolute position, the tiles of a big export join without seams.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, re-render |
| Composition | mode, shard count, focal points, slab count, bands (count/width), perspective/rotation, edge-line frequency, frame on/off + margin |
| Light / Tone | brightness, contrast, gamma, edge-line intensity, halo amount/spread/falloff, background grain, star density/size |
| Grain | dot size (in **% of short side** or **mm on paper**, with a live readout of mm / px / %), size-by-shape variation, per-dot size jitter, density, halo dot scale, **hard 1-bit**, invert (black dots on white) |
| Export | paper preset (A4, A3, A2, A1, 18×24 in, 24×36 in, 50×70 cm, custom mm), orientation, DPI (150/200/300/400), pixel size readout, Export PNG, Cancel, Save/Load params JSON |
| Preview | *fit* (whole poster, downscaled with anti-aliasing) or *100%* (real export pixels at the chosen DPI) |

Switching **mode** loads that mode's defaults for frame, halo, bands, stars and gamma.

### Shortcuts

- `R`: new random seed
- `←` / `→`: previous / next seed
- `S`: export PNG
- `Z`: toggle fit / 100% view. Clicking the canvas in fit view opens the 100% view at that point. Drag to pan in 100% view, `Esc` to go back.

The seed is kept in the URL hash (`#seed=1234`). From the browser console you can call `stipple.set({ mode: 'slabs', seed: 7 })`.

## Export

The PNG is named like `stipple-shards_seed-1234_A2_300dpi.png`.

- **Hard 1-bit on** (default) gives a 1-bit grayscale PNG: small files, pure B/W.
- **Hard 1-bit off** gives an 8-bit grayscale PNG with 1 px anti-aliased dot edges.
- The DPI is written into a `pHYs` chunk, so Photoshop, Affinity and RIPs open the file at the right physical size.
- All params are stored as JSON in a `tEXt` "Comment" chunk, so any exported PNG records how to reproduce it. Save params JSON does the same as a separate file.

The **dot size is relative by default** (% of the short side). Changing the paper or DPI then only scales the same image. Switch to *mm on paper* if you want a fixed physical grain whatever the format: a bigger poster then gets more dots.

### Why tiling

At A1 / 300 dpi (7016×9933, about 70 MP) or 24×36 in / 300 dpi (7200×10800, about 78 MP), the image is bigger than the usual WebGL texture and renderbuffer limit (often 8192 or 16384). A single 2D canvas that size also costs over 300 MB, and Safari limits canvas area to about 16.7 MP. So the export:

1. renders tiles of up to 2048 px, padded so dots near a tile edge read the right tone;
2. reads each tile back from the GPU and packs it straight into PNG scanlines;
3. streams the rows through `CompressionStream('deflate')`.

Peak memory is about one row of tiles, and there is no giant canvas. The UI shows `tile i/n` and stays responsive, and the GPU buffers and tile canvases are freed afterwards. The tiling and encoding live in the reusable `lib/poster-export.js`.

### Recommended presets and rough times

| Preset @ 300 dpi | Pixels | Tiles | Time (desktop GPU) | 1-bit file |
|---|---|---|---|---|
| A3 | 3508×4961 (17 MP) | 6 | ~2–4 s | ~0.5–2 MB |
| A2 | 4961×7016 (35 MP) | 12 | ~4–8 s | ~1–4 MB |
| A1 | 7016×9933 (70 MP) | 20 | ~8–15 s | ~2–8 MB |
| 24×36 in | 7200×10800 (78 MP) | 24 | ~10–18 s | ~2–9 MB |

These are estimates. The measured figure is an A2 @ 300 dpi export taking 17 s on CPU-only SwiftShader (headless Chrome), with a 0.75 MB file. File size grows with dot count, so fine grain and bright images make bigger files. For most stipple prints, 300 dpi with dots of at least about 0.3 mm (≈ 3.5 px) prints cleanly. Smaller dots tend to fill in on matte paper.

## Known limitations

- Tiles match a single-pass render except for about 0.04% of pixels. Chrome dithers gradients slightly differently from tile to tile, which can flip an isolated edge pixel or a tiny dot. This leaves no visible seams.
- The fit preview is a downscaled, anti-aliased view. Dots smaller than a screen pixel read as grey there. Use the 100% view to judge the real grain.
- Halo and glow are approximations (a blurred tone field and stacked strokes), not physically based light.
