# Code Monet → Figma

A local Figma plugin that rebuilds the app's screens in the design file from the
app's own tokens. Not part of the Electron build — it never ships; it exists so
the design file can be regenerated instead of redrawn.

File: <https://www.figma.com/design/gCEBSaXq9n0P8eVVNCaniB/Code-Monet-Interface>,
page **Code Monet**.

## Why a plugin and not the Figma MCP

The MCP writes to Figma through the same Plugin API, but the Starter plan caps
tool calls **per day**, and one screen costs a dozen calls. The plugin has no
cap: the whole build is one run, and iterating is "edit `code.js`, hit Run".

Two APIs the MCP sandbox adds that the real Plugin API does **not** have —
reaching for them is what hung the first run:

- `figma.createAutoLayout(dir, props)` → build a frame and set `layoutMode`
- `node.query(sel)`, `node.set(props)`, `await node.screenshot()`

## Install (once)

Figma **desktop** only.

1. Right-click the canvas → Plugins → Development → Import plugin from manifest…
2. Pick `manifest.json` from this folder.

Development → **Hot reload plugin** is on by default, so edits to `code.js` are
picked up without re-importing. `Ctrl+Alt+P` re-runs the last plugin.

## Run

Right-click → Plugins → Development → **Code Monet → Figma**.

Every run deletes what the previous run made (by name) and rebuilds it, so it is
safe to run repeatedly. It does **not** touch the things it did not make:
the variable collections, the text styles, the `icon/*` components, `Titlebar`,
`Sidebar`.

It builds:

- `Chat column`, `Panel/Artifacts`, `Panel/Files`, `Panel/Terminal`,
  `Panel/Tasks`, and the repeated rows `Tasks/Row` and `Files/Row`
- three 1792×1152 screens — the app's real viewport in CSS pixels, so the
  sidebar is 320 and the chat and dock are 736 each, exactly as in the app

## Rules the file follows

- **Numbers are CSS pixels.** 36 in Figma is `--titlebar-h: 36px`. Nothing is
  scaled to "look right" at some other size.
- **Colours are variables, never hex.** `Color` (light) and `Color Dark` mirror
  the semantic tokens in `desktop/src/renderer/styles/globals.css`. They are two
  collections rather than two modes because the free plan allows one mode each.
  The only literals are the ones the app does not tokenise: the chart's green
  and red, the Max pink, and the file-type colours.
- **Icons are imported, never redrawn.** lucide paths come out of
  `desktop/node_modules/lucide-react`, the in-house ones out of
  `desktop/src/renderer/components/icons/index.tsx`. An icon placed at 16px has
  its stroke weight scaled with it (2 → 1.33), which is what the browser does
  and what Figma's `resize` does not.

## Gotchas worth keeping

- `resize()` resets both axes to FIXED — set `layoutSizingHorizontal = "FILL"`
  **after** it, never before.
- An instance cannot be given a new child. Anything conditional has to exist in
  the component and be hidden per instance (that is why `Files/Row` always
  carries a disclosure arrow).
- `opacity` on a paint returned by `setBoundVariableForPaint` is dropped — the
  paint renders solid. A wash needs its own variable, which is why
  `brand/wash` exists.
- The wordmark wants **Bounded**, the app's display face
  (`desktop/src/renderer/fonts/Bounded-Variable.ttf`). If it is not installed
  system-wide the run says so and falls back to Inter.
