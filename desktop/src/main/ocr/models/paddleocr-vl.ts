/**
 * PaddleOCR-VL 1.6 — Baidu's document model, built here rather than found.
 *
 * 0.9B: an ERNIE-4.5 decoder on a NaViT tower that reads a page at its own
 * aspect ratio instead of squashed to a square. No library loads it —
 * @huggingface/transformers knows the decoder family but not the
 * `paddleocr_vl` wrapper, and its processor is a Python file — so
 * `ocr/paddle/` assembles it from three graphs by hand.
 *
 * WHERE THE WEIGHTS COME FROM. Nobody had published an ONNX of 1.6:
 * PaddlePaddle ship safetensors and GGUF, the repo named
 * `onnx-community/PaddleOCR-VL-1.6-ONNX` holds a `.gitattributes` and
 * nothing else, and GGUF would mean llama.cpp, which this app deliberately
 * does not carry. So it was exported here — see `onnx-lab/` beside
 * `desktop/`, which downloads the safetensors, traces the three graphs and
 * quantises them to int8 — and then published, which is why this entry
 * points at a personal namespace rather than onnx-community's.
 *
 * 1.5 IS WHAT WAS SHELVED, AND THE VERDICT WAS PARTLY OURS. The reason 1.5
 * sat on the shelf was Russian — «Кваантовый», «Кубин», «Минималная
 * единца», «крипгография». Converting 1.6 turned up why: the preprocessing
 * in `paddle/preprocess.ts` was normalising with OpenAI CLIP's mean and
 * standard deviation, and sizing crops against the wrong pixel floor,
 * because both were copied from the Python class's DEFAULTS instead of the
 * `preprocessor_config.json` that ships with the weights. Every picture
 * this app fed the model was shifted, scaled and cropped slightly wrong.
 * 1.5 may well read Russian better than it was given credit for; nobody
 * has re-measured it, and 1.6 is the version worth measuring.
 *
 * What 1.6 does after the fix, on a page 1.5 failed:
 *
 *   «…смешанные производные не позволяют получить решение в виде (8.50)»
 *   — clean, with the display formulas as LaTeX and the inline ones inline.
 *
 * ONE MEASURED TRAP, kept here so nobody re-derives it: q8 holds up on a
 * BLOCK and falls apart on a WHOLE PAGE. Given 1260 image tokens at once
 * it stops writing Cyrillic and starts writing the Latin letters that look
 * like it — «a 3to npuBduT k BecbMa rpoMo3dkM» — and then loops. At block
 * size (~200 image tokens) the same weights read the same page correctly.
 * The pipeline reads blocks, so this is the regime it runs in; anyone
 * tempted to add a whole-page mode for this model should read that
 * sentence again.
 *
 * And a second oddity that survives from 1.5, now with a number: this
 * model is FASTER ON THE CPU than on the iGPU, and at q8 it is not close —
 * 92s a page against 246s. int8 matmuls have no WebGPU kernel here, so the
 * GPU run is mostly the fallback shuttling tensors back to the processor.
 * That is why the CPU is listed first, and why the bench honours the order.
 */

import type { OcrModelInfo } from "./types.js";

export const paddleOcrVl: OcrModelInfo = {
  id: "paddleocr-vl",
  // On. It was shelved as 1.5 for reading Russian badly, and stayed off a
  // while longer for having nowhere to be downloaded from; neither is true
  // now. Measured through the real pipeline over thirteen pages: 72s a
  // page on the processor against 64s for the default, fewer mangled
  // Russian words than either shipped model, and the only one of the three
  // that answers with Markdown tables instead of HTML.
  enabled: true,
  engine: "paddle",
  // Built by onnx-lab/scripts/export_paddleocr_vl.py and published from
  // it; there is no other ONNX of 1.6 to point at.
  repo: "iaa2005/PaddleOCR-VL-1.6-ONNX",
  label: "PaddleOCR-VL 1.6",
  note:
    "Baidu's document model on a hand-written pipeline. Excellent table structure (answers in OTSL, converted to Markdown here) and, unlike 1.5, sound Russian. No published ONNX exists — this build is exported locally by onnx-lab.",
  languages: "English, Chinese, Russian, and 100+ more",
  components: ["vision_encoder", "decoder", "embedding"],
  prompt: "OCR:",
  // Measured over the thirteen benchmark pages, on the processor.
  secondsPerPage: 72,
  short: "Great tables, sound Russian.",
  variants: [
    {
      dtype: "q8",
      bytes: 1176 * 1024 * 1024,
      devices: ["cpu", "webgpu"],
      note: "Vision tower and decoder quantised to int8; the embedding table is not, because a lookup gains nothing from it. Bigger than the q4 build of 1.5 — q4 was measured to read «большом количестве» as «доплыком колпистстве», and a version comparison should differ in the version.",
    },
  ],
};
