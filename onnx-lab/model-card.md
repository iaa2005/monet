---
license: apache-2.0
base_model: PaddlePaddle/PaddleOCR-VL-1.6
base_model_relation: quantized
library_name: onnx
pipeline_tag: image-text-to-text
tags:
  - onnx
  - onnxruntime
  - ocr
  - document-parse
  - PaddleOCR
  - ERNIE4.5
language:
  - en
  - zh
  - ru
---

# PaddleOCR-VL-1.6-ONNX (int8)

[PaddlePaddle/PaddleOCR-VL-1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
as three ONNX graphs, with the two large ones quantised to int8, so it can
be run by onnxruntime alone — no PyTorch, no Python, no llama.cpp.

It was converted because nothing else had been: PaddlePaddle publish
safetensors and GGUF, and a JavaScript app that wants this model has
nowhere to get it from. The export scripts are in
[claude-code/onnx-lab](https://github.com/iaa2005) and reproduce these
files in about ten minutes.

## Files

| | |
| --- | --- |
| `onnx/vision_encoder_q8.onnx` | 426 MB — the NaViT tower **and the projector** |
| `onnx/decoder_q8.onnx` | 346 MB — the ERNIE-4.5 decoder, cache in and cache out |
| `onnx/embedding.onnx` | 404 MB — the token table, left at fp32 on purpose |

The embedding table is a lookup: it is indexed, never multiplied, so
quantising it costs accuracy and saves nothing that matters.

## Signatures

```
vision_encoder   pixel_values [1, P, 3, 14, 14], image_grid_thw [1, 3]
                 -> image_embeds [P/4, 1024]

embedding        input_ids [1, S] -> embeddings [1, S, 1024]

decoder          inputs_embeds [1, S, 1024], attention_mask [1, T],
                 past_key_values.{0..17}.{key,value} [1, 2, past, 128]
                 -> logits [1, S, 103424], present.{0..17}.{key,value}
```

Same shapes as the community's 1.5 build, so a runtime written against
that one drives this one unchanged.

Driving it is three steps: the tower turns patches into image tokens, the
embedding turns the prompt into vectors, and the image tokens are spliced
in where `<|IMAGE_PLACEHOLDER|>` (id 100295) sits. Then the decoder steps
with its own cache. The prompt is
`<|begin_of_sentence|>User: <|IMAGE_START|>{placeholders}<|IMAGE_END|>OCR:\nAssistant:\n`,
with one placeholder per MERGED patch — the projector turns each 2×2 block
of patches into one token.

## Two things worth knowing before you use it

**int8 holds up on a block and not on a whole page.** Given ~1300 image
tokens at once it stops writing Cyrillic and starts writing the Latin
letters that look like it — «a 3to npuBduT k BecbMa rpoMo3dkM» for «а это
приводит к весьма громоздким» — and then loops. At block size (~200 image
tokens) the same weights read the same page correctly. Feed it regions,
not pages. The fp32 export has no such trouble, so this is quantisation
compounding over a long sequence rather than a bad conversion.

**It is faster on the CPU than on a GPU**, and not by a little: 92s a page
against 246s on an Intel Arc iGPU, because int8 matmuls have no WebGPU
kernel there and the run becomes mostly fallback.

## Preprocessing

Use the numbers in `preprocessor_config.json`, not the defaults in the
original `image_processing_paddleocr_vl.py`. They differ, and the
difference is invisible until you read the output:

    image_mean/std   class says CLIP's 0.48/0.46/0.41   config says 0.5/0.5/0.5
    min_pixels       class says 28*28*130               config says 112896

With the class defaults this model reads Russian as fluent nonsense and
looks like a bad model.

## Conversion

`torch.onnx.export(..., dynamo=True)`, opset 21, from transformers 4.57.6
and torch 2.13. The dynamo exporter is not optional here: page height and
width arrive as VALUES inside `image_grid_thw` and resize the position
embeddings through a `Resize`, and the classic TorchScript exporter bakes
in whatever page it was traced with — producing a graph with the right
signature that reads every other page as noise. Weights quantised with
`onnxruntime.quantization.quantize_dynamic`, QInt8, `MatMulConstBOnly`.

Checked against the PyTorch model on a real page rather than by eye:

| | max abs diff | cosine |
| --- | --- | --- |
| fp32 export | 0.0000 | 1.000000 |
| int8 | 2.7610 | 0.989932 |

## Measured

Thirteen awkward pages — two-column articles, a rotated scan, code,
tables, formulas with Cyrillic subscripts, bibliography, mixed Russian and
English — read region by region on an Intel Core Ultra CPU:

| | |
| --- | --- |
| Speed | 72s a page |
| Tables | found all four real ones, invented one, and answers in Markdown |
| Russian | 10 half-Latin words across the thirteen pages |
| Weak spot | Cyrillic INSIDE a formula: `\mathrm{B c t p}` for «встр». In running text the same word is written correctly. |

## Licence and credit

Apache 2.0, inherited from the original. The model is Baidu's; this
repository is a format conversion and adds nothing to it.
