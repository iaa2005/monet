/**
 * Task registry — every tool execution, not just every running chat.
 *
 * The Background tasks panel used to list streaming SESSIONS, so a chat that
 * had been grinding through forty commands showed up as one line saying
 * "Running in background…". What you actually want to know while it runs is
 * which command it is on, and afterwards, what it did and what came back.
 *
 * Fed from the same ordered `chat:token` stream the chat reducer consumes, so
 * an entry appears the moment the tool is called and closes on its result.
 *
 * In memory only, for the life of the window: this is a live activity view, not
 * an audit log — the transcript already keeps the durable copy, and writing
 * every tool call twice would put the DB on the hot path of every run.
 */

import { create } from "zustand";
import { taskDetail, taskTitle } from "@shared/task-title";

export { toolLabel, taskDetail, taskTitle } from "@shared/task-title";

/** Ring cap. High enough that a long session keeps its history (the reference
 * UI happily shows 119), low enough that nothing grows without bound. */
export const MAX_TASKS = 400;

export type TaskStatus = "running" | "done" | "error";

export interface TaskEntry {
  /** The tool_use id — what tool_result arrives keyed by. */
  id: string;
  sessionId: string;
  /** Tool name as called: "Bash", "Read", "mcp__dropbox__search". */
  tool: string;
  /** What to call this run. The model's own `description` when it wrote one. */
  title: string;
  /** The primary argument — the command, the path, the pattern. */
  detail?: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
}

interface TaskStore {
  tasks: TaskEntry[];
  /** A tool call started. */
  startTask: (
    sessionId: string,
    id: string,
    tool: string,
    input: Record<string, unknown>,
  ) => void;
  /** Its result came back. */
  finishTask: (id: string, output: string, isError?: boolean) => void;
  /** A run ended — anything still marked running never reported back. */
  settleSession: (sessionId: string) => void;
  /** Load history from the durable log (on startup, and after a reload). */
  hydrate: () => Promise<void>;
  clear: () => void;
}

/**
 * Merge the stored rows into whatever this window already has.
 *
 * Live entries win on conflict: an event that arrived a moment ago is fresher
 * than a row read from disk, and a running entry must not be overwritten by the
 * pre-result copy of itself.
 */
export function mergeTasks(
  live: TaskEntry[],
  stored: TaskEntry[],
): TaskEntry[] {
  const seen = new Set(live.map((t) => t.id));
  const extra = stored.filter((t) => !seen.has(t.id));
  return [...live, ...extra].sort((a, b) => b.startedAt - a.startedAt);
}

/** Newest first, capped. Running entries are never trimmed — dropping one
 * would strand it as permanently "running" in the UI. */
function trim(tasks: TaskEntry[]): TaskEntry[] {
  if (tasks.length <= MAX_TASKS) return tasks;
  const keep = tasks.slice(0, MAX_TASKS);
  const strandedRunning = tasks
    .slice(MAX_TASKS)
    .filter((t) => t.status === "running");
  return strandedRunning.length ? [...keep, ...strandedRunning] : keep;
}

/**
 * How long a task has been going, or took.
 *
 * Sub-second work is rounded to one decimal instead of to zero: a row reading
 * "Completed 0s" looks like nothing happened, which is exactly the impression
 * that sent someone hunting for a bug in a tool that had worked fine.
 */
export function taskDuration(t: TaskEntry, now = Date.now()): string {
  const ms = Math.max(0, (t.finishedAt ?? now) - t.startedAt);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const useTaskStore = create<TaskStore>((set) => ({
  tasks: [],

  startTask: (sessionId, id, tool, input) =>
    set((s) => {
      // A retried event must not create a second row for the same call.
      if (s.tasks.some((t) => t.id === id)) return s;
      const entry: TaskEntry = {
        id,
        sessionId,
        tool,
        title: taskTitle(tool, input),
        detail: taskDetail(tool, input),
        status: "running",
        startedAt: Date.now(),
      };
      return { tasks: trim([entry, ...s.tasks]) };
    }),

  finishTask: (id, output, isError) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === "running"
          ? {
              ...t,
              status: isError ? "error" : "done",
              finishedAt: Date.now(),
              output,
            }
          : t,
      ),
    })),

  settleSession: (sessionId) =>
    set((s) => ({
      // Stopping a run mid-tool leaves calls that will never get a result.
      // Left alone they spin forever; marked done they claim a success that
      // never happened. "error" with no output is the honest state.
      tasks: s.tasks.map((t) =>
        t.sessionId === sessionId && t.status === "running"
          ? { ...t, status: "error", finishedAt: Date.now() }
          : t,
      ),
    })),

  hydrate: async () => {
    try {
      const api = (
        window as unknown as {
          electronAPI?: { tasks?: { list: (n?: number) => Promise<unknown[]> } };
        }
      ).electronAPI;
      const rows = (await api?.tasks?.list(MAX_TASKS)) as
        | TaskEntry[]
        | undefined;
      if (!rows?.length) return;
      set((s) => ({ tasks: trim(mergeTasks(s.tasks, rows)) }));
    } catch {
      /* no history is better than a broken panel */
    }
  },

  clear: () => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === "running") }));
    // Clear the durable copy too, or the next hydrate brings it all back.
    try {
      (
        window as unknown as {
          electronAPI?: { tasks?: { clear: () => Promise<boolean> } };
        }
      ).electronAPI?.tasks?.clear();
    } catch {
      /* the in-memory clear already happened */
    }
  },
}));
