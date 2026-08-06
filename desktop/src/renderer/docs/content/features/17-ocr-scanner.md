---
title: OCR Scanner
description: Reading scans, PDFs and screenshots on your own machine — how it works, which model to pick, and what each one gets wrong.
order: 17
---

Most chat models read text and nothing else. Hand one a scanned contract, a
paper full of formulas or a screenshot and it does not refuse — it writes
code against a library it hopes exists and then describes a picture nobody
looked at. The scanner is the app's eyes: a small vision model that runs
**on this computer** and turns a page into Markdown, with formulas as LaTeX
and tables as tables.

Nothing is uploaded. No Python, no Ollama, no server to start — installing a
model is downloading its weights.

## Using it

**Settings → OCR Scanner**, download a model, done. The agent gets a tool
called `OCRScan` and reaches for it whenever an answer depends on what is
inside a picture or a PDF.

It takes a file path, a name from the chat's own files, something in your
Obsidian vault, or a URL. Two parameters worth knowing:

- **`pages`** — `"3"`, `"2-5"`, `"1,4,9-11"`. A page costs real time, so
  asking for the pages you need beats reading a book.
- **`bbox: true`** — returns the page's LAYOUT as well as its text: each
  block tagged with what it is and where it sits, in pixels. That is how a
  model that cannot see answers questions about a screenshot.

Long documents should go to a background agent — the tool's own
instructions say so — because a turn spent waiting is a conversation that
has stopped.

## Why it is fast now

The obvious approach is to hand the whole page to the vision model. On a
laptop that takes **four to five minutes a page**, because attention over a
whole A4 is expensive and the model narrates every pixel of it.

Instead the page is taken apart first:

1. A layout model finds the blocks — paragraphs, formulas, tables, figures,
   captions — in about a third of a second on the CPU.
2. Each block is read **on its own**, and asked for what it IS: LaTeX for a
   formula, a table for a table, nothing at all for a photograph.
3. The pieces are put back in reading order, which is where two-column
   pages survive.

Same model, same hardware: **246 seconds became 22**. A short context is
cheap in a way a long one never is, and a picture that nobody reads costs
nothing at all.

Three things fall out of knowing what a block is, beyond the speed:

- **Inline formulas stay in their sentence.** Cut out on its own, an inline
  formula is a clipped slice of a text line and the sentence is left with a
  hole; read as part of its paragraph, the mathematics is written in place.
- **Photographs are not described.** The crop is kept and referenced, not
  hallucinated over.
- **Upside-down pages are noticed.** The reading model transcribes rotated
  text perfectly well, so a page fed in the wrong way up used to come back
  *backwards* — last paragraph first. The layout detector is run both ways
  and the more confident answer wins.

## Choosing a model

The settings page shows the two numbers that decide it: size and seconds a
page. Everything else is here.

| Model | Page | Size | Notes |
| --- | --- | --- | --- |
| **LightOnOCR-2 1B** | ~44s | 725 MB | The default. Best of these on Russian, including formulas with Cyrillic subscripts. |
| **GLM-OCR** | ~28s | 703 MB | Faster, and makes *different* mistakes — worth trying on a page the default garbles. |

Two shelved, kept in the code with their measurements so nobody re-runs the
experiment:

| Model | Page | Why not |
| --- | --- | --- |
| PaddleOCR-VL 1.5 | ~91s | Excellent table structure, weak on Cyrillic ("Кваантовый", "Минималная единца"), twice as slow. Needed a hand-written runtime, which is kept as a reference. |
| Qwen3-VL 2B | ~173s | A general model, trained on more Russian — and it narrates instead of transcribing, then loops on tables until it runs out of tokens. |

All measured on the same page (a chart, a big table, mixed Russian and
English) on an Intel Arc integrated GPU. **Your machine is not that
machine** — run the bench on your own documents if it matters.

## What it gets wrong

Honest list, from measuring rather than from the model cards:

- **Cyrillic inside `\text{}`.** The default writes `\text{BCTP}` for
  «встр» and `A.N.` for «А.Н.» — Latin letters that look like the Cyrillic
  ones. Formulas themselves are right; the labels inside them are not.
- **Occasional word-level slips** on dense pages: «Границные» for
  «Граничные».
- **90° rotations.** Upside down is handled; sideways is not — that needs
  the page re-rendered rather than flipped, and the failure is obvious
  enough to spot.
- **Handwriting.** None of these are trained for it.

## Settings that matter

- **Run on** — Automatic tries the graphics card and falls back to the
  processor. Some drivers take the GPU down rather than admit they cannot
  run a model, which is why the fallback exists; and one shelved model is
  actually *faster* on the processor.
- **Detail (DPI)** — 150 by default. Lower is not faster: at 110 the model
  reads worse and writes *more*, which measured slower on the same page.
- **Pages per scan** — a hard stop, so "read this book" cannot become an
  afternoon.
- **Block finder** — the layout model, installed with the first OCR model.
  Without it pages are read whole and slowly.
