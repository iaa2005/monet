/**
 * LightOnOCR-2 1B — the default, and the one everything else is measured
 * against.
 *
 * A Mistral vision encoder on a Qwen3 decoder, trained end to end for
 * document transcription: a page in, Markdown out, formulas as LaTeX and
 * tables as tables. Apache 2.0.
 *
 * Measured here (Core Ultra 7 155H, Arc iGPU, no CUDA), reading a page
 * block by block:
 *   - coursework with formulas and a table: 22s
 *   - a dense page of lecture notes:        43s
 *   - a page with a chart and a big table:  44s
 * Whole-page, without the block finder, the same pages took 4–5 minutes.
 *
 * Russian is not on its published language list and it reads it well
 * anyway — better than the models that do list it. It does slip on
 * Cyrillic inside \text{}: "встр" comes back as "BCTP", "А.Н." as "A.N.".
 */

import type { OcrModelInfo } from "./types.js";

export const lightOnOcr: OcrModelInfo = {
  id: "lightonocr-2-1b",
  enabled: true,
  engine: "transformers",
  repo: "onnx-community/LightOnOCR-2-1B-ONNX",
  label: "LightOnOCR-2 1B",
  note:
    "End-to-end document OCR: a page in, Markdown out, with formulas as LaTeX and tables as tables. A Mistral vision encoder on a Qwen3 decoder, 1B parameters, Apache 2.0. The best of these on Russian, and the fastest.",
  languages:
    "English, French, German, Spanish, Italian, Dutch, Portuguese, Swedish, Danish, Chinese, Japanese — and Russian in practice",
  components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
  prompt: "Convert this page to markdown.",
  secondsPerPage: 44,
  short: "Best on Russian. The default.",
  variants: [
    {
      dtype: "q4",
      bytes: 725 * 1024 * 1024,
      devices: ["webgpu", "cpu"],
      note: "The default. Correct on both the GPU and the CPU; the GPU is about three times faster.",
    },
    {
      dtype: "fp16",
      bytes: 2_100 * 1024 * 1024,
      devices: ["webgpu"],
      note: "Full half precision — three times the download, for a GPU that has the memory for it. Not measured here.",
    },
    {
      dtype: "fp32",
      bytes: 4_100 * 1024 * 1024,
      devices: ["cpu"],
      note: "Reference precision. Slow and large; here only because a CPU with no better option can still run it. Not measured here.",
    },
  ],
};
