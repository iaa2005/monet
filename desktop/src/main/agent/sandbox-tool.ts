/**
 * RunPython tool — executes Python in the Home LLM Sandbox.
 *
 * Home is isolated from the real filesystem (unlike Code mode's Bash/PowerShell
 * + FileEdit). This tool runs Python through the configured sandbox engine
 * (Pyodide by default, real subprocess if the user opted in) and returns
 * stdout/stderr. Files the script writes (charts, .docx, .xlsx, .csv…) are
 * saved to the chat's artifacts folder and reported back by name.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { runInSandbox } from "../sandbox/index.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe("The Python source to execute."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface RunOutput {
  text: string;
  isError: boolean;
}

export const RunPythonTool = buildTool({
  name: "RunPython",
  searchHint: "run Python in the isolated Home sandbox",
  maxResultSizeChars: 60_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Run Python";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      "Execute Python in an isolated sandbox to compute results, analyse data,",
      "or produce documents (charts, .xlsx, .docx, .csv, .pdf …). This is how",
      "you DO things in Home — there is no direct filesystem here.",
      "",
      "- Print results you want to report with print().",
      "- To return a file, WRITE it in the current directory (e.g.",
      "  plt.savefig('chart.png'), df.to_csv('data.csv')); saved files are shown",
      "  to the user and attached to the chat automatically.",
      "- Common libraries (numpy, pandas, matplotlib, python-docx, openpyxl) are",
      "  available; the first use may take a moment to load.",
    ].join("\n");
  },
  async description() {
    return "Run Python in the isolated Home sandbox; returns stdout/stderr and saves any files the script writes.";
  },
  async call({ code }: z.infer<InputSchema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    try {
      const r = await runInSandbox(sessionId, code);
      const parts: string[] = [];
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.error) parts.push(`[sandbox error] ${r.error}`);
      if (r.files.length > 0) {
        // A machine-readable line the UI parses to render/attach files, plus a
        // human summary the model can reference.
        for (const f of r.files)
          parts.push(`[sandbox-file] ${f.mediaType} ${f.name} :: ${f.path}`);
        parts.push(
          `Created ${r.files.length} file(s): ${r.files.map((f) => f.name).join(", ")}`,
        );
      }
      if (parts.length === 0) parts.push("(no output)");
      parts.push(`\n— ran via ${r.engine}`);
      return {
        data: { text: parts.join("\n"), isError: !!r.error || !r.ok },
      };
    } catch (err) {
      return {
        data: {
          text: `Sandbox failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam(
    content: RunOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
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
