/**
 * PaddleOCR-VL 1.5 — SHELVED. Working code, disabled on purpose.
 *
 * Baidu's document model: 0.9B, an ERNIE-4.5 decoder on a NaViT tower that
 * reads a page at its own aspect ratio instead of squashed to a square. No
 * library loads it — @huggingface/transformers knows the decoder family but
 * not the `paddleocr_vl` wrapper, and its processor is a Python file — so
 * `ocr/paddle/` assembles it from three graphs by hand. That code works and
 * stays.
 *
 * Why it is off: measured against LightOnOCR on the same page, it is worse
 * at the job this app does.
 *
 *                       LightOnOCR (GPU)      PaddleOCR-VL (CPU)
 *   time per page       44s                   91s
 *   table structure     correct               correct (OTSL → Markdown)
 *   Russian text        clean                 "Кваантовый", "Кубин",
 *                                             "Минималная единца",
 *                                             "крипгография"
 *
 * Its table structure really is excellent, and it is trained on English and
 * Chinese — the Cyrillic is the failure, not the layout. If the documents
 * ever stop being Russian, flip `enabled` and it is back.
 *
 * One measured oddity kept here so nobody re-derives it: this model is
 * FASTER ON THE CPU than on the iGPU (91s against 104s), which is why the
 * CPU is listed first.
 */

import type { OcrModelInfo } from "./types.js";

export const paddleOcrVl: OcrModelInfo = {
  id: "paddleocr-vl",
  // Shelved — see the note above. The runtime in ocr/paddle is kept.
  enabled: false,
  engine: "paddle",
  repo: "onnx-community/PaddleOCR-VL-1.5-ONNX",
  label: "PaddleOCR-VL 1.5",
  note:
    "Baidu's document model on a hand-written pipeline. Excellent table structure (answers in OTSL, converted to Markdown here), weak on Russian, about twice as slow as the default. Shelved.",
  languages: "English, Chinese, and 100+ more — but measurably weak on Russian",
  components: ["vision_encoder", "decoder", "embedding"],
  prompt: "OCR:",
  secondsPerPage: 91,
  short: "Great tables, weak Russian.",
  variants: [
    {
      dtype: "q4",
      bytes: 858 * 1024 * 1024,
      devices: ["cpu", "webgpu"],
      note: "Vision tower and decoder quantised; the embedding table is not, because a lookup gains nothing from it. 91s a page on the CPU, 104s on the GPU.",
    },
  ],
};
