/**
 * THE downloader — every file the app fetches from the network comes
 * through here: OCR and Computer-Use models from HuggingFace, speech models,
 * the Supertonic voice, the portable Podman zip from GitHub releases.
 *
 * One path, because the hard-won lessons were being relearned per subsystem:
 * the OCR installer grew resume, verification, locks and stall budgets while
 * the speech installers still lost 398 MB to a single dropped connection.
 * Everything here was observed on a real machine — `UND_ERR_SOCKET`
 * mid-file, sockets that go quiet without closing, a sidecar at exactly its
 * published size with a bad hash, three app instances appending to one
 * `.part` — and each observation became a rule:
 *
 *  - PROGRESS IS STATE, NOT ARITHMETIC. A file reports the absolute bytes
 *    it holds; callers derive their bars from that. Deltas drifted and
 *    jittered; an absolute value cannot.
 *  - Resume with Range (verified byte-exact across eight forced seams
 *    against the real HF CDN); a server that ignores the Range gets its
 *    full copy written over the part.
 *  - An attempt that receives nothing for `idleMs` aborts into the ordinary
 *    retry path — a silent socket must not freeze a download.
 *  - The retry budget counts CONSECUTIVE attempts that added nothing; drops
 *    with progress in between never exhaust it.
 *  - Verification failure (size or sha) wipes the part and re-downloads
 *    clean, once — corruption that survives a clean single-writer pass is
 *    not the network.
 *  - A lock file beside the target makes downloads exclusive across
 *    processes, heartbeaten while bytes land so "stale" can only mean a
 *    crash. A writer that ignores the lock (an older build sharing the data
 *    dir) is caught by the seam checks and named, instead of surfacing as
 *    a checksum riddle three passes later.
 */

import { createHash } from "crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  rmSync,
  statSync,
  utimesSync,
} from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

/** What the caller knows about the file. Both optional: an unsized download
 * (a GitHub zip) completes at stream end and skips the size check. */
export interface DownloadExpect {
  size?: number;
  sha256?: string;
}

export interface DownloadOpts {
  signal?: AbortSignal;
  /** Absolute bytes this file currently holds — never a delta. */
  onBytes?: (bytes: number) => void;
  /** Extra request headers (a token for a private source, a user-agent). */
  headers?: Record<string, string>;
  /** Consecutive zero-progress attempts before the file is declared stuck. */
  stallBudget?: number;
  /** Longest an attempt may go without a byte before it aborts and retries. */
  idleMs?: number;
}

/** One entry of a multi-file download. */
export interface DownloadItem extends DownloadExpect {
  url: string;
  /** Path relative to the set's base dir (or absolute when baseDir is ""). */
  path: string;
}

// ─── Tunables ───────────────────────────────────────────────────────────────

const IDLE_MS = 30_000;
const STALL_BUDGET = 6;
/** Wipe-and-redownload rounds before a verification failure is fatal. */
const CLEAN_PASSES = 1;
/** A lock whose owner hasn't touched it for this long is a corpse. Owners
 * touch their lock as bytes land, so this only reaps crashes. */
const LOCK_STALE_MS = 90_000;

const FOREIGN_WRITER_ERROR =
  "another app instance is writing this file — close other Code Monet windows (including an installed copy) and retry";

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

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * undici reports every network-level failure as the two words "fetch
 * failed" and hides the actual reason one `cause` down. Unwrap the chain:
 * "connect ECONNRESET" is the difference between "try again in a minute"
 * and "that repo does not exist".
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let hops = 0; cur != null && hops < 4; hops++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    const code = (cur as { code?: string }).code;
    parts.push(code && !msg.includes(code) ? `${msg} (${code})` : msg);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  const seen = new Set<string>();
  const unique = parts.filter((p) => !seen.has(p) && (seen.add(p), true));
  // The generic wrapper adds nothing once a specific layer follows it.
  if (unique.length > 1 && unique[0] === "fetch failed") unique.shift();
  return unique.join(" — ");
}

// ─── Cross-process exclusivity ──────────────────────────────────────────────

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

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

/** The heartbeat: called on every data event, throttled here. */
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

// ─── One file ───────────────────────────────────────────────────────────────

/**
 * Download one file: resume, verify, self-heal, and refuse to share the
 * write with anyone.
 */
export async function downloadFile(
  url: string,
  target: string,
  expect: DownloadExpect = {},
  opts: DownloadOpts = {},
): Promise<void> {
  const signal = opts.signal ?? new AbortController().signal;
  const onBytes = opts.onBytes ?? ((): void => {});
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
        // The seam tripwire for a writer that doesn't honour our lock (an
        // OLDER build sharing the data dir): the file changed size between
        // attempts and we didn't do it. Failing by name beats gigabyte-
        // sized passes that end in "checksum mismatch".
        const disk = await sizeOf(part);
        if (disk !== have) throw new Error(FOREIGN_WRITER_ERROR);
        const before = have;
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
          const headers: Record<string, string> = { ...opts.headers };
          if (have > 0) headers.Range = `bytes=${have}-`;
          const res = await fetch(url, { headers, signal: attempt.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          // 206 = the resume was honoured. 200 against a Range means the
          // server is sending the whole file — accept it over the part.
          if (have > 0 && res.status !== 206) {
            have = 0;
            onBytes(0);
          }
          // Counting happens INSIDE the pipeline, never via a `data` listener
          // beside the pipe. The listener pattern is a documented wound: it
          // put the stream in flowing mode alongside the pipe's own
          // consumption, and what landed on disk was the right length with
          // the wrong bytes — a 225 MB ONNX that killed the recognizer with
          // no message. A Transform only sees a chunk on its way THROUGH to
          // the file, so the count and the disk cannot disagree.
          const count = new Transform({
            transform(chunk: Buffer, _enc, cb): void {
              armIdle();
              touchLock();
              have += chunk.length;
              onBytes(have);
              cb(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(res.body as never),
            count,
            createWriteStream(part, { flags: have === 0 ? "w" : "a" }),
          );
          if (expect.size && have < expect.size)
            throw new Error(
              `connection closed at ${have} of ${expect.size} bytes`,
            );
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

      // The mid-stream half of the tripwire: everything we streamed was
      // appended by us, so the file must weigh exactly what we counted. More
      // means a lock-ignorant writer interleaved DURING the stream — catch
      // it here, at this file, not at a checksum three passes later.
      const finalSize = await sizeOf(part);
      if (finalSize !== have && have > 0) throw new Error(FOREIGN_WRITER_ERROR);
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
      // same way — wipe and go again from nothing, once.
      await rm(part, { force: true });
      onBytes(0);
      if (pass >= CLEAN_PASSES)
        throw new Error(
          sizeOk
            ? "checksum mismatch even after a clean re-download — if another copy of the app is open (an installed one beside this dev run), close it: two apps downloading into one folder corrupt the file"
            : `is ${finalSize} bytes, expected ${expect.size}`,
        );
    }
  } finally {
    releaseLock();
  }
}

// ─── A set of files, one bar ────────────────────────────────────────────────

/**
 * Download every item into `baseDir`, reporting ABSOLUTE totals. Items
 * already complete on disk are counted, not re-fetched.
 */
export async function downloadSet(
  baseDir: string,
  items: DownloadItem[],
  opts: DownloadOpts & {
    report?: (loaded: number, file: string) => void;
  } = {},
): Promise<void> {
  const report = opts.report ?? ((): void => {});
  let done = 0;
  for (const f of items) {
    const target = join(baseDir, f.path);
    if (f.size && (await sizeOf(target)) === f.size) {
      done += f.size;
      report(done, f.path);
      continue;
    }
    report(done, f.path);
    const base = done;
    await downloadFile(
      f.url,
      target,
      { size: f.size, sha256: f.sha256 },
      { ...opts, onBytes: (bytes) => report(base + bytes, f.path) },
    );
    done = base + (f.size || (await sizeOf(target)));
    report(done, f.path);
  }
}

// ─── HuggingFace manifests ──────────────────────────────────────────────────

export interface HfFile {
  path: string;
  size: number;
  sha256?: string;
}

const MANIFEST_MS = 20_000;

/** A HF repo's manifest: what each file weighs and what it should hash to.
 * Retried, because it used to be an install's single point of failure: the
 * file downloads survive twenty drops, but one refused connect on this
 * small API call killed the whole click. Network errors, 5xx and 429 get
 * three tries; a 4xx is a wrong repo and no retry will fix it. */
export async function hfManifest(
  repo: string,
  signal: AbortSignal,
): Promise<Map<string, HfFile>> {
  let res: Response | null = null;
  for (let attempt = 1; res === null; attempt++) {
    try {
      // Capped like an attempt: a stalled API call used to freeze an install
      // before its first progress event, which read as a dead button.
      const r = await fetch(
        `https://huggingface.co/api/models/${repo}?blobs=true`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_MS)]) },
      );
      if (!r.ok) {
        const e = new Error(`Model index: HTTP ${r.status}`);
        if (r.status < 500 && r.status !== 429)
          (e as { permanent?: boolean }).permanent = true;
        throw e;
      }
      res = r;
    } catch (err) {
      if (signal.aborted) throw new Error("Download cancelled");
      if ((err as { permanent?: boolean }).permanent || attempt >= 3) throw err;
      await delay(1_500 * attempt);
    }
  }
  const json = (await res.json()) as {
    siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string } }[];
  };
  const out = new Map<string, HfFile>();
  for (const s of json.siblings ?? [])
    out.set(s.rfilename, {
      path: s.rfilename,
      size: s.size ?? 0,
      sha256: s.lfs?.sha256,
    });
  return out;
}

export function hfUrl(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`;
}
