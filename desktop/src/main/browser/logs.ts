/**
 * Console and network traffic, written to files instead of into the context.
 *
 * The naive version returns the console after every action. A React dev build
 * warns a dozen times on first paint, so the model pays for that wall of text
 * on every click, and by the third one the actual error has scrolled out of
 * its attention. Writing to a file inverts it: the tool result carries a
 * one-line count, and the model reads the lines it asks for — with its own
 * Grep and Read, if it prefers, since the path is real.
 *
 * This file is the I/O. Turning CDP events into lines is log-format.ts.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import {
  filterLines,
  formatEvent,
  stampOf,
  type LogKind,
} from "./log-format.js";
import type { BrowserTransport } from "./transport.js";

export type { LogKind };

/** Past this, the oldest half is dropped. A dev server can be very chatty. */
const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 200;

interface Counters {
  errors: number;
  total: number;
}

interface LogState {
  off: () => void;
  buffers: Record<LogKind, string[]>;
  counts: Record<LogKind, Counters>;
  timer: NodeJS.Timeout | null;
  /** requestId → "GET /api/items", so a failure can name what failed. */
  inFlight: Map<string, string>;
}

const active = new Map<string, LogState>();

function logDir(): string {
  const dir = join(getDataSubdir("browser"), "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPath(targetId: string, kind: LogKind): string {
  return join(logDir(), `${targetId}-${kind}.log`);
}

/**
 * Start recording for this page, once.
 *
 * The CDP domains are enabled by the transport on attach rather than here:
 * Network and Log only report what happens after they are on, so a recorder
 * started on demand would hand back an empty file for a page that has been
 * running for a minute.
 */
export function ensureLogging(t: BrowserTransport): void {
  if (active.has(t.targetId)) return;

  const state: LogState = {
    off: () => undefined,
    buffers: { console: [], network: [] },
    counts: { console: { errors: 0, total: 0 }, network: { errors: 0, total: 0 } },
    timer: null,
    inFlight: new Map(),
  };

  state.off = t.onEvent((method, params) => {
    const out = formatEvent(method, params, state.inFlight, stampOf(new Date()));
    if (!out) return;
    if ("reset" in out) {
      state.counts.console = { errors: 0, total: 0 };
      state.counts.network = { errors: 0, total: 0 };
      state.inFlight.clear();
      return;
    }
    state.buffers[out.kind].push(out.line);
    state.counts[out.kind].total++;
    if (out.isError) state.counts[out.kind].errors++;
    if (!state.timer) state.timer = setTimeout(() => flush(t.targetId), FLUSH_MS);
  });

  active.set(t.targetId, state);
}

function flush(targetId: string): void {
  const state = active.get(targetId);
  if (!state) return;
  state.timer = null;
  for (const kind of ["console", "network"] as const) {
    const lines = state.buffers[kind];
    if (lines.length === 0) continue;
    state.buffers[kind] = [];
    const path = logPath(targetId, kind);
    try {
      appendFileSync(path, lines.join("\n") + "\n", "utf-8");
      if (statSync(path).size > MAX_BYTES) {
        const kept = readFileSync(path, "utf-8").split("\n");
        writeFileSync(path, kept.slice(Math.floor(kept.length / 2)).join("\n"), "utf-8");
      }
    } catch {
      /* logging must never break the action that produced it */
    }
  }
}

export function stopLogging(targetId: string): void {
  const state = active.get(targetId);
  if (!state) return;
  flush(targetId);
  state.off();
  active.delete(targetId);
}

/** "console: 2 errors in 31 messages" — the hint that goes on a tool result. */
export function logSummary(targetId: string): string {
  const state = active.get(targetId);
  if (!state) return "";
  const parts: string[] = [];
  for (const kind of ["console", "network"] as const) {
    const c = state.counts[kind];
    if (c.total === 0) continue;
    const noun = kind === "console" ? "messages" : "requests";
    parts.push(
      c.errors > 0
        ? `${kind}: ${c.errors} error${c.errors === 1 ? "" : "s"} in ${c.total} ${noun}`
        : `${kind}: ${c.total} ${noun}`,
    );
  }
  return parts.join(", ");
}

export interface LogRead {
  lines: string[];
  /** Lines in the file, before filtering — so the model knows what it skipped. */
  total: number;
  matched: number;
  path: string;
}

export function readLog(
  targetId: string,
  kind: LogKind,
  opts: { grep?: string; level?: "error" | "warn"; limit?: number } = {},
): LogRead {
  const path = logPath(targetId, kind);
  // Anything still buffered belongs in the answer: the model usually asks
  // right after the action that produced the line it is looking for.
  flush(targetId);
  let all: string[] = [];
  try {
    all = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  } catch {
    all = [];
  }
  const { lines, matched } = filterLines(all, opts);
  return { lines, total: all.length, matched, path };
}
