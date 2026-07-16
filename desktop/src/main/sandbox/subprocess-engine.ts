/**
 * Subprocess engine — real python/node in a per-session temp folder.
 *
 * OPT-IN and explicitly NOT hard-isolated: code runs on the user's machine.
 * The Settings UI warns about this. We isolate only by cwd (a scratch folder
 * under <dataDir>/sandboxes/<sessionId>) and a wall-clock timeout.
 */

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import {
  MAX_STREAM_CHARS,
  SANDBOX_TIMEOUT_MS,
  type EngineResult,
  type SandboxFile,
} from "./types.js";

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const dir = join(getDataSubdir("sandboxes"), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** name → `${size}:${mtimeMs}` for every regular file in dir.
 * (Also used by the Podman engine — both work in the same host folder.) */
export function snapshotFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f));
        if (st.isFile()) map.set(f, `${st.size}:${st.mtimeMs}`);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* empty */
  }
  return map;
}

/** First working interpreter from the candidates, else null. */
function pythonCandidates(): string[] {
  return process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      // Force UTF-8 pipes: on Russian Windows, Python defaults piped stdout
      // to cp1251 while we decode UTF-8 — Cyrillic became mojibake dots.
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    const timer = setTimeout(() => {
      if (!done) {
        stderr += `\n[sandbox] killed after ${SANDBOX_TIMEOUT_MS / 1000}s`;
        child.kill();
      }
    }, SANDBOX_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_STREAM_CHARS) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STREAM_CHARS) stderr += d.toString();
    });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: e.message });
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runSubprocess(
  sessionId: string,
  language: "python" | "javascript",
  code: string,
): Promise<EngineResult> {
  const dir = sessionDir(sessionId);
  const before = snapshotFiles(dir);
  const ext = language === "python" ? "py" : "mjs";
  const scriptName = `_run_${Date.now()}.${ext}`;
  writeFileSync(join(dir, scriptName), code, "utf-8");

  let result: Awaited<ReturnType<typeof run>> | null = null;
  if (language === "python") {
    let python: string | null = null;
    for (const cmd of pythonCandidates()) {
      result = await run(cmd, [scriptName], dir);
      if (!result.spawnError) {
        python = cmd;
        break; // interpreter found
      }
    }
    if (result?.spawnError || !python) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        files: [],
        error:
          "No Python interpreter found on PATH. Install Python, or switch the Sandbox engine to Pyodide.",
      };
    }
    // Auto-install missing packages (same UX as the Pyodide engine): catch
    // ModuleNotFoundError, `python -m pip install` the mapped name, retry.
    const PIP_NAME: Record<string, string> = {
      docx: "python-docx",
      pptx: "python-pptx",
      PIL: "pillow",
      cv2: "opencv-python",
      sklearn: "scikit-learn",
      bs4: "beautifulsoup4",
      yaml: "pyyaml",
      dateutil: "python-dateutil",
      fitz: "pymupdf",
      Crypto: "pycryptodome",
    };
    const tried = new Set<string>();
    while (result && result.code !== 0 && tried.size < 3) {
      const m = /ModuleNotFoundError: No module named ['"]([A-Za-z0-9_.]+)['"]/.exec(
        result.stderr,
      );
      const mod = m?.[1]?.split(".")[0];
      if (!mod || tried.has(mod)) break;
      tried.add(mod);
      const pipName = PIP_NAME[mod] ?? mod;
      const install = await run(
        python,
        ["-m", "pip", "install", "--quiet", pipName],
        dir,
      );
      if (install.code !== 0) {
        result.stderr += `\n[sandbox] auto-install of ${pipName} failed:\n${install.stderr.slice(-400)}`;
        break;
      }
      result = await run(python, [scriptName], dir);
      result.stdout = `[sandbox] installed ${pipName} via pip\n` + result.stdout;
    }
  } else {
    result = await run(process.execPath, [scriptName], dir);
  }

  // Files this run created OR modified (the working dir persists per chat).
  const after = snapshotFiles(dir);
  const files: SandboxFile[] = [];
  for (const [name, sig] of after) {
    if (name === scriptName || name.startsWith("_run_")) continue;
    if (before.get(name) === sig) continue;
    try {
      files.push({ name, bytes: readFileSync(join(dir, name)) });
    } catch {
      /* skip */
    }
  }

  const r = result!;
  return {
    ok: r.code === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    files,
  };
}

/**
 * Run a raw shell command in the chat's sandbox folder (the Home terminal for
 * the subprocess engine). Weak isolation only — cwd is the per-chat folder and
 * a wall-clock timeout applies, but the command runs on the host with the
 * user's PATH. Files it writes into the folder are surfaced like other runs.
 */
export async function runSubprocessCommand(
  sessionId: string,
  command: string,
): Promise<EngineResult> {
  const dir = sessionDir(sessionId);
  const before = snapshotFiles(dir);
  const isWin = process.platform === "win32";
  const cmd = isWin ? "powershell.exe" : "sh";
  const args = isWin
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
      ]
    : ["-c", command];
  const result = await run(cmd, args, dir);

  const after = snapshotFiles(dir);
  const files: SandboxFile[] = [];
  for (const [name, sig] of after) {
    if (before.get(name) === sig) continue;
    try {
      files.push({ name, bytes: readFileSync(join(dir, name)) });
    } catch {
      /* skip */
    }
  }

  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    files,
    error: result.spawnError,
  };
}
