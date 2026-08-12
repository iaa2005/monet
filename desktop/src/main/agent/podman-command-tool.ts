/**
 * RunCommand — the one way to run a shell command in the sandbox.
 *
 * It used to be three tools: RunCommand, RunCommandBackground and
 * BackgroundOutput, plus Sleep to wait between polls. Four names for one
 * verb, and the model spent turns choosing between them. Now it is a flag,
 * the way every agent CLI worth copying does it: `run_in_background: true`
 * returns immediately with a task id and the path its output is being
 * written to, the completion is announced in the chat on its own, and the
 * interim output is read with the same Read as any other file.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { getSessionEngine } from "../sandbox/config.js";
import { runCommandInSandbox } from "../sandbox/index.js";
import { startBgCommand } from "../sandbox/bg-tasks.js";
import { timeoutFromSeconds } from "../sandbox/types.js";
import { artifactReference } from "../ipc/artifacts.js";
import { tunablePrompt } from "../prompts/index.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe("The shell command to run inside the Podman sandbox."),
    timeout: z
      .number()
      .optional()
      .describe(
        "Seconds to allow before the command is killed (default 300, max 1200). Ignored when run_in_background is set — a background command has no timeout.",
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        "Return immediately instead of waiting. Use it for anything that takes minutes — installs, builds, downloads. You are told in the chat when it finishes; do not wait for it.",
      ),
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
    return tunablePrompt(
      "tool-run-command",
      [
        "Run a shell command inside the isolated Podman sandbox (Debian Linux;",
        "/work is the working directory, shared with RunPython). Pre-installed:",
        "python3 (numpy, pandas, matplotlib, Pillow, fpdf2, python-docx, openpyxl),",
        "node/npm, tectonic (LaTeX), DejaVu/Liberation fonts. pip works; do NOT",
        "apt/conda-install system packages (texlive, imagemagick) — they are",
        "unavailable. Files written to /work are attached to the chat automatically.",
        "\n\nFor anything that takes minutes — an install, a build, a download —",
        "set run_in_background. It returns at once with a task id and the file",
        "its output is being written to, and you are TOLD in this chat when it",
        "finishes. Do not wait for it and do not poll it: get on with something",
        "else, or end your turn. Read the output file only if you need to see",
        "progress before it is done. For a server that never ends, use",
        "ServeSandbox instead.",
      ].join(" "),
    );
  },
  async description() {
    return "Run a command inside the isolated Podman sandbox, in the foreground or detached.";
  },
  async call(
    { command, timeout, run_in_background }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const sessionId = (context as { sessionId?: string }).sessionId || "default";
    if (getSessionEngine(sessionId) !== "docker") {
      return { data: { text: "RunCommand is available only with the Podman sandbox.", isError: true } };
    }
    if (run_in_background) {
      const r = await startBgCommand(sessionId, command);
      if (!r.ok || !r.taskId)
        return { data: { text: r.error ?? "Failed to start.", isError: true } };
      return {
        data: {
          text:
            `Command running in background with ID: ${r.taskId}. Output is ` +
            `being written to: ${r.outputPath}. You will be notified when it ` +
            `completes. To check interim output, use SandboxRead on that file ` +
            `path.`,
        },
      };
    }
    const r = await runCommandInSandbox(
      sessionId,
      command,
      (context as { abortController?: AbortController }).abortController?.signal,
      { timeoutMs: timeoutFromSeconds(timeout) },
    );
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.error) parts.push(`[sandbox error] ${r.error}`);
    if (r.files.length > 0) {
      for (const f of r.files) {
        const markdownPath = artifactReference(f.path);
        parts.push(
          `[artifact] ${f.mediaType} ${f.name} :: ${markdownPath}`,
        );
        parts.push(`Markdown: ![${f.name}](${markdownPath})`);
      }
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
