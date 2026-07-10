/**
 * Pyodide engine — Python in WebAssembly, the default (isolated) sandbox.
 *
 * Runs in the main process via a lazily-loaded singleton. Pyodide's core is
 * bundled in node_modules; science packages (numpy/pandas/matplotlib) are
 * fetched on first use and cached under <dataDir>/pyodide-cache so later runs
 * (and sessions) are offline-friendly. Isolated by construction: the code
 * sees only Pyodide's in-memory /sandbox FS, never the host filesystem.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import {
  MAX_STREAM_CHARS,
  type EngineResult,
  type SandboxFile,
} from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null;
let loading: Promise<unknown> | null = null;

async function getPyodide(): Promise<unknown> {
  if (pyodide) return pyodide;
  if (!loading) {
    const cacheDir = join(getDataDir(), "pyodide-cache");
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    loading = import("pyodide").then(async (m) => {
      pyodide = await m.loadPyodide({ packageCacheDir: cacheDir });
      return pyodide;
    });
  }
  await loading;
  return pyodide;
}

const clip = (s: string): string =>
  s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) + "\n…(truncated)" : s;

export async function runPyodide(code: string): Promise<EngineResult> {
  let py: {
    setStdout: (o: { batched: (s: string) => void }) => void;
    setStderr: (o: { batched: (s: string) => void }) => void;
    runPython: (c: string) => unknown;
    runPythonAsync: (c: string) => Promise<unknown>;
    loadPackagesFromImports: (c: string) => Promise<unknown>;
    FS: { readFile: (p: string) => Uint8Array };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toPy?: (x: unknown) => any;
  };
  try {
    py = (await getPyodide()) as typeof py;
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      files: [],
      error: `Pyodide failed to load: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let out = "";
  let err = "";
  py.setStdout({ batched: (s: string) => (out += s + "\n") });
  py.setStderr({ batched: (s: string) => (err += s + "\n") });

  // Fresh working dir per run so file listing only picks up this run's output.
  py.runPython(
    [
      "import os, shutil",
      "shutil.rmtree('/sandbox', ignore_errors=True)",
      "os.makedirs('/sandbox', exist_ok=True)",
      "os.chdir('/sandbox')",
    ].join("\n"),
  );

  try {
    await py.loadPackagesFromImports(code);
  } catch {
    /* a missing package surfaces as an ImportError when the code runs */
  }

  try {
    await py.runPythonAsync(code);
  } catch (e) {
    err += (e instanceof Error ? e.message : String(e)) + "\n";
  }

  // Collect files written to /sandbox.
  const files: SandboxFile[] = [];
  try {
    const names = py.runPython(
      "import os; [f for f in os.listdir('/sandbox') if os.path.isfile(os.path.join('/sandbox', f))]",
    ) as { toJs: () => string[] };
    for (const name of names.toJs()) {
      try {
        files.push({ name, bytes: py.FS.readFile("/sandbox/" + name) });
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* no files */
  }

  return { ok: err.trim().length === 0, stdout: clip(out), stderr: clip(err), files };
}
