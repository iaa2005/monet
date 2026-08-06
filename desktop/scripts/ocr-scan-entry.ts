/**
 * What the end-to-end OCR probe needs, in one module.
 *
 * The probe runs under Electron and requires a CommonJS bundle; this is the
 * entry esbuild bundles for it, so the probe imports the app's real modules
 * rather than a reimplementation of them.
 */

export { registerRasteriserIPC, closeRasteriser } from "../src/main/ocr/render.js";
export { scanDocument } from "../src/main/ocr/scan.js";
export { disposeOcrEngine } from "../src/main/ocr/engine.js";
// The suite switches models between runs, so it needs the settings and the
// registry as well as the scanner.
export { getOcrConfig, setOcrConfig } from "../src/main/ocr/settings.js";
export { ALL_MODELS } from "../src/main/ocr/catalog.js";
