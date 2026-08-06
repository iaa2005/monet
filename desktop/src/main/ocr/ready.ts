/**
 * "Is there an OCR model?", answered without touching the engine.
 *
 * Its own file on purpose: the tool registry asks this while assembling the
 * tool list, and importing engine.ts there would pull `child_process` and the
 * whole model runtime into a question about a directory listing.
 */

import { ocrModel } from "./catalog.js";
import { isInstalledSync } from "./install.js";
import { getOcrConfig } from "./settings.js";

export function hasOcrModel(): boolean {
  const cfg = getOcrConfig();
  const model = ocrModel(cfg.modelId);
  return !!model && isInstalledSync(model, cfg.dtype);
}
