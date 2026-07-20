/**
 * Remember — the agent writes long-term memory deliberately, in the moment.
 *
 * This is the good half of the vendor's memory design, wired into the memory
 * this app actually reads back. The vendor ships 3,146 tokens of instructions
 * telling the agent to append to daily log files; in this app nothing ever
 * distils or re-reads them (no nightly consolidation runs, and the daily-log
 * prompt never injects the index), so that memory is write-only. Ours already
 * closes the loop — buildMemoryPrompt() folds every file back into the system
 * prompt and Settings → Memory shows them — it was just missing the ability
 * for the agent to write at the moment it learns something. That is what this
 * tool adds, for ~200 tokens instead of 3,146.
 *
 * Background extraction still runs (memory/extract.ts); it guesses after the
 * fact from the transcript. This tool is the deliberate path: the agent has
 * the full context of WHY a fact matters exactly when it learns it.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  listMemoryFiles,
  readMemoryFile,
  slugifyMemoryName,
  writeMemoryFile,
} from "../memory/store.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function out(text: string, isError = false): { data: Output } {
  return { data: { text, isError } };
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    section: z
      .enum(["you", "topics", "areas"])
      .describe(
        "you = who the user is (one shared file). topics = a sustained interest or way of working. areas = a long-running project.",
      ),
    name: z
      .string()
      .describe(
        "Short title for the memory file, e.g. “Testing preferences” or “Monet desktop app”. Reuse an existing name to add to that file.",
      ),
    fact: z
      .string()
      .describe(
        "The fact to remember, in one or two sentences. Write it so it makes sense months from now with no other context.",
      ),
    why: z
      .string()
      .optional()
      .describe(
        "Why it matters / how to apply it. Worth including for a preference or correction.",
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const PROMPT_DEFAULT = [
  "Save a durable fact about the user or their long-running work, so future",
  "chats start with it. The user sees and can edit these in Settings → Memory.",
  "",
  "Save when: the user states a preference or corrects you in a way that",
  "should outlive this chat; you learn who they are, what they are building,",
  "or a constraint that is not visible in the code; they say “remember this”.",
  "",
  "Do NOT save: anything the repository already records (structure, git",
  "history, how a fix was made), one-off details of the current task,",
  "secrets/tokens/credentials, or something already in memory — add to the",
  "existing file instead of creating a near-duplicate.",
  "",
  "Facts are appended to the named file. Keep each one short and self-",
  "contained; convert “yesterday”/“next week” to absolute dates.",
].join("\n");

export const RememberTool = buildTool({
  name: "Remember",
  searchHint: "save a durable fact about the user to long-term memory",
  maxResultSizeChars: 2_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Remember";
  },
  isReadOnly() {
    return false; // writes a file the user will see in Settings
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    // The index of what's already saved travels with the prompt so the model
    // adds to an existing file instead of making a near-duplicate.
    return [tunablePrompt("tool-remember", PROMPT_DEFAULT), memoryIndexHint()]
      .filter(Boolean)
      .join("\n\n");
  },
  async description() {
    return "Save a durable fact about the user or their work to long-term memory.";
  },
  async call(input: z.infer<InputSchema>, _context: ToolUseContext) {
    try {
      const fact = input.fact.trim();
      if (!fact) return out("Nothing to remember: `fact` was empty.", true);

      // "you" is a single shared file; topics/areas are one file per subject.
      const id =
        input.section === "you"
          ? "profile"
          : `${input.section}/${slugifyMemoryName(input.name)}`;

      const existing = readMemoryFile(id);
      const entry = input.why?.trim()
        ? `- ${fact}\n  Why: ${input.why.trim()}`
        : `- ${fact}`;

      // Appending, never overwriting: a memory file accumulates across chats,
      // and clobbering one would silently drop everything learned before.
      const body = existing.ok && existing.body?.trim()
        ? `${existing.body.trim()}\n${entry}`
        : entry;

      // The id is slug-safe by construction (slugifyMemoryName strips every
      // path character), but the DISPLAY name is model-supplied and shown in
      // Settings — keep it to plain readable text so a title like
      // "../../escape" doesn't end up as a label in the UI.
      const cleanName = input.name
        .replace(/[^\p{L}\p{N} .,'()+-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const name =
        input.section === "you"
          ? existing.name || "You"
          : existing.name || cleanName || "Note";
      const summary =
        existing.summary ||
        (input.section === "you"
          ? "Who the user is and how they like to work."
          : fact.slice(0, 120));

      const w = writeMemoryFile(id, { name, summary, body });
      if (!w.ok) return out(w.error ?? "Could not write the memory file.", true);

      return out(
        `Remembered in ${id} (“${name}”). The user can edit or delete it in Settings → Memory.`,
      );
    } catch (e) {
      return out(e instanceof Error ? e.message : String(e), true);
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});

/** Existing memory, as a one-line-per-file hint for the tool's prompt — so the
 * model adds to a file instead of creating a near-duplicate. */
export function memoryIndexHint(): string {
  const files = listMemoryFiles();
  if (files.length === 0) return "";
  return `Existing memory files: ${files.map((f) => `${f.id} (“${f.name}”)`).join(", ")}.`;
}
