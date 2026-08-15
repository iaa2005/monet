/**
 * Installing an OCR model — the OCR-specific half of a download.
 *
 * The transport (resume, verification, locks, retry budgets, progress) is
 * net/download.ts, shared by every downloader in the app. What lives HERE is
 * what only OCR knows: which files a variant needs (the plan), what a
 * finished install wrote (the receipt), and what "installed" means for a
 * model whose weight sidecars are optional by name but not by mass.
 *
 * Layout on disk mirrors what transformers.js expects of a local model
 * directory — `<ocr-models>/<owner>/<repo>/<path>` — so the loader finds the
 * files with no adapter and no monkey-patching of its cache.
 */

import { readFileSync, statSync, writeFileSync } from "fs";
import { rm, stat } from "fs/promises";
import { join } from "path";
import {
  describeError,
  downloadSet,
  hfManifest,
  hfUrl,
  type HfFile,
} from "../net/download.js";
import {
  CONFIG_FILES,
  ocrModel,
  ocrVariant,
  variantFiles,
  type OcrDtype,
  type OcrModelInfo,
} from "./catalog.js";
import { ocrModelsDir } from "./settings.js";

// The probes (and any future caller) reach the transport through this
// module, so the OCR entry stays one import for both halves.
export { describeError, downloadFile } from "../net/download.js";

export interface OcrInstallProgress {
  modelId: string;
  dtype: OcrDtype;
  loaded: number;
  total: number;
  percent: number;
  /** The file being fetched, for a UI that would otherwise sit at 3%. */
  file?: string;
  done?: boolean;
  error?: string;
}

type ProgressFn = (p: OcrInstallProgress) => void;

const installing = new Map<string, AbortController>();

function statSyncSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Where one model's files live. */
export function modelDir(model: OcrModelInfo): string {
  return join(ocrModelsDir(), ...model.repo.split("/"));
}

/**
 * Which files this install needs, with their published sizes.
 *
 * A required file missing from the repo is a broken catalogue entry and says
 * so by name; an optional sidecar missing is normal and is dropped.
 */
export function planInstall(
  model: OcrModelInfo,
  dtype: OcrDtype,
  manifest: Map<string, HfFile>,
): HfFile[] {
  const { required, optional } = variantFiles(model, dtype);
  const plan: HfFile[] = [];
  for (const path of [...CONFIG_FILES, ...required]) {
    const f = manifest.get(path);
    if (!f) {
      if (CONFIG_FILES.includes(path)) continue; // some repos omit a template
      throw new Error(`${model.repo} publishes no ${path}`);
    }
    plan.push(f);
  }
  for (const path of optional) {
    const f = manifest.get(path);
    if (f) plan.push(f);
  }
  return plan;
}

// ─── The receipt, and what "installed" means ────────────────────────────────

/**
 * The receipt: what a finished install actually wrote.
 *
 * Guessing the file list from the catalogue is what made a HALF-installed
 * model report itself as ready: the `.onnx_data` sidecars are "optional" at
 * PLANNING time (a component small enough to fit in its protobuf has none),
 * but once the repo publishes one, the graph beside it is a shell pointing
 * into it — and a missing sidecar fails inside onnxruntime as `file_size:
 * The system cannot find the file specified`, hundreds of megabytes after
 * the settings page said "installed". The download order makes that the
 * LIKELY failure: graphs are small and come first, sidecars are the
 * gigabyte and come last.
 *
 * So a completed install records what it wrote, and "installed" means the
 * record still matches the disk. No inference, no network.
 */
const RECEIPT = ".monet-install.json";

interface Receipt {
  /** dtype → the files that install wrote, with the sizes it wrote. */
  variants: Record<string, { path: string; size: number }[]>;
}

function readReceipt(dir: string): Receipt | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, RECEIPT), "utf-8")) as Receipt;
    return raw && typeof raw === "object" && raw.variants ? raw : null;
  } catch {
    return null;
  }
}

function writeReceipt(
  dir: string,
  dtype: OcrDtype,
  files: { path: string; size: number }[],
): void {
  try {
    const cur = readReceipt(dir) ?? { variants: {} };
    cur.variants[dtype] = files;
    writeFileSync(join(dir, RECEIPT), JSON.stringify(cur, null, 2), "utf-8");
  } catch {
    /* a receipt we cannot write costs a re-verify, not a failed install */
  }
}

export type OcrInstallState = "installed" | "partial" | "missing";

/**
 * Installed, half-installed, or absent — synchronously.
 *
 * With a receipt this is exact. Without one (an install from before receipts
 * existed) it falls back to a roll-call of names PLUS two tells the old
 * check lacked: a `.part` anywhere means a download stopped mid-way, and a
 * folder carrying well under the variant's published weight is missing its
 * sidecars whatever the names say — "optional by name" is how a download
 * that died exactly between files used to pass as installed.
 */
export function installState(
  model: OcrModelInfo,
  dtype: OcrDtype,
): OcrInstallState {
  const dir = modelDir(model);
  const { required, optional } = variantFiles(model, dtype);

  const receipt = readReceipt(dir)?.variants[dtype];
  if (receipt) {
    let anything = false;
    for (const f of receipt) {
      const size = statSyncSize(join(dir, f.path));
      if (size > 0) anything = true;
      if (size !== f.size) return anything ? "partial" : "missing";
    }
    return "installed";
  }

  // No receipt: an install from an older build, or one that never finished.
  const partial = [...required, ...optional].some(
    (p) => statSyncSize(join(dir, `${p}.part`)) > 0,
  );
  let present = 0;
  let missing = 0;
  let onDisk = 0;
  for (const path of [...required, "config.json", "tokenizer.json"]) {
    const size = statSyncSize(join(dir, path));
    if (size > 0) present++;
    else missing++;
    onDisk += size;
  }
  for (const path of optional) onDisk += statSyncSize(join(dir, path));
  if (missing > 0 || partial) return present > 0 ? "partial" : "missing";
  const variant = model.variants.find((v) => v.dtype === dtype);
  if (variant?.bytes && onDisk < variant.bytes * 0.9)
    return present > 0 ? "partial" : "missing";
  return "installed";
}

/**
 * Is this model+variant installed, answered synchronously?
 *
 * The tool list is assembled without awaiting anything, and "does the agent
 * get an OCR tool" has to be answerable there.
 */
export function isInstalledSync(model: OcrModelInfo, dtype: OcrDtype): boolean {
  return installState(model, dtype) === "installed";
}

/** Is this model+variant fully installed? */
export async function isInstalled(
  model: OcrModelInfo,
  dtype: OcrDtype,
): Promise<boolean> {
  return installState(model, dtype) === "installed";
}

/** Bytes of this variant already on disk — a part-installed model reports
 * what it has rather than pretending to be absent. */
export async function bytesOnDisk(
  model: OcrModelInfo,
  dtype: OcrDtype,
): Promise<number> {
  const dir = modelDir(model);
  const { required, optional } = variantFiles(model, dtype);
  let total = 0;
  for (const path of [...required, ...optional]) {
    total += await sizeOf(join(dir, path));
    total += await sizeOf(join(dir, `${path}.part`));
  }
  return total;
}

// ─── The installers ─────────────────────────────────────────────────────────

/** Progress reporter with the throttle both installers want: an event per
 * percent step or file change, not per network chunk. */
function makeReporter(
  onProgress: ProgressFn,
  meta: { modelId: string; dtype: OcrDtype },
  total: number,
): (loaded: number, file: string) => void {
  let lastPercent = -1;
  let lastFile = "";
  return (loaded, file) => {
    const percent = total
      ? Math.min(99, Math.floor((loaded / total) * 100))
      : 0;
    if (percent === lastPercent && file === lastFile) return;
    lastPercent = percent;
    lastFile = file;
    onProgress({ ...meta, loaded, total, percent, file });
  };
}

export async function installOcrModel(
  modelId: string,
  dtype: OcrDtype,
  onProgress: ProgressFn,
): Promise<{ ok: boolean; error?: string }> {
  const model = ocrModel(modelId);
  if (!model) return { ok: false, error: `Unknown model ${modelId}` };
  if (!ocrVariant(model, dtype))
    return { ok: false, error: `${model.label} has no ${dtype} weights` };
  const key = `${modelId}:${dtype}`;
  if (installing.has(key)) return { ok: false, error: "Already downloading" };

  const controller = new AbortController();
  installing.set(key, controller);
  const dir = modelDir(model);
  let loaded = 0;
  let total = 0;
  try {
    const manifest = await hfManifest(model.repo, controller.signal);
    const plan = planInstall(model, dtype, manifest);
    total = plan.reduce((n, f) => n + f.size, 0);
    const report = makeReporter(onProgress, { modelId, dtype }, total);

    await downloadSet(
      dir,
      plan.map((f) => ({ ...f, url: hfUrl(model.repo, f.path) })),
      {
        signal: controller.signal,
        report: (l, file) => {
          loaded = l;
          report(l, file);
        },
      },
    );

    // The receipt is written ONLY here, after every file in the plan landed:
    // it is the difference between "these files exist" and "this install
    // finished", and the sidecars are why that difference matters.
    writeReceipt(
      dir,
      dtype,
      plan.map((f) => ({ path: f.path, size: f.size })),
    );
    onProgress({ modelId, dtype, loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = controller.signal.aborted
      ? "Download cancelled"
      : describeError(err);
    // Half a model stays on disk on purpose: the `.part` files are what make
    // the next attempt a resume instead of a gigabyte done twice. What must
    // not survive is anything that LOOKS installed, and nothing incomplete
    // was ever renamed off `.part`.
    onProgress({ modelId, dtype, loaded, total, percent: 0, done: true, error });
    return { ok: false, error };
  } finally {
    installing.delete(key);
  }
}

/**
 * The layout detector and friends: single-file installs with no variants.
 * Same transport as the big models — there is exactly one code path that
 * talks to the network.
 */
export async function installLayoutModel(
  repo: string,
  file: string,
  onProgress: ProgressFn,
): Promise<{ ok: boolean; error?: string }> {
  const key = `layout:${repo}`;
  if (installing.has(key)) return { ok: false, error: "Already downloading" };
  const controller = new AbortController();
  installing.set(key, controller);
  const dir = join(ocrModelsDir(), ...repo.split("/"));
  let loaded = 0;
  let total = 0;
  try {
    const manifest = await hfManifest(repo, controller.signal);
    const entry = manifest.get(file);
    if (!entry) throw new Error(`${repo} publishes no ${file}`);
    total = entry.size;
    const report = makeReporter(
      onProgress,
      { modelId: "layout", dtype: "q4" },
      total,
    );
    await downloadSet(dir, [{ ...entry, url: hfUrl(repo, file) }], {
      signal: controller.signal,
      report: (l, f) => {
        loaded = l;
        report(l, f);
      },
    });
    onProgress({ modelId: "layout", dtype: "q4", loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = controller.signal.aborted
      ? "Download cancelled"
      : describeError(err);
    onProgress({ modelId: "layout", dtype: "q4", loaded, total, percent: 0, done: true, error });
    return { ok: false, error };
  } finally {
    installing.delete(key);
  }
}

/** Is the layout detector on disk? */
export function hasLayoutFile(repo: string, file: string): boolean {
  return statSyncSize(join(ocrModelsDir(), ...repo.split("/"), file)) > 0;
}

/**
 * The two models the fast path needs: the block finder and the line
 * detector.
 *
 * They install together because they fail together — a page taken apart
 * into blocks but never straightened is the wrong shape for the reader,
 * and a straightener with no blocks to straighten has nothing to do. The
 * line detector was for a long time not installed by ANYTHING: the code
 * that uses it guards on the file existing and returns "not crooked" when
 * it does not, so deskewing was silently off on every clean install.
 *
 * Here rather than in the IPC handler so a probe can call it.
 */
export async function installBlockFinder(
  onProgress: ProgressFn,
): Promise<{ ok: boolean; error?: string }> {
  const { LAYOUT_FILE, LAYOUT_REPO } = await import("./layout.js");
  const { DET_FILE, DET_REPO } = await import("./lines/detect.js");
  const layout = await installLayoutModel(LAYOUT_REPO, LAYOUT_FILE, onProgress);
  if (!layout.ok) return layout;
  return installLayoutModel(DET_REPO, DET_FILE, onProgress);
}

/** Are both of them there? */
export async function hasBlockFinder(): Promise<boolean> {
  const { LAYOUT_FILE, LAYOUT_REPO } = await import("./layout.js");
  const { DET_FILE, DET_REPO } = await import("./lines/detect.js");
  return (
    hasLayoutFile(LAYOUT_REPO, LAYOUT_FILE) && hasLayoutFile(DET_REPO, DET_FILE)
  );
}

export function cancelOcrInstall(modelId: string, dtype: OcrDtype): boolean {
  const c = installing.get(`${modelId}:${dtype}`);
  if (!c) return false;
  c.abort();
  return true;
}

export function isInstalling(modelId: string, dtype: OcrDtype): boolean {
  return installing.has(`${modelId}:${dtype}`);
}

/** Delete a model's files — every variant of it. */
export async function removeOcrModel(modelId: string): Promise<{ ok: boolean }> {
  const model = ocrModel(modelId);
  if (!model) return { ok: false };
  for (const v of model.variants) cancelOcrInstall(modelId, v.dtype);
  await rm(modelDir(model), { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}
