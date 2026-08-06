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
 */

import type { OcrModelInfo } from "./types.js";

export const glmOcr: OcrModelInfo = {
  id: "glm-ocr",
  enabled: true,
  engine: "transformers",
  repo: "onnx-community/GLM-OCR-ONNX",
  label: "GLM-OCR",
  note:
    "Zhipu's document OCR, a different family from the default — worth trying on a page the other one struggles with. Runs on the library's own runtime.",
  languages: "English, Chinese, multilingual",
  components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
  prompt: "Convert this page to markdown.",
  variants: [
    {
      dtype: "q4",
      bytes: 703 * 1024 * 1024,
      devices: ["webgpu", "cpu"],
      note: "Same size class as the default.",
    },
  ],
};
