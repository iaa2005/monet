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
import { getSandboxConfig } from "../sandbox/config.js";

// ── Per-engine prompt sections ────────────────────────────────────────────
// The engines differ in capabilities (packages, networking, CLI tools), so
// the model gets a prompt that matches the ACTIVE engine. The tool prompt is
// cached per toolset — sandbox:setConfig resets it on engine change.

const PROMPT_COMMON = [
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
];

const PROMPT_PYODIDE = [
  "Active sandbox engine: PYODIDE — Python 3 in WebAssembly, fully isolated",
  "from the machine.",
  ...PROMPT_COMMON,
  "- numpy/pandas/matplotlib load natively; missing pure-Python packages",
  "  (python-docx, openpyxl, python-pptx, fpdf2, …) install AUTOMATICALLY",
  "  from PyPI on first import — binary document formats (.docx/.xlsx/.pptx)",
  "  fully work here, never claim otherwise. The first use of a package may",
  "  take a moment to download. Packages needing C extensions outside the",
  "  Pyodide distribution won't work.",
  "- There is NO pip CLI and NO subprocess in this sandbox. For an explicit",
  "  install use: import micropip; await micropip.install('name').",
  "- Networking from Python is unreliable here (requests/urllib3 fail).",
  "  For a simple HTTP GET use: from pyodide.http import pyfetch;",
  "  resp = await pyfetch(url); text = await resp.text(). Prefer the",
  "  WebFetch/WebSearch tools for reading the web.",
  "- Content transformation (translation, rewriting, summarising) is YOUR",
  "  job — online translator APIs won't work here. Extract the text, transform",
  "  it yourself, write the new file with the transformed strings in code.",
  "- For PDF generation use fpdf2 or reportlab-free alternatives (pure",
  "  Python); there is no LaTeX here.",
];

const PROMPT_SUBPROCESS = [
  "Active sandbox engine: LOCAL SUBPROCESS — the user's real Python in a",
  "per-chat scratch folder (weak isolation; the user opted in knowingly).",
  ...PROMPT_COMMON,
  "- Missing packages auto-install via pip on first failed import; you can",
  "  also install explicitly (import subprocess, sys;",
  "  subprocess.run([sys.executable, '-m', 'pip', 'install', 'name'])).",
  "- Networking works normally (requests, online APIs).",
  "- Locally installed CLI tools MAY be available (pdflatex, pandoc, git …):",
  "  check first (shutil.which('pdflatex')) and use subprocess.run to invoke",
  "  them. For LaTeX→PDF: write the .tex file, run pdflatex if present,",
  "  otherwise fall back to fpdf2/reportlab and say so.",
];

const PROMPT_PODMAN = [
  "Active sandbox engine: PODMAN CONTAINER — python3 + nodejs + tectonic",
  "(LaTeX) inside an isolated container; the chat folder is mounted at /work.",
  ...PROMPT_COMMON,
  "- pip is available; installs do NOT persist between runs — put needed",
  "  pip installs at the top of the script (the pip cache is shared, so",
  "  repeats are fast).",
  "- For LaTeX→PDF use tectonic: write report.tex, then",
  "  subprocess.run(['tectonic', 'report.tex']) — it fetches missing TeX",
  "  packages automatically.",
  "- Networking is available inside the container.",
];

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
    const engine = getSandboxConfig().engine;
    const specific =
      engine === "subprocess"
        ? PROMPT_SUBPROCESS
        : engine === "docker"
          ? PROMPT_PODMAN
          : PROMPT_PYODIDE;
    return [
      "Execute Python in a sandbox to compute results, analyse data, or",
      "produce documents (charts, .xlsx, .docx, .csv, .pdf …). This is how",
      "you DO things in Home — there is no direct filesystem here.",
      "",
      ...specific,
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
