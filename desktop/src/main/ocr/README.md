# OCR Scanner

A text-only chat model cannot see. Hand DeepSeek a scanned contract, a paper
full of formulas or a screenshot and it does not refuse — it writes Python
against a library it hopes exists and then describes a picture nobody looked
at. This folder is the app's eyes: a vision model that runs **on the user's
machine** and turns a page into Markdown.

Nothing here needs Ollama, Python, or a server. It is `onnxruntime-node` and
`@huggingface/transformers`, both of which the app already depended on.

## How a page is read

    document ──▶ render.ts ──▶ layout.ts ──▶ smart.ts ──▶ engine.ts ──▶ child
                 (pictures)    (blocks)      (per block)  (queue)      (model)

1. **render.ts** turns whatever came in into page images. PDFs are drawn by
   pdf.js inside a hidden Chromium window (main is Node and has no canvas);
   a picture is already a page. It also cuts the blocks out, into
   `<name>-layout/`.
2. **layout.ts** finds the blocks — paragraphs, formulas, tables, figures —
   with PP-DocLayout, about a third of a second on the CPU. It also decides
   reading order, which is the part that survives two-column pages.
3. **smart.ts** reads each block on its own, asking for what that block IS:
   LaTeX for a formula, a table for a table, nothing at all for a
   photograph. This is where four minutes a page became twenty seconds — a
   short context is cheap, a whole A4 is not.
4. **engine.ts** owns the model process and serialises the work; the model
   itself lives in **ocr.child.ts**, because generation is minutes of native
   calls and would stall every IPC channel in the app.

`scan.ts` ties those together and is what callers use. `tools.ts` is the
agent's `OCRScan`. `install.ts` downloads weights (with resume — HuggingFace
drops connections). `settings.ts` is the user's choices.

## Adding a model

One file in `models/`, then a line in `models/index.ts`. If
`@huggingface/transformers` supports the architecture, the file is pure
data — see `glm-ocr.ts`, which is thirty lines and no code.

Each model file carries what was **measured** about it: seconds per page,
which weight format is correct on which device, what it gets wrong. Those
facts cost hours to find and are invisible from the outside, so they live
next to the entry rather than in a commit message.

## Removing a model

Set `enabled: false` in its own file. It disappears from the app and its
file stays, with its measurements and the reason. Two worked examples:

- `paddleocr-vl.ts` — good code, correct structure, shelved because it
  reads Russian worse than the default and takes twice as long;
- `qwen3-vl.ts` — a sound argument (a general model knows more Russian than
  the specialists) that lost to a measurement: 173s a page, and it looped on
  a table until it ran out of tokens.

Deleting either file would delete the reason, and somebody would have the
same idea again next quarter.

## What is measured, per model

| model | page | notes |
| --- | --- | --- |
| LightOnOCR-2 1B | 44s | the default; best Russian so far |
| GLM-OCR | 28s | faster, different mistakes — the second opinion |
| PaddleOCR-VL 1.5 | 91s | shelved: weak Cyrillic, own runtime in `paddle/` |
| Qwen3-VL 2B | 173s | shelved: slow, loops on tables |

Same page for all four (a chart, a big table, mixed Russian and English) on
an Intel Arc iGPU. Run `npm run bench:ocr -- <file> <pages>` to redo it on
your own documents — that is the only benchmark that means anything.

## The odd one out

`paddle/` is a hand-written runtime — preprocessing ported from the model's
own Python, plus a decode loop over three ONNX graphs with its own KV cache.
It exists because no library loads PaddleOCR-VL. It is kept even though the
model is shelved: it is the reference for what supporting an unsupported
model actually takes, and the traps are documented in place (patch ordering,
`smart_resize` scaling small crops UP, two copies of onnxruntime in one
process).
