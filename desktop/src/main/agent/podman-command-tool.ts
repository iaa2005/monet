import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { getSandboxConfig } from "../sandbox/config.js";
import { runCommandInSandbox } from "../sandbox/index.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe("The shell command to run inside the Podman sandbox."),
  }),
);

type InputSchema = ReturnType<typeof inputSchema>;

export const RunCommandTool = buildTool({
  name: "RunCommand",
  searchHint: "run a command inside the Podman sandbox",
  maxResultSizeChars: 60_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Run Command";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Run a shell command inside the isolated Podman sandbox (Debian Linux;",
      "/work is the working directory, shared with RunPython). Pre-installed:",
      "python3 (numpy, pandas, matplotlib, Pillow, fpdf2, python-docx, openpyxl),",
      "node/npm, tectonic (LaTeX), DejaVu/Liberation fonts. pip works; do NOT",
      "apt/conda-install system packages (texlive, imagemagick) — they are",
      "unavailable. Files written to /work are attached to the chat automatically.",
    ].join(" ");
  },
  async description() {
    return "Run a command inside the isolated Podman sandbox.";
  },
  async call({ command }: z.infer<InputSchema>, context: ToolUseContext) {
    if (getSandboxConfig().engine !== "docker") {
      return { data: { text: "RunCommand is available only with the Podman sandbox.", isError: true } };
    }
    const sessionId = (context as { sessionId?: string }).sessionId || "default";
    const r = await runCommandInSandbox(sessionId, command);
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.error) parts.push(`[sandbox error] ${r.error}`);
    if (r.files.length > 0) {
      // Machine-readable lines the UI parses to attach files, plus a human
      // summary — same format RunPython uses so RunCommand files show too.
      for (const f of r.files)
        parts.push(`[sandbox-file] ${f.mediaType} ${f.name} :: ${f.path}`);
      parts.push(
        `Created ${r.files.length} file(s): ${r.files.map((f) => f.name).join(", ")}`,
      );
    }
    if (parts.length === 0) parts.push("(no output)");
    return { data: { text: parts.join("\n"), isError: !!r.error || !r.ok } };
  },
  mapToolResultToToolResultBlockParam(content: { text: string; isError: boolean }, toolUseID: string): ToolResultBlockParam {
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
