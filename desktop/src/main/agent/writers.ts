/**
 * Which tools can change the folder, and therefore when it is worth
 * looking at.
 *
 * Indexing the work tree costs a stat walk, so a batch of Reads and Greps
 * should not pay for one — and could not change anything to be caught
 * anyway. But the failure this guards against is silent: a tool that
 * writes and is not recognised means a file nobody noticed, which means a
 * rewind that leaves it behind and a user who finds a half-restored tree.
 *
 * So the default is "writer". Only tools KNOWN to read are exempt; a
 * plugin, an MCP server or a tool added next month counts as a writer
 * until somebody says otherwise, because guessing "read-only" is the
 * guess that loses work.
 */

/** Tools that certainly write — kept as a list because it reads as a
 * statement of intent, even though the default already covers them. */
export const WRITERS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "RunPython",
  "RunCommand",
  "SandboxWrite",
  "Task",
  "Skill",
]);

/** Tools known to only read. Everything else is treated as a writer. */
export const KNOWN_READERS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
  "AskUserQuestion",
]);

/** Is this batch worth indexing the folder for? */
export function anyWriters(calls: { name: string }[]): boolean {
  return calls.some((c) => WRITERS.has(c.name) || !KNOWN_READERS.has(c.name));
}
