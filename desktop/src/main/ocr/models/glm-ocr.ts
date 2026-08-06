/**
 * GLM-OCR — a second opinion the library can load on its own.
 *
 * Zhipu's OCR model, and the reason it is worth having next to the default
 * is that it is a different lineage: where LightOnOCR is a Mistral tower on
 * a Qwen decoder, this is GLM throughout. Models fail differently, and a
 * page the default garbles is worth trying on something unrelated before
 * concluding the page is unreadable.
 *
 * `glm_ocr` is supported by @huggingface/transformers directly, so this
 * entry is data and nothing else — no runtime to write, unlike the shelved
 * PaddleOCR-VL next door.
 *
 * Measured on the same page as everything else (chart, big table, mixed
 * Russian and English): 28 seconds against the default's 44, with about as
 * many small errors — but DIFFERENT ones. Where the default wrote
 * "Границные", this writes "Суперползция" and "критография"; both get the
 * table structure and the numbers right. That is the case for keeping two:
 * a page one of them garbles is worth trying on the other.
 *
 * Not the default only because the default has been checked on more pages,
 * not because it lost anything measured so far.
 */

import type { OcrModelInfo } from "./types.js";

export const glmOcr: OcrModelInfo = {
  id: "glm-ocr",
  enabled: true,
  engine: "transformers",
  repo: "onnx-community/GLM-OCR-ONNX",
  label: "GLM-OCR",
  note:
    "Zhipu's document OCR, a different family from the default and measurably faster here (28s a page against 44s), with a different set of small mistakes. Worth trying on a page the other one struggles with.",
  languages: "English, Chinese, multilingual",
  components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
  prompt: "Convert this page to markdown.",
  secondsPerPage: 28,
  short: "Faster, makes different mistakes.",
  variants: [
    {
      dtype: "q4",
      bytes: 703 * 1024 * 1024,
      devices: ["webgpu", "cpu"],
      note: "Same size class as the default; measured at 28s a page on the GPU.",
    },
  ],
};
