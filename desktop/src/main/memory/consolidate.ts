/**
 * Memory consolidation — the "dream".
 *
 * The nightly counterpart to the append-only daily log: one thoughtful pass
 * that reads the whole picture (every memory file + the logs written since the
 * last run + what the user has been working on) and reorganises it, instead of
 * many cheap per-turn passes each rewriting a file from an 8K keyhole.
 *
 * Modelled on the vendor's /dream: gather signal → merge into topic files,
 * dropping duplicates and contradicted facts → prune and rewrite the MEMORY.md
 * index. The model returns a JSON edit plan rather than free-writing files, so
 * every write goes through the store's validated ids and can't escape the
 * memory directory.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { extractJson } from "../llm/json-extract.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { resolveBackgroundModel } from "../provider/routing.js";
import { getSessionStore } from "../session/store.js";
import { pendingBulletCount, readLogsSince } from "./daily-log.js";
import {
  deleteMemoryFile,
  getMemoryConfig,
  isValidMemoryId,
  listMemoryFiles,
  readMemoryFile,
  slugifyMemoryName,
  writeMemoryFile,
  writeMemoryIndex,
} from "./store.js";

/** Don't re-dream more often than this (hours), except on force. */
const MIN_HOURS = 20;
/** Below this many new bullets there is nothing worth waking up for. */
const MIN_BULLETS = 3;

export interface ConsolidationState {
  lastConsolidatedAt: number;
  lastRunAt: number;
  lastSummary: string;
  lastError: string | null;
  /** Files written/removed by the last successful run. */
  lastTouched: string[];
  runs: number;
}

const EMPTY: ConsolidationState = {
  lastConsolidatedAt: 0,
  lastRunAt: 0,
  lastSummary: "",
  lastError: null,
  lastTouched: [],
  runs: 0,
};

function stateFile(): string {
  return join(getDataDir(), "memory-consolidation.json");
}

export function getConsolidationState(): ConsolidationState {
  try {
    return {
      ...EMPTY,
      ...(JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<ConsolidationState>),
    };
  } catch {
    return { ...EMPTY };
  }
}

function saveState(patch: Partial<ConsolidationState>): void {
  try {
    writeFileSync(
      stateFile(),
      JSON.stringify({ ...getConsolidationState(), ...patch }, null, 2),
      "utf-8",
    );
  } catch {
    /* state is advisory — a failed write just means we may re-run */
  }
}

const SYSTEM = `You are performing a "dream" — a reflective consolidation pass over an AI assistant's long-term memory of its user.

You receive: the CURRENT MEMORY files, the DAILY LOGS appended since the last consolidation (raw, unfiltered observations), and RECENT SESSIONS (what the user has been working on).

Your job: turn the raw logs into durable, well-organised memory, then rewrite the index.

Memory file ids:
- "profile" — who the user is: role, field, languages, stable preferences.
- "topics/<slug>" — a sustained interest, workflow or working preference.
- "areas/<slug>" — a long-running project.

Rules:
- MERGE, don't append blindly. The content you emit REPLACES the file: carry over still-valid facts, fold in the new ones, drop duplicates.
- Prefer updating an existing file over creating a near-duplicate.
- Convert relative dates ("yesterday", "last week") to absolute ones.
- Delete facts the logs contradict, and memories that are now stale or superseded.
- Do NOT save: secrets, one-off task details, anything derivable from the code, or things the assistant said about itself.
- Write names, summaries and content in the USER'S language.
- The index is an index, not a dump: one line per memory, a title plus a short hook.

Reply with ONLY JSON (no fences, no prose):
{"upserts": [{"id": "...", "name": "Short Title", "summary": "one line", "content": "full replacement markdown body"}],
 "deletes": ["topics/stale-thing"],
 "index": [{"id": "...", "title": "Short Title", "hook": "one-line hook, under ~120 chars"}],
 "summary": "one sentence on what you consolidated"}

"index" must list EVERY memory file that should exist after your upserts and deletes are applied — it replaces the index wholesale.

BUDGET — you have limited output, and a plan that gets cut off mid-way is wasted work:
- At most 6 upserts. Touch only files the new signal actually changes; leave the rest alone (a file you don't list is kept as-is).
- Keep each body under ~250 words: terse bullets, no preamble, no restating the file's own title.
- Emit "upserts" first, then "deletes", then "index", then "summary".`;

function currentMemoryBlock(): string {
  const files = listMemoryFiles();
  if (files.length === 0) return "(no memory files yet)";
  return files
    .map((f) => {
      const r = readMemoryFile(f.id);
      return `### id: ${f.id}\nname: ${f.name}\nsummary: ${f.summary}\n${(r.body ?? "").slice(0, 2_000)}`;
    })
    .join("\n\n")
    .slice(0, 14_000);
}

function recentSessionsBlock(since: number): string {
  try {
    const rows = getSessionStore()
      .list(200, 0)
      .filter((s) => new Date(s.updatedAt).getTime() >= since)
      .slice(0, 60);
    if (rows.length === 0) return "(none)";
    return rows
      .map((s) => `- [${String(s.updatedAt).slice(0, 10)}] "${s.title}" (${s.messageCount} msgs)`)
      .join("\n");
  } catch {
    return "(unavailable)";
  }
}

interface Plan {
  upserts?: { id?: unknown; name?: unknown; summary?: unknown; content?: unknown }[];
  deletes?: unknown[];
  index?: { id?: unknown; title?: unknown; hook?: unknown }[];
  summary?: unknown;
}

export { extractJson } from "../llm/json-extract.js";

/** Normalise a sloppy id ("topics/LaTeX Workflow") into a valid one. */
function normaliseId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let id = raw.trim().replace(/\.md$/i, "");
  const m = /^(topics|areas)\/(.+)$/.exec(id);
  if (m) id = `${m[1]}/${slugifyMemoryName(m[2])}`;
  return isValidMemoryId(id) ? id : null;
}

export interface ConsolidationResult {
  ok: boolean;
  ran: boolean;
  /** Why it didn't run, when ran === false. */
  reason?: string;
  summary?: string;
  touched?: string[];
  error?: string;
}

/**
 * One consolidation pass. Safe to call at any time: the gates make it a no-op
 * unless there is genuinely new signal and enough time has passed.
 */
export async function runConsolidation(
  opts: { force?: boolean } = {},
): Promise<ConsolidationResult> {
  if (running) return { ok: true, ran: false, reason: "already running" };
  const state = getConsolidationState();
  const since = state.lastConsolidatedAt;

  if (!opts.force) {
    if (!getMemoryConfig().generateMemory)
      return { ok: true, ran: false, reason: "memory generation is off" };
    const hours = (Date.now() - since) / 3_600_000;
    if (hours < MIN_HOURS)
      return { ok: true, ran: false, reason: `only ${hours.toFixed(1)}h since last run` };
    if (pendingBulletCount(since) < MIN_BULLETS)
      return { ok: true, ran: false, reason: "not enough new signal" };
  }

  const routed = resolveBackgroundModel();
  if (!routed) return { ok: false, ran: false, reason: "no active provider" };
  const provider = routed.provider;

  running = true;
  const startedAt = Date.now();
  try {
    const logs = readLogsSince(since);
    const content = [
      `CURRENT MEMORY:\n${currentMemoryBlock()}`,
      `DAILY LOGS since last consolidation (${logs.bullets} entries over ${logs.files} day(s)):\n${logs.text || "(none)"}`,
      `RECENT SESSIONS:\n${recentSessionsBlock(since)}`,
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
    ].join("\n\n---\n\n");

    const adapter = createAdapter(provider);
    const res = await adapter.complete({
      model: routed.model,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      max_tokens: 16_000,
    });

    const raw = (typeof res.content === "string" ? res.content : "").trim();
    if (!raw) throw new Error(`${provider.name || "the model"} returned an empty response`);
    const { value, truncated } = extractJson(raw);
    const plan = value as Plan | null;
    if (!plan)
      throw new Error(
        truncated
          ? `${provider.name || "the model"} ran out of output budget — the plan was cut off after ${raw.length} chars and nothing complete could be salvaged. Try a model with a larger output limit.`
          : `couldn't parse an edit plan; first 200 chars: ${raw.slice(0, 200)}`,
      );

    const touched: string[] = [];
    for (const u of (plan.upserts ?? []).slice(0, 12)) {
      const id = normaliseId(u.id);
      if (!id || typeof u.content !== "string" || !u.content.trim()) continue;
      const r = writeMemoryFile(id, {
        name: typeof u.name === "string" && u.name ? u.name : id.split("/").pop() || id,
        summary: typeof u.summary === "string" ? u.summary : "",
        body: u.content,
      });
      if (r.ok) touched.push(id);
    }
    for (const d of (plan.deletes ?? []).slice(0, 12)) {
      const id = normaliseId(d);
      // Never let a dream delete the profile — it's the one file the user is
      // most likely to have hand-written, and it has no natural duplicate.
      if (!id || id === "profile") continue;
      deleteMemoryFile(id);
      touched.push(`-${id}`);
    }

    // Rewrite the index from the plan, keeping only entries that survived, and
    // fall back to the files on disk if the model gave nothing usable.
    const live = new Set(listMemoryFiles().map((f) => f.id));
    const entries = (plan.index ?? [])
      .map((e) => {
        const id = normaliseId(e.id);
        if (!id || !live.has(id)) return null;
        return {
          id,
          title: typeof e.title === "string" && e.title ? e.title : id,
          hook: typeof e.hook === "string" ? e.hook : "",
        };
      })
      .filter((e): e is { id: string; title: string; hook: string } => e !== null);
    const seen = new Set<string>();
    const deduped = entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
    writeMemoryIndex(
      deduped.length > 0
        ? deduped
        : listMemoryFiles().map((f) => ({ id: f.id, title: f.name, hook: f.summary })),
    );

    let summary =
      typeof plan.summary === "string" && plan.summary.trim()
        ? plan.summary.trim()
        : `Consolidated ${logs.bullets} log entries.`;
    if (truncated)
      // Say so rather than reporting a clean run: the tail of the plan (often
      // the index, sometimes a whole file) never arrived.
      summary = `${summary} (partial — the model's reply was cut off; ${touched.length} file(s) applied)`;
    saveState({
      lastConsolidatedAt: startedAt,
      lastRunAt: startedAt,
      lastSummary: summary,
      lastError: null,
      lastTouched: touched,
      runs: state.runs + 1,
    });
    return { ok: true, ran: true, summary, touched };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Don't advance lastConsolidatedAt: the logs stay pending so the next run
    // still sees them.
    saveState({ lastRunAt: startedAt, lastError: error });
    return { ok: false, ran: false, error };
  } finally {
    running = false;
  }
}

/** Single Electron main process, so an in-process flag is a sufficient lock. */
let running = false;
