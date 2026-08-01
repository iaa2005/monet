/**
 * The workspace a chat looked like: which panel was open, which pages.
 *
 * Claude Code stores this kind of per-session state next to the transcript,
 * and for the same reason we keep it at all: coming back to a chat should be
 * coming back to a desk, not to a cleared one. The user reopens a chat and the
 * Browser tab they were testing in, the terminal they had open, the panel they
 * were reading — all of it had to be reassembled by hand, every time.
 *
 * One JSON file for all sessions rather than a row in the session DB: this is
 * layout, not history. Losing it costs a few clicks, schema-migrating the
 * sessions table for it would cost more, and the file stays human-readable.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./data-dir.js";

export interface SessionUiState {
  /**
   * The dock's serialized layout (dockview JSON) — groups, splits, floating
   * windows, tab order. Absent means the wing was closed. Sanitized against
   * the current panel set on restore, never trusted raw.
   */
  dockLayout?: unknown;
  /** Legacy desk (pre-dock builds): which single tab was up. Read, not written. */
  rightTab?: string | null;
  /** Legacy: whether the terminal drawer was open. Read, not written. */
  terminalOpen?: boolean;
  /** The Browser panel's pages, in order. */
  browserTabs?: { url: string }[];
  /** Viewer panes: each with its open file tabs and preview flags (the
   * renderer's viewerStore serialize/restore round-trip). */
  viewerPanes?: {
    tabs: {
      file: {
        name: string;
        path?: string;
        mediaType: string;
        kind: string;
        dataUrl?: string;
        source?: "artifact" | "file";
      };
      preview: boolean;
    }[];
    active: number;
  }[];
  /** Index into browserTabs of the one on screen. */
  activeTab?: number;
  browserExpanded?: boolean;
}

const MAX_SESSIONS = 300;

function statePath(): string {
  return join(getDataDir(), "ui-state.json");
}

type StateFile = Record<string, SessionUiState & { savedAt: number }>;

function readAll(): StateFile {
  try {
    const p = statePath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return raw && typeof raw === "object" ? (raw as StateFile) : {};
  } catch {
    return {};
  }
}

export function getUiState(sessionId: string): SessionUiState | null {
  if (!sessionId) return null;
  return readAll()[sessionId] ?? null;
}

/** Forget one chat's desk — part of purging a deleted (or incognito) chat. */
export function clearUiState(sessionId: string): void {
  if (!sessionId) return;
  try {
    const all = readAll();
    if (!(sessionId in all)) return;
    delete all[sessionId];
    writeFileSync(statePath(), JSON.stringify(all, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

export function setUiState(sessionId: string, state: SessionUiState): void {
  if (!sessionId) return;
  try {
    const all = readAll();
    all[sessionId] = { ...state, savedAt: Date.now() };
    // The file grows one entry per chat forever otherwise. Oldest go first;
    // a layout is cheap to lose and this keeps the file readable.
    const ids = Object.keys(all);
    if (ids.length > MAX_SESSIONS) {
      ids
        .sort((a, b) => (all[a]?.savedAt ?? 0) - (all[b]?.savedAt ?? 0))
        .slice(0, ids.length - MAX_SESSIONS)
        .forEach((id) => delete all[id]);
    }
    writeFileSync(statePath(), JSON.stringify(all, null, 2), "utf-8");
  } catch {
    /* layout is never worth an error dialog */
  }
}
