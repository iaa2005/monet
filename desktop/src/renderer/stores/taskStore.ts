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

/** Tools whose display name differs from the raw one. Past tense: by the time
 * you read the list, it happened. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Bash",
  PowerShell: "PowerShell",
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "Edit",
  Grep: "Search",
  Glob: "Find files",
  TodoWrite: "Plan",
  Task: "Sub-agent",
  RunPython: "Python",
  RunCommand: "Command",
};

export function toolLabel(tool: string): string {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool]!;
  // mcp__<server>__<tool> reads as "server · tool"; the raw form is unreadable.
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  return m ? `${m[1]} · ${m[2]}` : tool;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The primary argument, on one line.
 *
 * Commands keep their full text (that IS the interesting part, and the panel
 * shows it in its own block); paths are reduced to a basename, since the
 * directory is rarely what distinguishes one run from the next.
 */
export function taskDetail(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  if (tool === "Bash" || tool === "PowerShell" || tool === "RunCommand")
    return str(input, "command");
  if (tool === "RunPython") return str(input, "code");
  const path = str(input, "file_path") ?? str(input, "path");
  if (path) return basename(path);
  return (
    str(input, "pattern") ??
    str(input, "query") ??
    str(input, "url") ??
    str(input, "description")
  );
}

/**
 * What to call this execution.
 *
 * Prefers the model's own `description` — Bash asks for one ("Clear, concise
 * description of what this command does in active voice"), and it is far more
 * use than the command itself: "Register probe, build and smoke" beats
 * `npm pkg set scripts... && npm run build > /tmp/b8.log`. Everything else
 * falls back to the tool plus its argument.
 */
export function taskTitle(
  tool: string,
  input: Record<string, unknown>,
): string {
  const authored = str(input, "description");
  if (authored) return authored.replace(/\s+/g, " ").trim();
  const detail = taskDetail(tool, input);
  const label = toolLabel(tool);
  if (!detail) return label;
  const one = detail.replace(/\s+/g, " ").trim();
  const short = one.length > 60 ? `${one.slice(0, 59)}…` : one;
  return `${label} · ${short}`;
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
  clear: () => void;
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

  clear: () =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === "running") })),
}));
