/**
 * Project lessons — what dreaming learns from FAILURES, kept per workspace.
 *
 * The nightly consolidation (consolidate.ts) learns who the USER is. This is
 * the other half of the school: the teacher noticing where every student got
 * the same question wrong. The signals are structured records the app already
 * keeps — failed tool calls in the task log, chats that stopped on an error,
 * goals that ran out of budget, checks remembered as known-red — so gathering
 * them costs no model tokens; the one LLM call per workspace turns them into
 * a short list of lessons the NEXT session in that folder starts with.
 *
 * Scoped injection is the point: a lesson about this repo's flaky build
 * belongs in every chat opened HERE and in no chat opened anywhere else,
 * which is why these files live outside the user-memory sections that
 * buildMemoryPrompt folds into every conversation.
 *
 * Every write keeps history (last HISTORY_KEEP versions) and can be rolled
 * back from Settings → Memory: an automatic memory a cheap model writes is
 * only trustworthy if a bad night is one click to undo.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { getDataDir } from "../data-dir.js";
import { extractJson } from "../llm/json-extract.js";
import { getMemoryConfig, getMemoryDir } from "./store.js";

// ─── The store ──────────────────────────────────────────────────────────

/**
 * One workspace, one slug: readable basename + a hash of the full path, so
 * two folders both named "app" don't share a memory.
 */
export function lessonsSlug(workspace: string): string {
  const norm = workspace.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const base =
    basename(norm)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project";
  const key = norm.toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return `${base}-${h.toString(16).padStart(6, "0").slice(0, 6)}`;
}

function projectsDir(): string {
  const d = join(getMemoryDir(), "projects");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function historyDir(): string {
  const d = join(projectsDir(), ".history");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const fileOf = (workspace: string): string =>
  join(projectsDir(), `${lessonsSlug(workspace)}.md`);

export interface LessonsFile {
  workspace: string;
  summary: string;
  body: string;
  updatedAt: number;
  /** A previous version exists to roll back to. */
  canRollback: boolean;
}

const HISTORY_KEEP = 5;

function parse(raw: string): { workspace: string; summary: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { workspace: "", summary: "", body: raw.trim() };
  const field = (k: string): string => {
    const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]!);
    return hit ? hit[1]!.trim() : "";
  };
  return { workspace: field("workspace"), summary: field("summary"), body: m[2]!.trim() };
}

function historyOf(workspace: string): string[] {
  const slug = lessonsSlug(workspace);
  try {
    return readdirSync(historyDir())
      .filter((f) => f.startsWith(`${slug}.`) && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

export function readLessons(workspace: string): LessonsFile | null {
  const f = fileOf(workspace);
  if (!existsSync(f)) return null;
  try {
    const p = parse(readFileSync(f, "utf-8"));
    return {
      workspace: p.workspace || workspace,
      summary: p.summary,
      body: p.body,
      updatedAt: statSync(f).mtimeMs,
      canRollback: historyOf(workspace).length > 0,
    };
  } catch {
    return null;
  }
}

/** Replace the lessons file, keeping the outgoing version as history. */
export function writeLessons(
  workspace: string,
  data: { summary: string; body: string },
): void {
  const f = fileOf(workspace);
  if (existsSync(f)) {
    const slug = lessonsSlug(workspace);
    try {
      renameSync(f, join(historyDir(), `${slug}.${Date.now()}.md`));
      // Oldest beyond the cap go quietly.
      const all = historyOf(workspace);
      for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP)))
        rmSync(join(historyDir(), old), { force: true });
    } catch {
      /* losing one history version beats losing the write */
    }
  }
  writeFileSync(
    f,
    [
      "---",
      `workspace: ${workspace.replace(/\n/g, " ")}`,
      `summary: ${data.summary.trim().replace(/\n/g, " ")}`,
      "---",
      "",
      data.body.trim(),
      "",
    ].join("\n"),
    "utf-8",
  );
}

/** Undo the last dream for this workspace: restore the newest history version. */
export function rollbackLessons(workspace: string): { ok: boolean; error?: string } {
  const versions = historyOf(workspace);
  const last = versions[versions.length - 1];
  if (!last) return { ok: false, error: "No previous version to restore." };
  try {
    renameSync(join(historyDir(), last), fileOf(workspace));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function deleteLessons(workspace: string): { ok: boolean } {
  rmSync(fileOf(workspace), { force: true });
  for (const v of historyOf(workspace)) rmSync(join(historyDir(), v), { force: true });
  return { ok: true };
}

export function listLessons(): LessonsFile[] {
  try {
    return readdirSync(projectsDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const p = parse(readFileSync(join(projectsDir(), f), "utf-8"));
        return {
          workspace: p.workspace,
          summary: p.summary,
          body: p.body,
          updatedAt: statSync(join(projectsDir(), f)).mtimeMs,
          canRollback: p.workspace ? historyOf(p.workspace).length > 0 : false,
        };
      })
      .filter((l) => l.workspace);
  } catch {
    return [];
  }
}

// ─── Injection ──────────────────────────────────────────────────────────

/** Keep the injection honest about its size — lessons, not a manual. */
const PROMPT_CAP = 2_500;

export function buildLessonsPrompt(workspace: string | undefined): string | null {
  if (!workspace) return null;
  const l = readLessons(workspace);
  if (!l || !l.body) return null;
  const body = l.body.length > PROMPT_CAP ? `${l.body.slice(0, PROMPT_CAP)}…` : l.body;
  return [
    "# Project lessons (this workspace)",
    "Learned from earlier sessions in this folder — recurring failures and what",
    "worked instead. Treat as strong hints; verify when they contradict what you see.",
    "",
    body,
  ].join("\n");
}

// ─── Signals ────────────────────────────────────────────────────────────

export interface LessonSignal {
  kind: "tool-error" | "chat-error" | "goal-stopped" | "known-red";
  text: string;
}

const clipText = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Everything the app already knows went wrong, grouped by workspace. All
 * structured reads — no model, no transcripts. Dynamic imports because
 * better-sqlite3 is Electron-ABI and the probe drives the dream with an
 * injected gatherer instead.
 */
export async function gatherSignals(
  sinceMs: number,
): Promise<Map<string, LessonSignal[]>> {
  const out = new Map<string, LessonSignal[]>();
  const push = (ws: string | null | undefined, s: LessonSignal): void => {
    if (!ws) return;
    const list = out.get(ws) ?? [];
    if (list.length >= 30) return; // one workspace cannot flood the dream
    list.push(s);
    out.set(ws, list);
  };

  try {
    const { getSessionDb } = await import("../session-store.js");
    const db = getSessionDb();

    // Failed tool calls, joined to the session's workspace.
    const toolRows = db
      .prepare(
        `SELECT t.tool, t.title, t.output, s.workspace
           FROM task_log t JOIN sessions s ON s.id = t.session_id
          WHERE t.status = 'error' AND t.started_at >= ?
            AND s.workspace IS NOT NULL AND s.workspace != ''
          ORDER BY t.started_at DESC LIMIT 120`,
      )
      .all(sinceMs) as {
      tool: string;
      title: string;
      output: string | null;
      workspace: string;
    }[];
    for (const r of toolRows)
      push(r.workspace, {
        kind: "tool-error",
        text: `${r.tool} failed — ${clipText(r.title, 80)}${r.output ? `: ${clipText(r.output.trim(), 160)}` : ""}`,
      });

    // Chats wearing the error mark. No time filter: a standing failure is a
    // standing signal (recording one deliberately does not bump updated_at).
    const errRows = db
      .prepare(
        `SELECT workspace, last_error, title FROM sessions
          WHERE last_error IS NOT NULL AND last_error != ''
            AND workspace IS NOT NULL AND workspace != ''
          ORDER BY updated_at DESC LIMIT 20`,
      )
      .all() as { workspace: string; last_error: string; title: string }[];
    for (const r of errRows)
      push(r.workspace, {
        kind: "chat-error",
        text: `Chat "${clipText(r.title, 60)}" stopped on: ${clipText(r.last_error, 160)}`,
      });

    // Goals that stopped without completing. Goal files are named by session
    // id (uuid-safe sanitisation), which the sessions table maps to a folder.
    try {
      const goalsDir = join(getDataDir(), "goals");
      if (existsSync(goalsDir)) {
        for (const f of readdirSync(goalsDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            if (statSync(join(goalsDir, f)).mtimeMs < sinceMs) continue;
            const goal = JSON.parse(readFileSync(join(goalsDir, f), "utf-8")) as {
              status?: string;
              objective?: string;
              stopReason?: string;
              stopDetail?: string;
            };
            if (goal.status !== "blocked") continue;
            const sid = f.slice(0, -5);
            const row = db
              .prepare("SELECT workspace FROM sessions WHERE id = ?")
              .get(sid) as { workspace: string | null } | undefined;
            push(row?.workspace, {
              kind: "goal-stopped",
              text: `Goal "${clipText(goal.objective ?? "", 80)}" stopped (${goal.stopReason ?? "?"})${goal.stopDetail ? `: ${clipText(goal.stopDetail, 120)}` : ""}`,
            });
          } catch {
            /* one unreadable goal file skips itself */
          }
        }
      }
    } catch {
      /* goals are one signal source of several */
    }
  } catch {
    /* no database, no signals — the dream just finds nothing */
  }

  // Checks the verify loop remembers as pre-existing red.
  try {
    const { listKnownRed } = await import("../verify/state.js");
    for (const [ws, signatures] of Object.entries(listKnownRed()))
      if (signatures.length > 0)
        push(ws, {
          kind: "known-red",
          text: `${signatures.length} project check failure(s) stand as pre-existing (the verify loop skips them; fixing the underlying cause would re-arm it).`,
        });
  } catch {
    /* ignore */
  }

  return out;
}

// ─── The dream ──────────────────────────────────────────────────────────

export interface LessonsState {
  lastRunAt: number;
  lastSummary: string;
  lastError: string | null;
  /** Workspaces the last run touched. */
  lastTouched: string[];
  runs: number;
}

const EMPTY_STATE: LessonsState = {
  lastRunAt: 0,
  lastSummary: "",
  lastError: null,
  lastTouched: [],
  runs: 0,
};

const stateFile = (): string => join(getDataDir(), "lessons-state.json");

export function getLessonsState(): LessonsState {
  try {
    return {
      ...EMPTY_STATE,
      ...(JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<LessonsState>),
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(patch: Partial<LessonsState>): void {
  try {
    writeFileSync(
      stateFile(),
      JSON.stringify({ ...getLessonsState(), ...patch }, null, 2),
      "utf-8",
    );
  } catch {
    /* advisory */
  }
}

// Same rhythm as the user-memory consolidation (nightly.ts): the night window
// when the machine is on, a catch-up for the one that wasn't. Own state, so a
// night when user-memory had nothing to do can still teach the projects.
const NIGHT_START_HOUR = 3;
const NIGHT_END_HOUR = 5;
const MIN_HOURS = 20;
const CATCHUP_HOURS = 36;

export function shouldDreamLessonsNow(now = new Date()): boolean {
  const hoursSince = (now.getTime() - getLessonsState().lastRunAt) / 3_600_000;
  if (hoursSince >= CATCHUP_HOURS) return true;
  const hour = now.getHours();
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR && hoursSince >= MIN_HOURS;
}

/** Below this many signals a workspace has nothing to teach. */
const MIN_SIGNALS = 3;
/** At most this many workspaces per night — dreams are budgeted too. */
const MAX_WORKSPACES_PER_RUN = 3;
/** First run looks this far back. */
const FIRST_RUN_LOOKBACK_MS = 7 * 86_400_000;

const SYSTEM = `You maintain the "project lessons" file for ONE workspace — a short list of hard-won, project-specific lessons an AI coding assistant reads the next time it works in this folder.

You receive the CURRENT LESSONS (possibly empty) and SIGNALS from recent sessions there: failed tool calls, chats that stopped on errors, goals that ran out of budget, checks that stay red.

Keep only what changes future behaviour: commands that fail here and what works instead, paths or tools that need care, recurring mistakes with their fixes, standing quirks of this project. Drop: one-off typos, transient network errors, anything obvious from reading the code, secrets.

Rules:
- MERGE: your output REPLACES the file. Carry over lessons still worth keeping, fold in the new, drop stale or contradicted ones.
- Terse bullets, at most 15, most valuable first.
- Write in the language the signals are written in.

Reply with ONLY JSON (no fences, no prose):
{"lessons": "full replacement markdown body, or null if the signals teach nothing new",
 "summary": "one line: what this pass changed"}`;

/** The default model call — the background model, one completion. */
async function defaultComplete(system: string, user: string): Promise<string> {
  const { resolveBackgroundModel } = await import("../provider/routing.js");
  const { createAdapter } = await import("../llm/adapter.js");
  const routed = resolveBackgroundModel();
  if (!routed) throw new Error("no active provider");
  const res = await createAdapter(routed.provider).complete({
    model: routed.model,
    system,
    messages: [{ role: "user", content: user }],
    max_tokens: 4_000,
  });
  return typeof res.content === "string" ? res.content : "";
}

export interface LessonsDreamResult {
  ok: boolean;
  ran: boolean;
  reason?: string;
  /** Workspaces whose lessons changed. */
  touched?: string[];
  error?: string;
}

let running = false;

export async function runLessonsDream(
  opts: {
    force?: boolean;
    gather?: (sinceMs: number) => Promise<Map<string, LessonSignal[]>>;
    complete?: (system: string, user: string) => Promise<string>;
  } = {},
): Promise<LessonsDreamResult> {
  if (running) return { ok: true, ran: false, reason: "already running" };
  const state = getLessonsState();

  if (!opts.force) {
    if (!getMemoryConfig().generateMemory)
      return { ok: true, ran: false, reason: "memory generation is off" };
    const hours = (Date.now() - state.lastRunAt) / 3_600_000;
    if (hours < MIN_HOURS)
      return { ok: true, ran: false, reason: `only ${hours.toFixed(1)}h since last run` };
  }

  running = true;
  const startedAt = Date.now();
  try {
    const since = state.lastRunAt || startedAt - FIRST_RUN_LOOKBACK_MS;
    const byWorkspace = await (opts.gather ?? gatherSignals)(since);
    const worth = [...byWorkspace.entries()]
      .filter(([, signals]) => signals.length >= (opts.force ? 1 : MIN_SIGNALS))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_WORKSPACES_PER_RUN);

    if (worth.length === 0) {
      // Advance the clock: the signals were seen and found wanting; without
      // this a quiet week re-reads the same nothing every 15 minutes at 3am.
      saveState({ lastRunAt: startedAt, lastSummary: "No workspace had enough signal." });
      return { ok: true, ran: false, reason: "not enough signal" };
    }

    const touched: string[] = [];
    const summaries: string[] = [];
    for (const [workspace, signals] of worth) {
      const current = readLessons(workspace);
      const user = [
        `WORKSPACE: ${workspace}`,
        `CURRENT LESSONS:\n${current?.body || "(none yet)"}`,
        `SIGNALS since the last pass:\n${signals.map((s) => `- [${s.kind}] ${s.text}`).join("\n")}`,
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
      ].join("\n\n---\n\n");

      const raw = (await (opts.complete ?? defaultComplete)(SYSTEM, user)).trim();
      const { value } = extractJson(raw);
      const plan = value as { lessons?: unknown; summary?: unknown } | null;
      if (!plan || typeof plan.lessons !== "string" || !plan.lessons.trim()) continue;
      writeLessons(workspace, {
        summary:
          typeof plan.summary === "string" && plan.summary
            ? plan.summary
            : `Learned from ${signals.length} signal(s).`,
        body: plan.lessons,
      });
      touched.push(workspace);
      if (typeof plan.summary === "string" && plan.summary) summaries.push(plan.summary);
    }

    const summary =
      touched.length > 0
        ? summaries.join(" · ") || `Updated ${touched.length} workspace(s).`
        : "The signals taught nothing new.";
    saveState({
      lastRunAt: startedAt,
      lastSummary: summary,
      lastError: null,
      lastTouched: touched,
      runs: state.runs + 1,
    });
    return { ok: true, ran: true, touched };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Unlike success paths, the clock does NOT advance: the signals stay
    // eligible for the next attempt.
    saveState({ lastError: error });
    return { ok: false, ran: false, error };
  } finally {
    running = false;
  }
}
