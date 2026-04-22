# LPC Atlas — Phaser Demo

A ~100-line Phaser scene that loads an atlas exported from the LPC
Spritesheet Character Generator and lets you walk a character around with
the arrow keys.

## Usage

1. In the main app, click **Atlas (ZIP: PNG + JSON)** to export.
2. Extract the ZIP so that `character-atlas.png` and `character-atlas.json`
   sit in this folder next to `index.html`.
3. Serve this folder over HTTP (browsers block `fetch` under `file://`):

```sh
npx serve demo/phaser
# or
python3 -m http.server -d demo/phaser 8000
```

4. Open the URL it prints. Use ← ↑ ↓ → to move. Pick idle/walk animation
   bases from the dropdowns if you want to swap `walk` for `run`, etc.

## How it works

Phaser reads the atlas via `load.atlas('char', png, json)` — the `frames`
section is TexturePacker-standard JSON Hash, so Phaser accepts it directly.

The `animations` section in the JSON is Phaser-style: each key like
`walk_down` maps to an ordered list of frame names. `main.js` iterates it and
registers each animation with `anims.create()` at 8 fps, looping. Deduplicated
frames carry the same `frame` rect as their unique (with a `mirrorOf` hint
for debugging) — Phaser doesn't need to know about dedup.
