# Generative

A place for small creative-coding sketches (three.js, p5.js) built as plain static HTML. No build step.

## Layout

- `sketches/NNN-name/`: one folder per sketch (`index.html`, `sketch.js`, `README.md`).
- `sketches/_template/`: p5.js starter. Copy it to start a new sketch.
- `lib/`: shared helpers, e.g. `lib/poster-export.js`.
- `index.html`: gallery page. Add new sketches to the list there.

## Running

```
python -m http.server 3737
```

Then open http://localhost:3737/.

## Conventions

- Folder names get a three-digit number prefix (`000-`, `001-`, ...) in creation order.
- Each sketch is self-contained and loads its libraries from CDN with pinned versions.
- Seeds live in `params` so renders are reproducible.
- Exports (PNG, SVG, etc.) are saved through the browser to the Downloads folder.
