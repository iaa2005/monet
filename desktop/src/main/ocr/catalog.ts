/**
 * The catalogue — arithmetic over the model registry, and nothing else.
 *
 * The models themselves live one per file in `models/`, where each carries
 * what was measured about it and why it is on or off. This file answers the
 * questions the rest of the app asks about them: which files a variant
 * needs, how big it is, what to call the size.
 *
 * Why a scanner at all: a text-only model (DeepSeek, Kimi, most of what
 * people run) cannot see. Hand it a scanned page, a PDF full of formulas or
 * a screenshot and it is blind — it will write Python that shells out to
 * some library it hopes exists, and the answer is a guess about a picture
 * nobody looked at. An OCR model IS the eyes, and it belongs to the app
 * rather than to the chat model.
 *
 * Everything runs IN the app: `onnxruntime-node` with the WebGPU/CPU
 * backends it already ships, driven by `@huggingface/transformers` — or,
 * for one shelved model, by our own pipeline in `paddle/`. No Ollama, no
 * Python, no server: installing a model is downloading its weights.
 *
 * Pure data plus arithmetic here: no filesystem, no network, so the
 * catalogue is checkable without downloading a gigabyte.
 */

import { findModel, ocrModels } from "./models/index.js";
import type {
  OcrDevice,
  OcrEngine,
  OcrModelInfo,
  OcrDtype,
  OcrVariant,
} from "./models/types.js";

export type {
  OcrDevice,
  OcrDtype,
  OcrEngine,
  OcrModelInfo,
  OcrVariant,
} from "./models/types.js";
export { ALL_MODELS, ocrModels } from "./models/index.js";

/** The models on offer, in the order the UI shows them. */
export const OCR_MODELS: OcrModelInfo[] = ocrModels();

export function ocrEngineOf(model: OcrModelInfo): OcrEngine {
  return model.engine;
}

/**
 * The backends to try, in order, for a setting and a variant.
 *
 * "Automatic" used to mean "the graphics card, then the processor",
 * spelled into the loader. That is wrong for at least one model here:
 * PaddleOCR-VL is nearly three times faster on the PROCESSOR, because its
 * int8 matmuls have no WebGPU kernel and the run becomes fallback with
 * tensors shuttling back and forth. The catalogue records the measured
 * order per variant, and "Automatic" is the setting that says "you
 * decide" — so this is where it is decided.
 */
export function deviceOrder(
  setting: OcrDevice,
  preferred: ("webgpu" | "cpu")[] | undefined,
): ("webgpu" | "cpu")[] {
  if (setting !== "auto") return [setting];
  return preferred && preferred.length > 0 ? preferred : ["webgpu", "cpu"];
}

/** A model by id. A SHELVED model resolves too: a config that names one
 * should produce "that model is disabled", not "unknown model". */
export function ocrModel(id: string): OcrModelInfo | undefined {
  return findModel(id);
}

export function ocrVariant(
  model: OcrModelInfo,
  dtype: OcrDtype,
): OcrVariant | undefined {
  return model.variants.find((v) => v.dtype === dtype);
}

/**
 * The files one variant needs, as repo-relative paths.
 *
 * The `.onnx_data` sidecar is not always there — a component small enough to
 * fit in the protobuf has none — so this returns the CANDIDATES and the
 * installer keeps whichever the repo actually publishes.
 */
export function variantFiles(
  model: OcrModelInfo,
  dtype: OcrDtype,
): { required: string[]; optional: string[] } {
  // PaddleOCR-VL does not follow the transformers.js naming: its graphs are
  // `decoder`/`embedding`/`vision_encoder`, and the embedding table has no
  // quantised build at all — asking for `embedding_q4.onnx` would fail the
  // install on a file that does not exist and never will.
  if (model.engine === "paddle")
    return {
      required: [
        `onnx/vision_encoder_${dtype}.onnx`,
        `onnx/decoder_${dtype}.onnx`,
        "onnx/embedding.onnx",
      ],
      optional: ["onnx/embedding.onnx.data"],
    };

  const required: string[] = [];
  const optional: string[] = [];
  for (const c of model.components) {
    required.push(`onnx/${c}_${dtype}.onnx`);
    optional.push(`onnx/${c}_${dtype}.onnx_data`);
  }
  return { required, optional };
}

/**
 * The processor/tokenizer files, shared by every variant.
 *
 * transformers.js reads these by name; a missing one fails at load with a
 * 404-shaped error rather than anything about OCR, so they are listed
 * explicitly instead of being fetched on demand from the network. Models
 * disagree about which of them exist — a tokenizer may keep its vocabulary
 * inline or in `vocab.json` — so the installer treats every one as optional
 * and only complains about missing WEIGHTS.
 */
export const CONFIG_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
  "vocab.json",
  "merges.txt",
  "added_tokens.json",
  "special_tokens_map.json",
];

/** Human-readable size, for the UI and for tool output. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
