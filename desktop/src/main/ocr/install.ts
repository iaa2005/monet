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
import { createReadStream, createWriteStream, statSync } from "fs";
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
 * Is this model+variant installed, answered synchronously?
 *
 * The tool list is assembled without awaiting anything, and "does the agent
 * get an OCR tool" has to be answerable there.
 */
export function isInstalledSync(model: OcrModelInfo, dtype: OcrDtype): boolean {
  const dir = modelDir(model);
  const { required } = variantFiles(model, dtype);
  for (const path of [...required, "config.json", "tokenizer.json"]) {
    try {
      if (statSyncSize(join(dir, path)) === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Is this model+variant fully installed? */
export async function isInstalled(
  model: OcrModelInfo,
  dtype: OcrDtype,
): Promise<boolean> {
  const dir = modelDir(model);
  const { required } = variantFiles(model, dtype);
  for (const path of [...required, "config.json", "tokenizer.json"]) {
    if ((await sizeOf(join(dir, path))) === 0) return false;
  }
  return true;
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
