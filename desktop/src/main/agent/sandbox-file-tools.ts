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
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  listSandboxFiles,
  readSandboxFile,
  writeSandboxFile,
} from "../sandbox/files.js";
import { artifactReference } from "../ipc/artifacts.js";

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

/** Plain names only — the sandbox is flat, paths don't exist here. */
function validName(name: string): boolean {
  return !!name && !/[/\\]/.test(name) && name !== "." && name !== "..";
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
    return "List the files in this chat's sandbox (user attachments and files produced by RunPython/SandboxWrite). This chat cannot see the user's filesystem — this sandbox is all there is.";
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
    name: z.string().describe("The file name (as shown by SandboxList)."),
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
    return "Read a TEXT file from this chat's sandbox by name (see SandboxList). Binary files (images, docx, xlsx) can't be read as text — process those with RunPython.";
  },
  async description() {
    return "Read a text file from this chat's sandbox.";
  },
  async call({ name }: z.infer<ReadSchema>, context: ToolUseContext) {
    if (!validName(name)) {
      return {
        data: {
          text: `Invalid name "${name}" — the sandbox is flat, use a bare file name.`,
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
      .describe("The file name to create/overwrite (bare name, no paths)."),
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
    return [
      "Write a TEXT file into this chat's sandbox (markdown, csv, code, html…).",
      "The file is attached to the conversation for the user and becomes",
      "readable by RunPython/SandboxRead. For binary formats (docx, xlsx,",
      "images) generate the file with RunPython instead.",
    ].join("\n");
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
          text: `Invalid name "${name}" — the sandbox is flat, use a bare file name.`,
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
