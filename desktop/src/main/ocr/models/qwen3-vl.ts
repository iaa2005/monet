/**
 * Qwen3-VL 2B — the general-purpose one.
 *
 * Not an OCR model: a vision-language model that happens to read documents
 * well, and unlike the specialists it was trained on a lot of Russian. That
 * makes it the fallback worth reaching for when a page is Cyrillic and
 * messy — a photograph, a scan of a scan, handwriting mixed with print.
 *
 * It is also the biggest of these (twice the parameters of the default, and
 * 1.4 GB of weights), so it is the slow, careful option rather than the
 * everyday one.
 */

import type { OcrModelInfo } from "./types.js";

export const qwen3Vl: OcrModelInfo = {
  id: "qwen3-vl-2b",
  enabled: true,
  engine: "transformers",
  repo: "onnx-community/Qwen3-VL-2B-Instruct-ONNX",
  label: "Qwen3-VL 2B",
  note:
    "A general vision-language model rather than a document specialist: slower and larger, but trained on far more Russian than the OCR models are. The one to try on a messy scan.",
  languages: "119 languages, Russian well represented",
  components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
  prompt: "Read this page and write it out as markdown.",
  variants: [
    {
      dtype: "q4",
      bytes: 1_450 * 1024 * 1024,
      devices: ["webgpu", "cpu"],
      note: "Twice the size of the default; expect it to be slower in proportion.",
    },
  ],
};
