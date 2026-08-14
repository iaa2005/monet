/**
 * Installing an OCR model — downloading a gigabyte over a connection that
 * will drop.
 *
 * That is not pessimism. Fetching these weights through the library's own
 * loader failed twice on the development machine, at 38 MB and at 103 MB,
 * with `UND_ERR_SOCKET: other side closed`; the library has no resume, so
 * each failure threw the download away. Everything here follows from that:
 * range requests, retries, `.part` files that are plainly unfinished, and a
 * verification pass at the end.
 *
 * Layout on disk mirrors what transformers.js expects of a local model
 * directory — `<ocr-models>/<owner>/<repo>/<path>` — so the loader finds the
 * files with no adapter and no monkey-patching of its cache.
 *
 * What gets downloaded is decided by the catalogue (one weight variant) plus
 * the repo's own manifest: a component with no `.onnx_data` sidecar simply
 * has none, and asking for it must not be an error.
 */

import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  CONFIG_FILES,
  ocrModel,
  ocrVariant,
  variantFiles,
  type OcrDtype,
  type OcrModelInfo,
} from "./catalog.js";
import { ocrModelsDir } from "./settings.js";

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

interface RepoFile {
  path: string;
  size: number;
  sha256?: string;
}

const installing = new Map<string, AbortController>();

function statSyncSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Where one model's files live. */
export function modelDir(model: OcrModelInfo): string {
  return join(ocrModelsDir(), ...model.repo.split("/"));
}

function fileUrl(model: OcrModelInfo, path: string): string {
  return `https://huggingface.co/${model.repo}/resolve/main/${path}`;
}

/** The repo's manifest: what each file weighs and what it should hash to. */
async function fetchManifest(
  model: OcrModelInfo,
  signal: AbortSignal,
): Promise<Map<string, RepoFile>> {
  const res = await fetch(
    `https://huggingface.co/api/models/${model.repo}?blobs=true`,
    { signal },
  );
  if (!res.ok) throw new Error(`Model index: HTTP ${res.status}`);
  const json = (await res.json()) as {
    siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string } }[];
  };
  const out = new Map<string, RepoFile>();
  for (const s of json.siblings ?? []) {
    out.set(s.rfilename, {
      path: s.rfilename,
      size: s.size ?? 0,
      sha256: s.lfs?.sha256,
    });
  }
  return out;
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
  manifest: Map<string, RepoFile>,
): RepoFile[] {
  const { required, optional } = variantFiles(model, dtype);
  const plan: RepoFile[] = [];
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

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * One file, resumed as many times as it takes.
 *
 * Bytes already in the `.part` are kept and asked for from where they stop —
 * a 400 MB file that dies at 380 MB must not start over. `onChunk` reports
 * absolute progress so a resumed download does not make the bar jump back.
 */
async function downloadFile(
  url: string,
  target: string,
  expect: RepoFile,
  signal: AbortSignal,
  onChunk: (deltaBytes: number) => void,
  attempts = 6,
): Promise<void> {
  const part = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });

  let have = await sizeOf(part);
  onChunk(have);

  for (let attempt = 1; ; attempt++) {
    if (expect.size && have >= expect.size) break;
    try {
      const headers: Record<string, string> = {};
      if (have > 0) headers.Range = `bytes=${have}-`;
      const res = await fetch(url, { headers, signal });
      // 206 = the resume was honoured; 200 with a Range asked means the
      // server ignored it and is sending the whole file from the start.
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const restarted = have > 0 && res.status !== 206;
      if (restarted) have = 0;

      const counted = Readable.fromWeb(res.body as never);
      counted.on("data", (chunk: Buffer) => {
        have += chunk.length;
        onChunk(chunk.length);
      });
      await pipeline(
        counted,
        createWriteStream(part, { flags: restarted || have === 0 ? "w" : "a" }),
      );
      if (!expect.size || have >= expect.size) break;
      throw new Error(`truncated at ${have} of ${expect.size} bytes`);
    } catch (err) {
      if (signal.aborted) throw new Error("Download cancelled");
      if (attempt >= attempts) throw err;
      // Whatever landed stays: the next attempt continues from there.
      have = await sizeOf(part);
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * attempt)));
    }
  }

  const finalSize = await sizeOf(part);
  if (expect.size && finalSize !== expect.size)
    throw new Error(`is ${finalSize} bytes, expected ${expect.size}`);
  // Size is not integrity: an earlier downloader elsewhere in this app once
  // produced a file of exactly the right length with the wrong bytes, and a
  // corrupt ONNX does not fail politely.
  if (expect.sha256) {
    const got = await sha256Of(part);
    if (got !== expect.sha256) throw new Error("checksum mismatch");
  }
  await rename(part, target);
}

/**
 * The receipt: what a finished install actually wrote.
 *
 * Guessing the file list from the catalogue is what made a HALF-installed
 * model report itself as ready. The `.onnx_data` sidecars are "optional" at
 * PLANNING time — a small component genuinely has none — but once the repo
 * publishes one, the graph beside it is a shell that points into it, and a
 * missing sidecar fails inside onnxruntime as
 * `file_size: The system cannot find the file specified`, hundreds of
 * megabytes after the settings page has said "installed".
 *
 * Worse, the download order makes that the LIKELY failure: the graphs come
 * first and are small, the sidecars come last and are the gigabyte. A drop
 * at 8% leaves every file the old check looked at present and correct.
 *
 * So a completed install records what it wrote, and "installed" means that
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
 * With a receipt this is exact. Without one (a model installed before
 * receipts existed) it falls back to the old file check PLUS the tell that
 * old check lacked: a `.part` file anywhere in the variant means a download
 * stopped in the middle, whatever else is on disk.
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
  for (const path of [...required, "config.json", "tokenizer.json"]) {
    if (statSyncSize(join(dir, path)) > 0) present++;
    else missing++;
  }
  if (missing > 0 || partial) return present > 0 ? "partial" : "missing";
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
  let lastPercent = -1;
  const report = (file?: string): void => {
    const percent = total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0;
    if (percent === lastPercent && file === undefined) return;
    lastPercent = percent;
    onProgress({ modelId, dtype, loaded, total, percent, file });
  };

  try {
    const manifest = await fetchManifest(model, controller.signal);
    const plan = planInstall(model, dtype, manifest);
    total = plan.reduce((n, f) => n + f.size, 0);

    for (const f of plan) {
      const target = join(dir, f.path);
      // Already whole from an earlier run: count it and move on.
      if ((await sizeOf(target)) === f.size && f.size > 0) {
        loaded += f.size;
        report(f.path);
        continue;
      }
      report(f.path);
      await downloadFile(
        fileUrl(model, f.path),
        target,
        f,
        controller.signal,
        (delta) => {
          loaded += delta;
          report();
        },
      );
    }
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
      : err instanceof Error
        ? err.message
        : String(err);
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
 * The layout detector, which is one file and no variants.
 *
 * It is a separate install from a reading model because it is a different
 * kind of thing: 124 MB that never changes, needed by the fast path and
 * useless on its own. Same downloader, same resume, same checksum.
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
  const target = join(ocrModelsDir(), ...repo.split("/"), file);
  let loaded = 0;
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${repo}?blobs=true`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`Model index: HTTP ${res.status}`);
    const json = (await res.json()) as {
      siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string } }[];
    };
    const entry = (json.siblings ?? []).find((s) => s.rfilename === file);
    if (!entry) throw new Error(`${repo} publishes no ${file}`);
    const expect: RepoFile = {
      path: file,
      size: entry.size ?? 0,
      sha256: entry.lfs?.sha256,
    };
    const total = expect.size;
    if (statSyncSize(target) === total && total > 0) {
      onProgress({ modelId: "layout", dtype: "q4", loaded: total, total, percent: 100, done: true });
      return { ok: true };
    }
    await downloadFile(
      `https://huggingface.co/${repo}/resolve/main/${file}`,
      target,
      expect,
      controller.signal,
      (delta) => {
        loaded += delta;
        onProgress({
          modelId: "layout",
          dtype: "q4",
          loaded,
          total,
          percent: total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0,
          file,
        });
      },
    );
    onProgress({ modelId: "layout", dtype: "q4", loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = controller.signal.aborted
      ? "Download cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
    onProgress({ modelId: "layout", dtype: "q4", loaded, total: 0, percent: 0, done: true, error });
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
