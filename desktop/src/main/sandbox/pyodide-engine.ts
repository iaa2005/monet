/**
 * Pyodide engine — Python in WebAssembly, the default (isolated) sandbox.
 *
 * Runs in the main process via a lazily-loaded singleton. Pyodide's core is
 * bundled in node_modules; science packages (numpy/pandas/matplotlib) are
 * fetched on first use and cached under <dataDir>/pyodide-cache so later runs
 * (and sessions) are offline-friendly. Isolated by construction: the code
 * sees only Pyodide's in-memory FS, never the host filesystem.
 *
 * FILES PERSIST PER CHAT: each session works in /sessions/<id>, which is kept
 * between runs (so a chart from run 1 can be embedded into a .docx in run 2)
 * and re-seeded from the chat's on-disk artifacts after an app restart.
 * Results are detected by diffing the dir before/after the run.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { artifactSessionDir } from "../ipc/artifacts.js";
import {
  MAX_STREAM_CHARS,
  type EngineResult,
  type SandboxFile,
} from "./types.js";

interface PyFS {
  readdir: (p: string) => string[];
  stat: (p: string) => { mode: number; size: number; mtime: Date | number };
  isFile: (mode: number) => boolean;
  readFile: (p: string) => Uint8Array;
  writeFile: (p: string, data: Uint8Array) => void;
}

interface Py {
  setStdout: (o: { batched: (s: string) => void }) => void;
  setStderr: (o: { batched: (s: string) => void }) => void;
  runPython: (c: string) => unknown;
  runPythonAsync: (c: string) => Promise<unknown>;
  loadPackagesFromImports: (c: string) => Promise<unknown>;
  FS: PyFS;
}

let pyodide: Py | null = null;
let loading: Promise<unknown> | null = null;

async function getPyodide(): Promise<Py> {
  if (pyodide) return pyodide;
  if (!loading) {
    const cacheDir = join(getDataDir(), "pyodide-cache");
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    loading = import("pyodide").then(async (m) => {
      pyodide = (await m.loadPyodide({
        packageCacheDir: cacheDir,
      })) as unknown as Py;
      return pyodide;
    });
  }
  await loading;
  return pyodide!;
}

const clip = (s: string): string =>
  s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) + "\n…(truncated)" : s;

function sessionDirFor(sessionId: string): string {
  return "/sessions/" + (sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session");
}

/** name → `${size}:${mtimeMs}` for every regular file in dir. */
function snapshotDir(py: Py, dir: string): Map<string, string> {
  const map = new Map<string, string>();
  let names: string[] = [];
  try {
    names = py.FS.readdir(dir);
  } catch {
    return map;
  }
  for (const n of names) {
    if (n === "." || n === "..") continue;
    try {
      const st = py.FS.stat(`${dir}/${n}`);
      if (py.FS.isFile(st.mode))
        map.set(n, `${st.size}:${Number(new Date(st.mtime as Date))}`);
    } catch {
      /* skip */
    }
  }
  return map;
}

/** After a restart the in-memory FS is empty — reload the chat's artifacts
 * (newest per original name; the on-disk copies are "<timestamp>-<name>"). */
function seedFromArtifacts(py: Py, sessionId: string, dir: string): void {
  try {
    const host = artifactSessionDir(sessionId);
    const newest = new Map<string, { ts: number; full: string }>();
    for (const f of readdirSync(host)) {
      const m = /^(\d+)-(.+)$/.exec(f);
      const name = m ? m[2] : f;
      const ts = m ? Number(m[1]) : 0;
      const cur = newest.get(name);
      if (!cur || ts > cur.ts) newest.set(name, { ts, full: join(host, f) });
    }
    for (const [name, { full }] of newest) {
      const target = `${dir}/${name}`;
      let exists = true;
      try {
        py.FS.stat(target);
      } catch {
        exists = false;
      }
      if (exists) continue;
      if (statSync(full).size > 30 * 1024 * 1024) continue;
      py.FS.writeFile(target, readFileSync(full));
    }
  } catch {
    /* best-effort */
  }
}

/** Push a file into the LIVE Pyodide session dir (no-op when Pyodide isn't
 * loaded yet — the seeder will pick the file up from disk on first run). */
export function mirrorToPyodideSession(
  sessionId: string,
  name: string,
  bytes: Uint8Array,
): void {
  if (!pyodide) return;
  try {
    const dir = sessionDirFor(sessionId);
    pyodide.runPython(
      `import os; os.makedirs(${JSON.stringify(dir)}, exist_ok=True)`,
    );
    pyodide.FS.writeFile(`${dir}/${name}`, bytes);
  } catch {
    /* best-effort */
  }
}

export async function runPyodide(
  sessionId: string,
  code: string,
): Promise<EngineResult> {
  let py: Py;
  try {
    py = await getPyodide();
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

  const dir = sessionDirFor(sessionId);
  // Persistent per-chat working dir (NO wipe between runs) + a headless
  // matplotlib backend (plt.show() in the default backend wants `window`).
  py.runPython(
    [
      "import os",
      `os.makedirs(${JSON.stringify(dir)}, exist_ok=True)`,
      `os.chdir(${JSON.stringify(dir)})`,
      "os.environ.setdefault('MPLBACKEND', 'Agg')",
    ].join("\n"),
  );
  seedFromArtifacts(py, sessionId, dir);

  const before = snapshotDir(py, dir);

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

  // Report files this run CREATED or MODIFIED (older ones were already
  // reported by the runs that made them).
  const after = snapshotDir(py, dir);
  const files: SandboxFile[] = [];
  for (const [name, sig] of after) {
    if (before.get(name) === sig) continue;
    try {
      files.push({ name, bytes: py.FS.readFile(`${dir}/${name}`) });
    } catch {
      /* skip unreadable */
    }
  }

  return { ok: err.trim().length === 0, stdout: clip(out), stderr: clip(err), files };
}
