/**
 * Qwen3-VL 2B — SHELVED. The reasonable-sounding idea that lost to a
 * measurement.
 *
 * The argument for it was good: not an OCR specialist, but a general
 * vision-language model trained on far more Russian than the specialists
 * are, and therefore the thing to reach for on a messy Cyrillic scan.
 *
 * On the test page it took 173 seconds — four times GLM-OCR, and four times
 * the default — and then LOOPED on the table, emitting
 * "| Кубитовая оптическая | 0.02 | 0.02 |" over and over until it hit the
 * token cap. Being general-purpose is exactly the problem: it narrates a
 * page instead of transcribing it, and a table gives it too much room to
 * improvise.
 *
 * Kept because the reasoning was sound and somebody will have it again.
 */

import type { OcrModelInfo } from "./types.js";

export const qwen3Vl: OcrModelInfo = {
  id: "qwen3-vl-2b",
  enabled: false,
  engine: "transformers",
  repo: "onnx-community/Qwen3-VL-2B-Instruct-ONNX",
  label: "Qwen3-VL 2B",
  note:
    "A general vision-language model rather than a document specialist. Measured here: 173s a page — four times the others — and it looped on a table until it ran out of tokens. Shelved.",
  languages: "119 languages, Russian well represented",
  components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
  prompt: "Read this page and write it out as markdown.",
  secondsPerPage: 173,
  short: "General-purpose. Slow, loops on tables.",
  variants: [
    {
      dtype: "q4",
      bytes: 1_450 * 1024 * 1024,
      devices: ["webgpu", "cpu"],
      note: "Twice the size of the default and four times as slow in practice.",
    },
  ],
};
