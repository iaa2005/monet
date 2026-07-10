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

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
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
    const child = spawn(cmd, args, { cwd, windowsHide: true });
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
  const before = new Set(listFiles(dir));
  const ext = language === "python" ? "py" : "mjs";
  const scriptName = `_run_${Date.now()}.${ext}`;
  writeFileSync(join(dir, scriptName), code, "utf-8");

  let result: Awaited<ReturnType<typeof run>> | null = null;
  if (language === "python") {
    for (const cmd of pythonCandidates()) {
      result = await run(cmd, [scriptName], dir);
      if (!result.spawnError) break; // interpreter found
    }
    if (result?.spawnError) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        files: [],
        error:
          "No Python interpreter found on PATH. Install Python, or switch the Sandbox engine to Pyodide.",
      };
    }
  } else {
    result = await run(process.execPath, [scriptName], dir);
  }

  // New files this run produced.
  const created = listFiles(dir).filter(
    (f) => !before.has(f) && f !== scriptName,
  );
  const files: SandboxFile[] = [];
  for (const name of created) {
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
