/**
 * Pyodide sandbox worker — runs Python OFF the main process thread.
 *
 * Heavy computations used to freeze the whole app (Pyodide executed on the
 * Electron main thread). This worker owns the Pyodide instance; the engine
 * proxy (pyodide-engine.ts) talks to it over messages. Deliberately free of
 * electron imports so it can run (and be tested) under plain Node.
 *
 * Protocol:
 *   in : { type:"run", id, code, memDir, artifactsDir, cacheDir }
 *        { type:"mirror", memDir, name, bytes: ArrayBuffer }
 *   out: { type:"result", id, ok, stdout, stderr, error?,
 *          files: { name, bytes: ArrayBuffer }[] }   (bytes transferred)
 */

import { parentPort } from "worker_threads";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const MAX_STREAM_CHARS = 60_000;

interface RunMsg {
  type: "run";
  id: number;
  code: string;
  /** In-memory working dir for the chat (e.g. /sessions/<id>). */
  memDir: string;
  /** Host dir with the chat's saved artifacts (for re-seeding). */
  artifactsDir: string;
  /** Host dir for the Pyodide package cache. */
  cacheDir: string;
}

interface MirrorMsg {
  type: "mirror";
  memDir: string;
  name: string;
  bytes: ArrayBuffer;
}

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
let loading: Promise<Py> | null = null;

async function getPy(cacheDir: string): Promise<Py> {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = import("pyodide").then(async (m) => {
      pyodide = (await m.loadPyodide({
        packageCacheDir: cacheDir,
      })) as unknown as Py;
      return pyodide;
    });
  }
  return loading;
}

const clip = (s: string): string =>
  s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) + "\n…(truncated)" : s;

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

function seedFromArtifacts(py: Py, artifactsDir: string, memDir: string): void {
  try {
    const newest = new Map<string, { ts: number; full: string }>();
    for (const f of readdirSync(artifactsDir)) {
      const m = /^(\d+)-(.+)$/.exec(f);
      const name = m ? m[2] : f;
      const ts = m ? Number(m[1]) : 0;
      const cur = newest.get(name);
      if (!cur || ts > cur.ts)
        newest.set(name, { ts, full: join(artifactsDir, f) });
    }
    for (const [name, { full }] of newest) {
      const target = `${memDir}/${name}`;
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

async function run(msg: RunMsg): Promise<void> {
  let py: Py;
  try {
    py = await getPy(msg.cacheDir);
  } catch (err) {
    parentPort!.postMessage({
      type: "result",
      id: msg.id,
      ok: false,
      stdout: "",
      stderr: "",
      files: [],
      error: `Pyodide failed to load: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  let out = "";
  let errText = "";
  py.setStdout({ batched: (s: string) => (out += s + "\n") });
  py.setStderr({ batched: (s: string) => (errText += s + "\n") });

  py.runPython(
    [
      "import os",
      `os.makedirs(${JSON.stringify(msg.memDir)}, exist_ok=True)`,
      `os.chdir(${JSON.stringify(msg.memDir)})`,
      "os.environ.setdefault('MPLBACKEND', 'Agg')",
    ].join("\n"),
  );
  seedFromArtifacts(py, msg.artifactsDir, msg.memDir);

  const before = snapshotDir(py, msg.memDir);

  try {
    await py.loadPackagesFromImports(msg.code);
  } catch {
    /* a missing package surfaces as an ImportError when the code runs */
  }
  try {
    await py.runPythonAsync(msg.code);
  } catch (e) {
    errText += (e instanceof Error ? e.message : String(e)) + "\n";
  }

  const after = snapshotDir(py, msg.memDir);
  const files: { name: string; bytes: ArrayBuffer }[] = [];
  const transfers: ArrayBuffer[] = [];
  for (const [name, sig] of after) {
    if (before.get(name) === sig) continue;
    try {
      const copy = py.FS.readFile(`${msg.memDir}/${name}`).slice();
      files.push({ name, bytes: copy.buffer as ArrayBuffer });
      transfers.push(copy.buffer as ArrayBuffer);
    } catch {
      /* skip unreadable */
    }
  }

  parentPort!.postMessage(
    {
      type: "result",
      id: msg.id,
      ok: errText.trim().length === 0,
      stdout: clip(out),
      stderr: clip(errText),
      files,
    },
    transfers,
  );
}

parentPort!.on("message", (msg: RunMsg | MirrorMsg) => {
  if (msg.type === "mirror") {
    if (!pyodide) return; // cold worker: the seeder will pick it up from disk
    try {
      pyodide.runPython(
        `import os; os.makedirs(${JSON.stringify(msg.memDir)}, exist_ok=True)`,
      );
      pyodide.FS.writeFile(`${msg.memDir}/${msg.name}`, new Uint8Array(msg.bytes));
    } catch {
      /* best-effort */
    }
    return;
  }
  void run(msg);
});
