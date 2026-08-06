/**
 * The models the app knows about.
 *
 * One file each, listed here. To add a model: write the file, import it,
 * add it to ALL_MODELS. To take one out of the app WITHOUT losing what was
 * learned about it, set `enabled: false` in its own file — the entry stays,
 * with its measurements and the reason it was shelved.
 *
 * Everything downstream asks `ocrModels()`, which is the enabled ones.
 */

import { glmOcr } from "./glm-ocr.js";
import { lightOnOcr } from "./lightonocr.js";
import { paddleOcrVl } from "./paddleocr-vl.js";
import { qwen3Vl } from "./qwen3-vl.js";
import type { OcrModelInfo } from "./types.js";

/** Every model, including the shelved ones. Order is the UI's order. */
export const ALL_MODELS: OcrModelInfo[] = [
  lightOnOcr,
  glmOcr,
  qwen3Vl,
  paddleOcrVl,
];

/** The models the app offers. */
export function ocrModels(): OcrModelInfo[] {
  return ALL_MODELS.filter((m) => m.enabled);
}

/** A model by id — enabled or not, because a config may still name a
 * shelved one and the caller deserves a straight answer about it. */
export function findModel(id: string): OcrModelInfo | undefined {
  return ALL_MODELS.find((m) => m.id === id);
}

export type { OcrModelInfo } from "./types.js";
