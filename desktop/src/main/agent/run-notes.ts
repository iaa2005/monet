/**
 * Run notes — what the last loop leaves for the next one.
 *
 * A goal that completes writes what it did; a goal that blocks writes what
 * stopped it. The next goal in the SAME workspace starts with those lines in
 * its reminder — so run N+1 does not redo run N's work, and does not walk
 * into the wall run N already named. Routines get the same continuity from
 * their own run table (routineHistoryBlock below); this file stores only the
 * goal side, keyed by workspace.
 *
 * Deliberately no model call: the note IS the model's own words — the
 * completion summary UpdateGoal demanded evidence for, or the block reason.
 * The retrospective costs zero extra tokens; its value is in being carried
 * forward.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface RunNote {
  at: string;
  outcome: "complete" | "blocked";
  /** stopReason, for blocked notes. */
  reason?: string;
  objective: string;
  /** The model's own summary (complete) or block detail. */
  note: string;
  turns: number;
}

const MAX_NOTES = 5;
const MAX_SCOPES = 30;

const notesFile = (): string => join(getDataDir(), "run-notes.json");

/** One key per folder, however the path was spelled. */
export function workspaceKey(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

type NotesFile = Record<string, RunNote[]>;

function readAll(): NotesFile {
  try {
    return JSON.parse(readFileSync(notesFile(), "utf-8")) as NotesFile;
  } catch {
    return {};
  }
}

function writeAll(all: NotesFile): void {
  try {
    // Oldest scopes go first when the cap bites — recency is the value here.
    const entries = Object.entries(all)
      .sort(
        (a, b) =>
          Date.parse(b[1][b[1].length - 1]?.at ?? "0") -
          Date.parse(a[1][a[1].length - 1]?.at ?? "0"),
      )
      .slice(0, MAX_SCOPES);
    writeFileSync(notesFile(), JSON.stringify(Object.fromEntries(entries), null, 2), "utf-8");
  } catch {
    /* a lost note costs continuity, never a run */
  }
}

export function addGoalRunNote(workspace: string, note: RunNote): void {
  const all = readAll();
  const key = workspaceKey(workspace);
  const list = all[key] ?? [];
  list.push(note);
  all[key] = list.slice(-MAX_NOTES);
  writeAll(all);
}

export function goalRunNotes(workspace: string): RunNote[] {
  return readAll()[workspaceKey(workspace)] ?? [];
}

const line = (s: string, n: number): string =>
  s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The block the goal reminder carries — newest first, three at most, hard
 * character caps. It is restated every turn (the reminder is), so it must
 * stay a footnote, not a chapter.
 */
export function goalHistoryBlock(notes: RunNote[]): string | null {
  if (notes.length === 0) return null;
  const rows = notes
    .slice(-3)
    .reverse()
    .map((n) => {
      const when = n.at.slice(0, 10);
      const head =
        n.outcome === "complete"
          ? `complete after ${n.turns} turn(s)`
          : `blocked (${n.reason ?? "?"}) after ${n.turns} turn(s)`;
      return `- [${when}] ${head} — "${line(n.objective, 70)}": ${line(n.note, 140)}`;
    });
  return [
    "## Earlier goals in this workspace",
    ...rows,
    "Use them for continuity: do not redo what is already done, and do not",
    "repeat an approach that already hit a wall without changing something.",
  ].join("\n");
}

/**
 * The same continuity for a routine, from its own run table. Skipped runs say
 * nothing worth carrying; running ones are this run's siblings, not history.
 */
export function routineHistoryBlock(
  runs: { at: string; status: string; summary?: string; error?: string }[],
): string | null {
  const rows = runs
    .filter((r) => r.status === "ok" || r.status === "error")
    .slice(0, 3)
    .map((r) => {
      const what =
        r.status === "ok"
          ? line(r.summary ?? "completed", 160)
          : `FAILED: ${line(r.error ?? "unknown error", 160)}`;
      return `- [${r.at.slice(0, 16).replace("T", " ")}] ${what}`;
    });
  if (rows.length === 0) return null;
  return [
    "[Previous runs of this routine, newest first:",
    ...rows,
    "Use them for continuity: do not repeat what a previous run already did,",
    "and if the last run failed, address the cause before the task.]",
  ].join("\n");
}
