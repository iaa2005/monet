/**
 * Sandbox file tools — Home's file access, scoped to the CHAT's sandbox.
 *
 * Home is isolated from the user's machine (like the official desktop app:
 * a regular chat can't scan local disks). But a chat still has its own file
 * store — attachments the user added and files RunPython produced — so the
 * model gets List/Read/Write over exactly that folder and nothing else.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { structuredPatch } from "diff";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  listSandboxFiles,
  readSandboxFile,
  writeSandboxFile,
  editSandboxFile,
} from "../sandbox/files.js";
import { artifactReference } from "../ipc/artifacts.js";
import { tunablePrompt } from "../prompts/index.js";

interface TextOutput {
  text: string;
  isError: boolean;
}

const mapResult = (
  content: TextOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  is_error: content.isError || undefined,
});

const sid = (context: ToolUseContext): string =>
  (context as { sessionId?: string }).sessionId || "default";

/** Sandbox-relative POSIX path: no absolute paths, no "..", no backslashes.
 * Subfolders (a/b/c.py) are allowed — the sandbox is a real directory tree. */
function validName(name: string): boolean {
  if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  if (name.includes("\\")) return false;
  return name.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── SandboxList ──────────────────────────────────────────────────────────

const listSchema = lazySchema(() => z.strictObject({}));
type ListSchema = ReturnType<typeof listSchema>;

export const SandboxListTool = buildTool({
  name: "SandboxList",
  searchHint: "list the files in this chat's sandbox",
  maxResultSizeChars: 20_000,
  get inputSchema(): ListSchema {
    return listSchema();
  },
  userFacingName() {
    return "SandboxList";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-sandbox-list",
      "List the files in this chat's sandbox (user attachments and files produced by RunPython/SandboxWrite), including files in subfolders (shown as relative paths like scripts/build.py). This chat cannot see the user's filesystem — this sandbox is all there is.",
    );
  },
  async description() {
    return "List the files in this chat's sandbox.";
  },
  async call(_input: z.infer<ListSchema>, context: ToolUseContext) {
    const files = listSandboxFiles(sid(context));
    const text =
      files.length === 0
        ? "The sandbox is empty — no files in this chat yet."
        : files.map((f) => `${f.name}  (${fmtSize(f.size)})`).join("\n");
    return { data: { text, isError: false } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── SandboxRead ──────────────────────────────────────────────────────────

const readSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .describe("The file path as shown by SandboxList (subfolders allowed)."),
  }),
);
type ReadSchema = ReturnType<typeof readSchema>;

export const SandboxReadTool = buildTool({
  name: "SandboxRead",
  searchHint: "read a text file from this chat's sandbox",
  maxResultSizeChars: 420_000,
  get inputSchema(): ReadSchema {
    return readSchema();
  },
  userFacingName() {
    return "SandboxRead";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-sandbox-read",
      "Read a TEXT file from this chat's sandbox by its path as shown by SandboxList (subfolders like scripts/build.py are fine). Binary files (images, docx, xlsx) can't be read as text — process those with RunPython.",
    );
  },
  async description() {
    return "Read a text file from this chat's sandbox.";
  },
  async call({ name }: z.infer<ReadSchema>, context: ToolUseContext) {
    if (!validName(name)) {
      return {
        data: {
          text: `Invalid path "${name}" — use a sandbox-relative path (subfolders ok; no "..", no absolute paths, no backslashes).`,
          isError: true,
        },
      };
    }
    const r = readSandboxFile(sid(context), name);
    return r.ok
      ? { data: { text: r.content ?? "", isError: false } }
      : { data: { text: r.error ?? "Read failed", isError: true } };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── SandboxWrite ─────────────────────────────────────────────────────────

const writeSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .describe(
        "The relative path to create/overwrite (subfolders ok, e.g. src/app.py).",
      ),
    content: z.string().describe("The full text content of the file."),
  }),
);
type WriteSchema = ReturnType<typeof writeSchema>;

export const SandboxWriteTool = buildTool({
  name: "SandboxWrite",
  searchHint: "write a text file into this chat's sandbox",
  maxResultSizeChars: 8_000,
  get inputSchema(): WriteSchema {
    return writeSchema();
  },
  userFacingName() {
    return "SandboxWrite";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-sandbox-write",
      [
        "Write a TEXT file into this chat's sandbox (markdown, csv, code, html…).",
        "Use a relative path to place it in a subfolder (e.g. src/app.py) — the",
        "sandbox is a real directory tree. The file is attached to the conversation",
        "for the user and becomes readable by RunPython/SandboxRead. For binary",
        "formats (docx, xlsx, images) generate the file with RunPython instead.",
      ].join("\n"),
    );
  },
  async description() {
    return "Write a text file into this chat's sandbox (attached to the chat automatically).";
  },
  async call(
    { name, content }: z.infer<WriteSchema>,
    context: ToolUseContext,
  ) {
    if (!validName(name)) {
      return {
        data: {
          text: `Invalid path "${name}" — use a sandbox-relative path (subfolders ok; no "..", no absolute paths, no backslashes).`,
          isError: true,
        },
      };
    }
    if (content.length > 2 * 1024 * 1024) {
      return {
        data: { text: "Content too large (2MB limit).", isError: true },
      };
    }
    try {
      const { path, mediaType } = writeSandboxFile(sid(context), name, content);
      return {
        data: {
          text:
            `[artifact] ${mediaType} ${name} :: ${artifactReference(path)}\n` +
            `Markdown: ![${name}](${artifactReference(path)})\n` +
            `Saved ${name} (${fmtSize(Buffer.byteLength(content, "utf-8"))}).`,
          isError: false,
        },
      };
    } catch (err) {
      return {
        data: {
          text: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

// ─── SandboxEdit ──────────────────────────────────────────────────────────

const editSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .describe("The file path as shown by SandboxList (subfolders allowed)."),
    old_string: z.string().describe("The exact text to replace."),
    new_string: z.string().describe("The replacement text."),
    replace_all: z
      .boolean()
      .default(false)
      .describe("Replace all occurrences of old_string (default: first only)."),
  }),
);
type EditSchema = ReturnType<typeof editSchema>;

export const SandboxEditTool = buildTool({
  name: "SandboxEdit",
  searchHint: "find-and-replace edit a file in this chat's sandbox",
  maxResultSizeChars: 8_000,
  get inputSchema(): EditSchema {
    return editSchema();
  },
  userFacingName() {
    return "SandboxEdit";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-sandbox-edit",
      [
        "Edit a TEXT file in this chat's sandbox by finding and replacing a",
        "string. Use a relative path as shown by SandboxList. Provide enough",
        "context in old_string to uniquely identify the location — set",
        "replace_all=true to replace every occurrence. The file must already",
        "exist (use SandboxWrite to create files). Read the file first with",
        "SandboxRead so you know the exact text to replace.",
      ].join("\n"),
    );
  },
  async description() {
    return "Find-and-replace edit a text file in this chat's sandbox.";
  },
  async call(
    { name, old_string, new_string, replace_all }: z.infer<EditSchema>,
    context: ToolUseContext,
  ) {
    if (!validName(name)) {
      return {
        data: {
          text: `Invalid path "${name}" — use a sandbox-relative path (subfolders ok; no "..", no absolute paths, no backslashes).`,
          isError: true,
        },
      };
    }
    // Read the file BEFORE editing so we can show a diff.
    const before = readSandboxFile(sid(context), name);
    if (!before.ok) {
      return { data: { text: before.error ?? "Read failed", isError: true } };
    }
    const r = editSandboxFile(
      sid(context),
      name,
      old_string,
      new_string,
      replace_all,
    );
    if (!r.ok) {
      return { data: { text: r.error ?? "Edit failed", isError: true } };
    }
    // Produce a unified diff for the chat UI.
    const patch = structuredPatch(name, name, before.content ?? "", r.content ?? "");
    const diffLines: string[] = [`--- ${name}`, `+++ ${name}`];
    for (const hunk of patch.hunks) {
      diffLines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      );
      for (const line of hunk.lines) {
        diffLines.push(line);
      }
    }
    const codeblock = "```diff";
    return {
      data: {
        text:
          `Edited ${name} (${fmtSize(Buffer.byteLength(r.content ?? "", "utf-8"))}).\n\n` +
          `${codeblock}\n${diffLines.join("\n")}\n\`\`\``,
        isError: false,
      },
    };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});
