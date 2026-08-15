/**
 * Installing an OCR model — downloading a gigabyte over a connection that
 * WILL drop, silently stall, and occasionally hand back wrong bytes, into a
 * data dir that more than one running copy of the app may share.
 *
 * None of that is pessimism; every clause was observed on a real machine:
 * `UND_ERR_SOCKET` mid-file, sockets that go quiet without closing, a
 * sidecar at exactly its published size with a bad hash, and three app
 * instances appending to one `.part`. The design answers each observation:
 *
 *  - PROGRESS IS STATE, NOT ARITHMETIC. A file reports the absolute bytes it
 *    holds; the installer derives the bar from that. The previous delta
 *    scheme needed corrective negative deltas in five places and drifted or
 *    jumped whenever an edge case fired — an absolute value cannot drift,
 *    and a walk-back on the bar now only ever means bytes really were
 *    discarded.
 *  - Resume with Range; a server that ignores the Range gets its full copy
 *    written over the part. (No shadow ".fresh" copy: a server that ignored
 *    one Range will ignore the next, so bytes it can't resume into are not
 *    progress, just bookkeeping.)
 *  - An attempt that receives nothing for IDLE_MS aborts into the ordinary
 *    retry path — a silent socket must not freeze the install.
 *  - The retry budget counts CONSECUTIVE attempts that added nothing. Drops
 *    with progress in between never exhaust it; six dead tries in a row do.
 *  - Verification failure (size or sha) wipes the part and re-downloads
 *    clean; only repeated wrong verdicts are an error.
 *  - A lock file beside the target makes downloads exclusive ACROSS
 *    processes, and the downloader keeps the lock's mtime fresh while it
 *    works — a lock is stale only when its owner has stopped touching it,
 *    not merely because the file is big and the link is slow.
 *  - A finished install writes a receipt of what it wrote; "installed"
 *    means the receipt still matches the disk (see installState).
 *
 * Layout on disk mirrors what transformers.js expects of a local model
 * directory — `<ocr-models>/<owner>/<repo>/<path>` — so the loader finds the
 * files with no adapter and no monkey-patching of its cache.
 */

import { createHash } from "crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
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

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Longest an attempt may go without a single byte before it is aborted and
 * retried. A stalled socket (open, but silent) throws nothing on its own. */
const IDLE_MS = 30_000;

/** The manifest is a small API response; 20 s of nothing is a dead link. */
const MANIFEST_MS = 20_000;

/** Consecutive zero-progress attempts before a file is declared stuck. */
const STALL_BUDGET = 6;

/** Wipe-and-redownload rounds before a verification failure is fatal. */
const CLEAN_PASSES = 2;

/** A lock whose owner hasn't touched it for this long is a corpse. Owners
 * touch their lock on every progress beat, so a LIVE download of any size
 * keeps its lock fresh — this only reaps crashes. */
const LOCK_STALE_MS = 90_000;

const installing = new Map<string, AbortController>();

// ─── Small helpers ──────────────────────────────────────────────────────────

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

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Where one model's files live. */
export function modelDir(model: OcrModelInfo): string {
  return join(ocrModelsDir(), ...model.repo.split("/"));
}

// ─── Cross-process exclusivity ──────────────────────────────────────────────

/**
 * One downloader per target file, across processes.
 *
 * The `installing` map guards one process only, and this app has no
 * single-instance lock — a packaged install and a dev run sharing a data dir
 * can install the same model at once, and two appends into one `.part`
 * interleave into a file of the right size with the wrong bytes.
 *
 * The lock is a `wx`-created file. The OWNER refreshes its mtime on every
 * progress beat (touchLock); staleness therefore means "the owner stopped",
 * not "the file is big" — the previous fixed two-minute rule broke LIVE
 * locks mid-download and reopened the exact corruption it existed to stop.
 */
function acquireLock(target: string): () => void {
  const lock = `${target}.lock`;
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      return () => {
        try {
          rmSync(lock, { force: true });
        } catch {
          /* best-effort */
        }
      };
    } catch {
      // mtime 0 = the lock vanished between the create attempt and the stat
      // — retry the create rather than refusing over a ghost.
      const m = mtimeOf(lock);
      if (i === 0 && (m === 0 || Date.now() - m > LOCK_STALE_MS)) {
        try {
          rmSync(lock, { force: true });
        } catch {
          /* someone else reaped it first */
        }
        continue;
      }
      throw new Error("Already downloading in another window");
    }
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The heartbeat: cheap enough to call on every data event, throttled here. */
function makeLockToucher(target: string): () => void {
  const lock = `${target}.lock`;
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < 5_000) return;
    last = now;
    try {
      const t = new Date();
      utimesSync(lock, t, t);
    } catch {
      /* the lock vanished; the download itself is unaffected */
    }
  };
}

// ─── The manifest and the plan ──────────────────────────────────────────────

/** A repo's manifest: what each file weighs and what it should hash to. */
async function fetchManifest(
  repo: string,
  signal: AbortSignal,
): Promise<Map<string, RepoFile>> {
  // Capped like an attempt: a stalled API call used to freeze the whole
  // install before the first progress event, which read as a dead button.
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_MS)]),
  });
  if (!res.ok) throw new Error(`Model index: HTTP ${res.status}`);
  const json = (await res.json()) as {
    siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string } }[];
  };
  const out = new Map<string, RepoFile>();
  for (const s of json.siblings ?? [])
    out.set(s.rfilename, {
      path: s.rfilename,
      size: s.size ?? 0,
      sha256: s.lfs?.sha256,
    });
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

// ─── One file ───────────────────────────────────────────────────────────────

/**
 * Download one file: resume, verify, self-heal.
 *
 * `onBytes` receives the ABSOLUTE number of bytes this file currently has —
 * never a delta. The caller derives whatever bar it wants from that; this
 * function's only progress obligation is to tell the truth.
 */
export async function downloadFile(
  url: string,
  target: string,
  expect: RepoFile,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  opts: { stallBudget?: number; idleMs?: number } = {},
): Promise<void> {
  const stallBudget = opts.stallBudget ?? STALL_BUDGET;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const part = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });

  const releaseLock = acquireLock(target);
  const touchLock = makeLockToucher(target);
  try {
    for (let pass = 0; ; pass++) {
      let have = await sizeOf(part);
      onBytes(have);

      for (let stalls = 0; !expect.size || have < expect.size; ) {
        const before = have;
        // The per-attempt controller: the outer signal aborts it, and so
        // does the idle timer — a socket that goes silent for IDLE_MS lands
        // in the same catch as one that closed.
        const attempt = new AbortController();
        const onOuterAbort = (): void => attempt.abort();
        signal.addEventListener("abort", onOuterAbort, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        const armIdle = (): void => {
          clearTimeout(idle);
          idle = setTimeout(() => attempt.abort(), idleMs);
        };
        try {
          armIdle();
          const headers: Record<string, string> = {};
          if (have > 0) headers.Range = `bytes=${have}-`;
          const res = await fetch(url, { headers, signal: attempt.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          // 206 = the resume was honoured. 200 against a Range means the
          // server is sending the whole file — accept it over the part.
          if (have > 0 && res.status !== 206) {
            have = 0;
            onBytes(0);
          }
          const body = Readable.fromWeb(res.body as never);
          body.on("data", (chunk: Buffer) => {
            armIdle();
            touchLock();
            have += chunk.length;
            onBytes(have);
          });
          await pipeline(
            body,
            createWriteStream(part, { flags: have === 0 ? "w" : "a" }),
          );
          if (expect.size && have < expect.size)
            throw new Error(`connection closed at ${have} of ${expect.size} bytes`);
          break; // stream ended and nothing is missing
        } catch (err) {
          if (signal.aborted) throw new Error("Download cancelled");
          // The stream may have counted bytes the disk never got: the file
          // is the truth, the counter follows it.
          have = await sizeOf(part);
          onBytes(have);
          stalls = have > before ? 0 : stalls + 1;
          if (stalls >= stallBudget) throw err;
          await delay(Math.min(15_000, 1_000 * (stalls + 1)));
        } finally {
          clearTimeout(idle);
          signal.removeEventListener("abort", onOuterAbort);
        }
      }

      const finalSize = await sizeOf(part);
      const sizeOk = !expect.size || finalSize === expect.size;
      // Size is not integrity: this store has seen a file of exactly the
      // right length with the wrong bytes, and a corrupt ONNX does not fail
      // politely.
      const hashOk =
        sizeOk && (!expect.sha256 || (await sha256Of(part)) === expect.sha256);
      if (sizeOk && hashOk) {
        await rename(part, target);
        onBytes(finalSize);
        return;
      }

      // Verified wrong. These bytes would fail every future attempt the
      // same way — wipe and go again from nothing, a bounded number of times.
      await rm(part, { force: true });
      onBytes(0);
      if (pass >= CLEAN_PASSES)
        throw new Error(
          sizeOk
            ? "checksum mismatch even after clean re-downloads"
            : `is ${finalSize} bytes, expected ${expect.size}`,
        );
    }
  } finally {
    releaseLock();
  }
}

// ─── A set of files, with one progress bar ──────────────────────────────────

/**
 * Download every file in the plan into `dir`, reporting ABSOLUTE totals.
 * Files already complete on disk are counted, not re-fetched. This is the
 * one installer both the model install and the layout install go through.
 */
async function downloadSet(
  dir: string,
  urlOf: (f: RepoFile) => string,
  plan: RepoFile[],
  signal: AbortSignal,
  report: (loaded: number, file: string) => void,
): Promise<void> {
  let done = 0;
  for (const f of plan) {
    const target = join(dir, f.path);
    if (f.size > 0 && (await sizeOf(target)) === f.size) {
      done += f.size;
      report(done, f.path);
      continue;
    }
    report(done, f.path);
    const base = done;
    await downloadFile(urlOf(f), target, f, signal, (bytes) =>
      report(base + bytes, f.path),
    );
    done = base + (f.size || (await sizeOf(target)));
    report(done, f.path);
  }
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
    const manifest = await fetchManifest(model.repo, controller.signal);
    const plan = planInstall(model, dtype, manifest);
    total = plan.reduce((n, f) => n + f.size, 0);
    const report = makeReporter(onProgress, { modelId, dtype }, total);

    await downloadSet(
      dir,
      (f) => `https://huggingface.co/${model.repo}/resolve/main/${f.path}`,
      plan,
      controller.signal,
      (l, file) => {
        loaded = l;
        report(l, file);
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
 * The layout detector and friends: single-file installs with no variants.
 * Same downloader, same resume, same checksum, same lock — via the same
 * downloadSet as the big models, so there is exactly one code path that
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
    const manifest = await fetchManifest(repo, controller.signal);
    const entry = manifest.get(file);
    if (!entry) throw new Error(`${repo} publishes no ${file}`);
    total = entry.size;
    const report = makeReporter(
      onProgress,
      { modelId: "layout", dtype: "q4" },
      total,
    );
    await downloadSet(dir, () => `https://huggingface.co/${repo}/resolve/main/${file}`, [entry], controller.signal, (l, f) => {
      loaded = l;
      report(l, f);
    });
    onProgress({ modelId: "layout", dtype: "q4", loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = controller.signal.aborted
      ? "Download cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
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
