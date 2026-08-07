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
- **Sideways and upside-down pages are noticed.** The reading model
  transcribes rotated text perfectly well, so a page fed in the wrong way up
  used to come back *backwards* — last paragraph first, and nothing looking
  broken. The layout detector is run at all four right angles and the most
  confident one wins; a page that is merely crooked (a photograph, a sheet
  fed at an angle) is straightened from the angle of its own text lines.

## Choosing a model

The settings page shows the two numbers that decide it — size and seconds a
page. This is the rest, measured on thirteen awkward pages: two-column
articles, a rotated scan, code, tables, formulas with Cyrillic subscripts,
a page of bibliography, mixed Russian and English.

🟢 good · 🟡 usable · 🟠 poor

| | LightOnOCR-2 1B | GLM-OCR | PaddleOCR-VL 1.6 | Qwen3-VL 2B *(shelved)* |
| --- | --- | --- | --- | --- |
| **Speed** | 🟡 64s a page | 🟢 49s | 🟡 72s, on the processor | 🟠 173s |
| **Load on the machine** | 🟢 725 MB | 🟢 703 MB | 🟠 1.15 GB | 🟠 1.45 GB |
| **Cyrillic** | 🟢 11 half-Latin words in thirteen pages | 🟠 22 | 🟢 10 | 🟠 narrates instead of reading |
| **Formulas** | 🟢 correct LaTeX | 🟢 correct, untidy spacing | 🟢 correct | 🟠 |
| **Cyrillic inside formulas** | 🟠 `\text{BCTP}` for «встр» | 🟠 drops the subscript instead | 🟠 `\mathrm{B c t p}` | 🟠 |
| **Tables** | 🟢 found all four, invented none | 🟠 found all four and invented **seven** | 🟢 found all four, invented one — and the only one that answers in Markdown rather than HTML | 🟠 loops until out of tokens |
| **Code blocks** | 🟢 fenced | 🟡 fenced, and fenced a page with no code in it | 🟢 fenced, line numbers kept | — |

Three of the nine things worth measuring turn out not to depend on the
model at all — they are the pipeline, and every model gets them:

| | |
| --- | --- |
| **Document structure** | 🟢 Columns, full-width figures and captions are the layout model's job. A two-column page is read down the left column, then the right, with full-width blocks separating the bands. |
| **Page orientation** | 🟢 90/180/270 detected and corrected before anything reads the page; a scan 1–15° off is straightened from the angle of its own text lines. |
| **Extracting pictures** | 🟢 Figures are cut out into `<name>-layout/` and referenced from the Markdown — never described by a model that would invent a caption. |

Timings are averages over those thirteen pages, each model on the hardware
it is best on — the first two on an Intel Arc integrated GPU, PaddleOCR on
the processor, where it is nearly three times faster than on that GPU
because its int8 arithmetic has no kernel there. The app picks that for
you. The table count is scored against the layout detector, which found
four real tables: "invented" means a heading or a paragraph came back
wrapped in one.

**Which to pick**, if the table is too much: **GLM-OCR** if you want it
over with, **LightOnOCR** for a document you will not check by hand, and
**PaddleOCR-VL** for tables, or for Russian, or for anything where you
would rather have Markdown than a wall of HTML.

**Your machine is not that machine**: run `npm run suite:ocr -- <folder>` on
your own documents, which is the only benchmark that means anything.

## Where the models come from

All of them download from one account,
[huggingface.co/iaa2005](https://huggingface.co/iaa2005) — mirrors, with
each original credited on its page. Six different accounts used to be
involved, and any of them can rename or remove a repository; the mirror is
so that installing a model does not depend on six strangers all leaving
things where they are.

PaddleOCR-VL 1.6 is the exception that is not a mirror: no ONNX build of it
existed, so it was converted here from Baidu's weights and published. The
scripts that did it live in `onnx-lab/` next to the app.

## What it gets wrong

Honest list, from measuring rather than from the model cards:

- **Cyrillic inside `\text{}`.** Every model here writes `\text{BCTP}` for
  «встр» and `A.N.` for «А.Н.» — Latin letters shaped like the Cyrillic
  ones. The mathematics is right; the labels inside it are not, and this is
  the one failure all four share. In running text the same models write
  «встречи» perfectly well; it is specifically the inside of a formula
  where the Cyrillic turns into its Latin twins.
- **Occasional word-level slips** on dense pages: «Границные» for
  «Граничные».
- **Rotation beyond a right angle plus a few degrees.** A page at 30° is
  neither a right angle nor a skew, and nothing here will straighten it.
- **Handwriting.** None of these are trained for it.

## Settings that matter

- **Run on** — Automatic tries the graphics card and falls back to the
  processor. Some drivers take the GPU down rather than admit they cannot
  run a model, which is why the fallback exists. Faster is not always the
  graphics card: PaddleOCR-VL is nearly three times quicker on the
  processor, because its int8 arithmetic has no kernel on this GPU and the
  work ends up being shuttled back anyway.
- **Detail (DPI)** — 150 by default. Lower is not faster: at 110 the model
  reads worse and writes *more*, which measured slower on the same page.
- **Pages per scan** — a hard stop, so "read this book" cannot become an
  afternoon.
- **Block finder** — the layout model, installed with the first OCR model.
  Without it pages are read whole and slowly.
