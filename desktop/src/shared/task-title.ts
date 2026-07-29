/**
 * Naming a tool execution — shared by the main process (which writes the
 * durable task log) and the renderer (which renders it).
 *
 * One copy on purpose: the log is written in main and read in the renderer, so
 * a duplicated rule would drift and the same call would be labelled two
 * different ways depending on whether you saw it live or after a restart.
 */

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
