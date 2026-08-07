# onnx-lab

Python side-workshop for the desktop app's OCR models. Nothing here ships —
the app has no Python — but converting a model to ONNX needs PyTorch, and
that work is worth keeping for the next model that arrives without one.

    models/   downloaded originals, and the patched copy the export reads
    out/      exported and quantised ONNX
    scripts/  the export, the quantiser, and two inspectors

Both `models/` and `out/` are ignored by git: 9.6 GB of weights that these
scripts reproduce in about ten minutes.

## Why it exists

`@huggingface/transformers` loads a model only if it knows the architecture.
When it does not — PaddleOCR-VL is the case — the app needs the model split
into three ONNX graphs it can drive itself (see desktop/src/main/ocr/paddle):

    vision_encoder   pixel_values, image_grid_thw  ->  image_embeds
    embedding        input_ids                     ->  embeddings
    decoder          inputs_embeds, attention_mask,
                     past_key_values.N.{key,value} ->  logits, present.N.*

Somebody did this for PaddleOCR-VL **1.5** and published it. Nobody has done
it for **1.6**, which is the version worth having: its release notes claim
stronger multilingual recognition, and weak Cyrillic is exactly why 1.5 was
shelved in the app. So this converts it.

## Setup

    python -m venv .venv
    .venv/Scripts/pip install -r requirements.txt

`transformers` is pinned below 5: the model's remote code asks the rope
initialiser for a "default" entry that 5.x no longer has. 4.57.6 is close
enough to the 4.55 it was written against that two edits bridge the gap, and
the export applies both to a local copy — see `strip_shape_asserts` and
`retarget_mask_kwarg` in the export script.

## Doing the conversion

    .venv/Scripts/python scripts/export_paddleocr_vl.py
    .venv/Scripts/python scripts/quantize_q8.py out/PaddleOCR-VL-1.6-ONNX
    .venv/Scripts/python scripts/verify_onnx.py --image <page.png> --dtype q8

Then copy `out/PaddleOCR-VL-1.6-ONNX/{*.json,*.jinja,onnx/{vision_encoder_q8,
decoder_q8,embedding}.onnx}` into the app's model folder under
`onnx-lab/PaddleOCR-VL-1.6-ONNX/`, which is the repo id the catalogue names.

## What was learned doing it

**The exporter is not a choice.** Page height and width arrive as VALUES
inside `image_grid_thw` and resize the position-embedding grid. Only
`dynamo=True` turns a value into a dynamic `Resize`; the classic tracer bakes
in whatever page it was traced with, and every other page then reads as
noise — with the right signature and no error. The published 1.5 graph was
read node by node (`inspect_graph.py`) to establish that, and it has exactly
one `Resize`, one `Conv` and one `CumSum`, as this one does.

**The decoder needs dynamo too**, for a duller reason: transformers builds
its causal mask with `torch.vmap`, which the classic tracer meets as
`invalid unordered_map<K, T> key`.

**Opset 21, not 17.** The dynamic `Resize` has no down-conversion adapter.

**q8 holds up on a block and not on a page.** Given 1260 image tokens at
once the quantised model stops writing Cyrillic and starts writing the Latin
letters that look like it — «a 3to npuBduT k BecbMa rpoMo3dkM» — then loops.
At block size the same weights read the same page correctly, and the app
reads blocks. The fp32 graphs read the whole page fine, so this is
quantisation compounding over a long sequence, not a bad export:

    fp32 vs PyTorch      max |diff| 0.0000   cosine 1.000000
    q8   vs PyTorch      max |diff| 2.7610   cosine 0.989932

## The scripts

| | |
| --- | --- |
| `export_paddleocr_vl.py` | downloads 1.6, patches two incompatibilities, traces the three graphs |
| `quantize_q8.py` | int8 weights for the two big ones; the embedding table stays fp32 |
| `verify_onnx.py` | compares the graphs against PyTorch on a real page, then decodes with the graphs alone |
| `inspect_graph.py` | prints a graph's signature and what a named input feeds — how the 1.5 build was reverse-engineered |
