/**
 * OCR settings — which model reads documents, how, and how hard.
 *
 * Stored beside the other subsystem configs in <dataDir>/ocr.json. Nothing
 * here reaches the network or the filesystem beyond that one file: the engine
 * asks what it should do, this answers.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { OCR_MODELS, type OcrDevice, type OcrDtype } from "./catalog.js";

export interface OcrConfig {
  /** Model id from the catalogue. */
  modelId: string;
  dtype: OcrDtype;
  device: OcrDevice;
  /**
   * Rasterisation resolution. 150 DPI is the sweet spot measured on real
   * papers: 110 loses subscripts in formulas, 200 doubles the image tokens
   * (and the time) for nothing the model reads better.
   */
  dpi: number;
  /**
   * How many pages one scan may do before it stops and says so. A 300-page
   * book at two minutes a page is not a request anyone means to make.
   */
  maxPages: number;
  /** Tokens per page. A dense A4 page lands around 900. */
  maxTokensPerPage: number;
}

const DEFAULTS: OcrConfig = {
  modelId: OCR_MODELS[0].id,
  dtype: "q4",
  device: "auto",
  dpi: 150,
  maxPages: 40,
  maxTokensPerPage: 2048,
};

function configFile(): string {
  return join(getDataDir(), "ocr.json");
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(hi, Math.max(lo, Math.round(n)))
    : fallback;
}

export function getOcrConfig(): OcrConfig {
  try {
    if (!existsSync(configFile())) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(configFile(), "utf-8")) as Partial<OcrConfig>;
    return {
      modelId:
        typeof raw.modelId === "string" && OCR_MODELS.some((m) => m.id === raw.modelId)
          ? raw.modelId
          : DEFAULTS.modelId,
      dtype: raw.dtype === "fp16" || raw.dtype === "fp32" ? raw.dtype : DEFAULTS.dtype,
      device:
        raw.device === "webgpu" || raw.device === "cpu" ? raw.device : DEFAULTS.device,
      dpi: clamp(raw.dpi, 72, 300, DEFAULTS.dpi),
      maxPages: clamp(raw.maxPages, 1, 500, DEFAULTS.maxPages),
      maxTokensPerPage: clamp(raw.maxTokensPerPage, 256, 8192, DEFAULTS.maxTokensPerPage),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setOcrConfig(patch: Partial<OcrConfig>): OcrConfig {
  const next = { ...getOcrConfig(), ...patch };
  writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** Where installed weights live: one folder per repo, as transformers.js
 * lays them out, so the library's own loader finds them unaided. */
export function ocrModelsDir(): string {
  return join(getDataDir(), "ocr-models");
}
