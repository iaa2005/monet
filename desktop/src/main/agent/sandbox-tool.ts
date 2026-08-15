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
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import { runInSandbox } from "../sandbox/index.js";
import { timeoutFromSeconds } from "../sandbox/types.js";
import { artifactReference } from "../ipc/artifacts.js";
import { getSandboxConfig, type SandboxEngine } from "../sandbox/config.js";
import { tunablePrompt } from "../prompts/index.js";

// ── Per-engine prompt sections ────────────────────────────────────────────
// The engines differ in capabilities (packages, networking, CLI tools), so
// the model gets a prompt that matches the ACTIVE engine. The tool prompt is
// cached per toolset — sandbox:setConfig resets it on engine change.

const PROMPT_COMMON = [
  "- Print results you want to report with print().",
  "- To produce a file, WRITE it in the current directory (e.g.",
  "  plt.savefig('chart.png'), df.to_csv('data.csv')). Saved files are",
  "  working files: kept and visible to you, NOT shown to the user — hand",
  "  finished results over with DeliverFiles. Do NOT call plt.show().",
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
  "- You cannot run a web server in this chat. If the user wants to SEE an",
  "  .html page, write the file, deliver it with DeliverFiles so they can",
  "  open it, and tell them that switching this chat's sandbox engine to",
  "  Podman lets you serve and view it in the app's browser.",
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
  "- Networking works normally (requests, online APIs) — but do NOT start a",
  "  web server: this engine runs on the user's own machine, so a server here",
  "  would expose their files. Write the .html, deliver it with DeliverFiles,",
  "  and say that the Podman engine can serve it safely in the app's browser.",
  "- Networking works normally (requests, online APIs).",
  "- Locally installed CLI tools MAY be available (pdflatex, pandoc, git …):",
  "  check first (shutil.which('pdflatex')) and use subprocess.run to invoke",
  "  them. For LaTeX→PDF: write the .tex file, run pdflatex if present,",
  "  otherwise fall back to fpdf2/reportlab and say so.",
];

const PROMPT_PODMAN = [
  "Active sandbox engine: PODMAN CONTAINER — an isolated Debian Linux",
  "container; the chat folder is mounted at /work (your working directory).",
  ...PROMPT_COMMON,
  "- PRE-INSTALLED, use directly (do NOT reinstall): Python 3.12 with numpy,",
  "  pandas, matplotlib, Pillow (PIL), fpdf2, python-docx, openpyxl; Node.js +",
  "  npm; `tectonic` (a self-contained XeTeX/LaTeX engine); and the CMU",
  "  (Computer Modern Unicode), DejaVu and Liberation font families — full",
  "  Cyrillic and Latin coverage.",
  // This block used to say installs do NOT persist, and told the model to put
  // `pip install` at the top of every script. Both halves were wrong and the
  // model obeyed them exactly: it ran pip through subprocess from inside
  // RunPython, in the foreground, once per chat. Installs persist and are now
  // shared machine-wide — see PIP_ENV_ARGS.
  "- A missing package is installed ONCE, with RunCommand (`pip install",
  "  yfinance`), and then simply imported here — the install persists and is",
  "  shared with every other chat, so it is very often already there. TRY THE",
  "  IMPORT FIRST. Never run pip from inside this script (no subprocess +",
  "  pip): it holds the turn open for the whole download and installs nothing",
  "  this script has not already loaded. Run that install in the FOREGROUND —",
  "  it takes seconds, and a background one cannot be waited for, so you end",
  "  up installing the same package twice.",
  "- Need a different version from the shared one? `pip install --target",
  "  /work/.pip name==X` — that copy wins in this chat and changes nothing",
  "  anywhere else.",
  "- Do NOT use apt/conda, and do NOT try to install a system TeX",
  "  (texlive/xetex) or ImageMagick — they are unavailable and attempting it",
  "  only wastes turns. Use tectonic for LaTeX and Pillow for image",
  "  manipulation instead.",
  "- You are INSIDE that container. The host's podman/docker CLI is not there",
  "  and never will be — do not try to inspect or manage the sandbox from",
  "  within it; report what you observe instead.",
  "- To SHOW a web page (an .html you wrote, or a dev server): write the file",
  "  here in /work and call the ServeSandbox tool — it publishes this folder",
  "  on a local-only URL from inside the container. Never try to reach the",
  "  user's machine or copy files out to make a page load.",
  "- LaTeX → PDF: write report.tex, then",
  "  subprocess.run(['tectonic', 'report.tex']); tectonic fetches any missing",
  "  TeX packages automatically on first use.",
  "- For NON-ASCII text (Cyrillic, accents, CJK) do NOT use the pdflatex-style",
  "  inputenc / fontenc[T2A] approach — it fails here. tectonic is XeTeX, so",
  "  name an installed family with fontspec. This is THE default block, and",
  "  the only font lines a document normally needs — it is Computer Modern, so",
  "  the text matches the maths tectonic sets anyway:",
  "    \\usepackage{fontspec}",
  "    \\setmainfont{CMU Serif}",
  "    \\setsansfont{CMU Sans Serif}",
  "    \\setmonofont{CMU Typewriter Text}",
  "  For Russian add \\usepackage{polyglossia}\\setmainlanguage{russian} —",
  "  that is hyphenation, not fonts. NEVER write Path=, a directory, or a",
  "  .ttf filename: the family name above is enough and always resolves.",
  "  Deliberately different look, on request only: DejaVu Serif / DejaVu Sans",
  "  / DejaVu Sans Mono, or Liberation Serif / Sans / Mono (Times and Arial",
  "  metrics). A matplotlib figure going INTO such a document matches it with",
  "  matplotlib.rcParams['font.family'] = 'CMU Serif'.",
  "- Networking is available inside the container.",
];

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe("The Python source to execute."),
    timeout: z
      .number()
      .optional()
      .describe(
        "Seconds to allow before the run is killed (default 300, max 1200). Raise it for an install or a download; for anything slower use RunCommand with run_in_background instead of holding the turn open.",
      ),
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
  async prompt(opts?: { sandboxEngine?: SandboxEngine; [key: string]: unknown }) {
    // Per-chat engine (threaded from getVendorApiTools); global default otherwise
    // — the description must match the engine THIS chat actually runs on.
    const engine =
      (opts?.sandboxEngine as SandboxEngine | undefined) ??
      getSandboxConfig().engine;
    const [key, specific] =
      engine === "subprocess"
        ? (["tool-run-python-subprocess", PROMPT_SUBPROCESS] as const)
        : engine === "docker"
          ? (["tool-run-python-podman", PROMPT_PODMAN] as const)
          : (["tool-run-python-pyodide", PROMPT_PYODIDE] as const);
    return [
      tunablePrompt(
        "tool-run-python-intro",
        [
          "Execute Python in a sandbox to compute results, analyse data, or",
          "produce documents (charts, .xlsx, .docx, .csv, .pdf …). This is how",
          "you DO things in Home — there is no direct filesystem here.",
          "Files your code writes are WORKING FILES: you and later runs see",
          "them, the user does not. Work with as many intermediates as you",
          "need (data files, draft renders, .tex sources); when a file is a",
          "finished result, hand it to the user with DeliverFiles.",
        ].join("\n"),
      ),
      "",
      tunablePrompt(key, specific.join("\n")),
    ].join("\n");
  },
  async description() {
    return "Run Python in the isolated Home sandbox; returns stdout/stderr and saves any files the script writes.";
  },
  async call({ code, timeout }: z.infer<InputSchema>, context: ToolUseContext) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    try {
      const r = await runInSandbox(sessionId, code, {
        timeoutMs: timeoutFromSeconds(timeout),
      });
      const parts: string[] = [];
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.error) parts.push(`[sandbox error] ${r.error}`);
      if (r.files.length > 0) {
        // [file] = a working file: reachable, versioned, NOT shown to the
        // user. Delivery is a separate, deliberate act — DeliverFiles.
        for (const f of r.files) {
          const markdownPath = artifactReference(f.path);
          parts.push(
            `[file] ${f.mediaType} ${f.name} :: ${markdownPath}`,
          );
          parts.push(`Markdown: ![${f.name}](${markdownPath})`);
        }
        parts.push(
          `Created ${r.files.length} working file(s): ${r.files.map((f) => f.name).join(", ")} — the user does NOT see them. When a file is a finished result, hand it over with DeliverFiles.`,
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
