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
      "  to the user and attached to the chat automatically. Do NOT call",
      "  plt.show().",
      "- The working directory PERSISTS between runs in this chat: a file you",
      "  saved earlier (e.g. chart.png) is still there — read or embed it",
      "  directly (doc.add_picture('chart.png')), no need to regenerate it.",
      "- To DISPLAY a generated image in your written reply, embed it as markdown",
      "  using the exact filename you saved: ![short description](chart.png).",
      "  The app resolves that filename to the real image — never invent a URL or",
      "  a data URI.",
      "- numpy/pandas/matplotlib load natively; missing pure-Python packages",
      "  (python-docx, openpyxl, python-pptx, deep-translator, …) install",
      "  AUTOMATICALLY from PyPI on first import — binary document formats",
      "  (.docx/.xlsx/.pptx/.pdf) fully work here, never claim otherwise. The",
      "  first use of a package may take a moment to download.",
      "- There is NO pip CLI and NO subprocess in this sandbox. For an explicit",
      "  install use: import micropip; await micropip.install('name').",
      "- Networking from Python is unreliable here (requests/urllib3 can fail).",
      "  For a simple HTTP GET use: from pyodide.http import pyfetch;",
      "  resp = await pyfetch(url); text = await resp.text(). Prefer the",
      "  WebFetch/WebSearch tools for reading the web.",
      "- Content transformation (translation, rewriting, summarising) is YOUR",
      "  job — never call online translator APIs (GoogleTranslator etc.).",
      "  Workflow: extract the text with RunPython (print it), transform it",
      "  yourself, then write the new file with the transformed strings",
      "  embedded in the code.",
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
