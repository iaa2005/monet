---
title: Code highlighting themes
description: Twenty-two palettes, chosen per mode, applied to every code surface at once.
order: 15
---

**Settings → Editor** holds the syntax-highlighting themes: ten light (One
Light, GitHub, VS Code Light+, Solarized, Gruvbox, Catppuccin Latte,
Tomorrow, Ayu, Rosé Pine Dawn, Quiet Light) and twelve dark (VS Code Dark+,
One Dark, Dracula, Monokai, Nord, Gruvbox, Solarized, Tokyo Night, Night
Owl, Catppuccin Mocha, GitHub Dark, SynthWave '84).

## Why light and dark are separate choices

Most classic palettes exist in one mode only — Dracula on a white panel is
not a theme, it is an accident. So you pick one light theme and one dark
theme, and the app's own light/dark toggle decides which is live at any
moment. VS Code works the same way.

## How applying works (and why it is instant)

A theme is ten colours — comment, punctuation, constants, class names,
keywords, tags, strings, functions, variables, operators. Applying one
writes ten CSS variables that **every** code surface reads:

- chat code blocks and inline previews,
- diffs (tool cards and the review panel),
- notebook cells,
- the Monaco file editor (it maps the same variables onto its own token
  rules and re-themes on the spot).

Because it is variables, the entire app recolours the instant you click —
no reload, nothing re-renders, and the preview below the pickers is simply
more of the same surface.

## The preview

The sample is deliberately token-dense — comments, generics, decorators,
template strings, regex, JSX — so one glance covers every colour a palette
defines. The ☀ / ☾ toggle above it shows either palette regardless of the
app's current mode, and clicking a theme in either grid flips the preview
to that mode, so what you picked is always what you see.

## Defaults

Out of the box nothing changes: the defaults reproduce the palettes the app
always had (One Light / VS Code Dark+), byte for byte.
