# 002 · Strata

Colour strata landscapes after Matt DesLauriers' "Meridian". Flat colour bands, the contour bands of a domain-warped noise field, form sky strata and stacked mountain ranges. They are drawn as dense short hatching strokes (or stipple dots) on cream paper with a margin.

- **Landscape**: sky strata above a horizon, plus stacked ridged mountain ranges, each internally banded.
- **Strata**: undulating bands across the whole image.
- **Random**: the seed picks one of the above.

Open via the repo server: `python -m http.server 3737`, then go to http://localhost:3737/sketches/002-strata/. It needs WebGL2.

## How it works

1. **Scene** (`scene.js`): a single integer `seed` drives a seeded PRNG. It picks the palette and builds the band sequence and widths as a colour lookup table. Geometry is in resolution-independent units (short side = 1), so a seed gives the same picture at any size.
2. **Strokes** (`strata-gl.js`, raw WebGL2, two passes):
   - *Pass 1* evaluates the warped field once per stroke, on a jittered cell grid fixed in paper mm. It looks up the band colour at the stroke centre, takes the direction from the field gradient (along the contours, plus noise), and applies hillshade and colour jitter.
   - *Pass 2* draws anti-aliased capsules (or dots in stipple mode) over the paper, looping over neighbouring cells in a fixed absolute order.

   Every pixel is a pure function of absolute position, so export tiles join without seams (split renders measured bit-identical).
3. **Sketch** (`sketch.js`): UI, preview and export.

## Controls

| Folder | What |
|---|---|
| Seed | seed, randomize, randomize params, reset |
| Composition | scene, horizon, ranges, mountain height, ridge sharpness, band count, band variance, warp, warp scale, detail, roughness, edge jag, tilt |
| Colour | palette or random, colour count, paper bands, colour jitter, shading, paper colour, margin |
| Texture | strokes / stipple, grain size (% of short side or mm), stroke length, stroke width, flow align, flow curl, density, paper show, ragged edge |
| Export | paper (incl. 9:16 preset), orientation, DPI, Export PNG, Cancel, Save/Load params JSON |
| Preview | *fit* or *100%* |

### Shortcuts

- `R`: new random seed
- `Shift+R`: randomize params
- `←` / `→`: previous / next seed
- `S`: export PNG
- `Z`: toggle fit / 100%. Click the canvas to zoom there, drag to pan, `Esc` to go back.

The seed is kept in the URL hash (`#seed=1234`). From the browser console: `strata.set({ scene: 'strata', seed: 7 })`.

## Export

The PNG is named like `strata_seed-1234_9x16_300dpi.png`.

- 24-bit RGB PNG.
- The DPI is written into a `pHYs` chunk, so editors and RIPs open the file at the right physical size.
- All params are stored as JSON in a `tEXt` "Comment" chunk, so any exported PNG records how to reproduce it. Save params JSON does the same as a separate file.

The dot or stroke size is relative by default (% of the short side), so changing the paper or DPI only scales the same image. Switch to *mm on paper* for a fixed physical grain.

### Why tiling

Large sizes at 300 dpi (A1 is about 70 MP) exceed the usual WebGL texture and canvas limits, and a single 2D canvas that size costs hundreds of MB. So the export:

1. renders tiles of up to 2048 px, padded so strokes crossing a tile edge are drawn on both sides;
2. reads each tile back from the GPU and packs it straight into PNG scanlines;
3. streams the rows through `CompressionStream('deflate')`.

Peak memory is about one row of tiles, and the UI shows `tile i/n`. The tiling and encoding live in the reusable `lib/poster-export.js`.

## Known limitations

- Strokes smaller than a screen pixel read as grey in the fit preview. Use the 100% view to judge the real texture.
- Strokes are layered in cell order, so lower strokes always sit on top of upper ones.
- Stroke direction can be messy right at a mountain silhouette, where the field jumps.
- With a very high band count and band variance, the thinnest bands can fall below the 4096-entry colour table and disappear.
